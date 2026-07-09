#!/usr/bin/env python3
"""stable-chrome local bridge server (stdlib only).

CLI/Agent posts commands to HTTP API; Chrome extension long-polls and returns results.
This inverts native-messaging direction so agents can initiate control without CDP 9222.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

HOST = os.getenv("STABLE_CHROME_HOST", "127.0.0.1")
PORT = int(os.getenv("STABLE_CHROME_PORT", "19527"))
EXT_ONLINE_TTL_MS = int(os.getenv("STABLE_CHROME_EXT_TTL_MS", "32000"))
DEFAULT_TIMEOUT_MS = int(os.getenv("STABLE_CHROME_CMD_TIMEOUT_MS", "20000"))
LOG_DIR = Path(os.getenv("STABLE_CHROME_LOG_DIR", str(Path(__file__).resolve().parent.parent / "logs")))
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "bridge.log"

_lock = threading.RLock()
_cmd_queue: "queue.Queue[dict]" = queue.Queue()
_pending: Dict[str, dict] = {}  # id -> {event, result, error, createdAt, type}
_extension = {
    "lastSeenMs": 0,
    "extensionId": None,
    "version": None,
    "helloCount": 0,
}
_stats = {
    "cmds": 0,
    "ok": 0,
    "err": 0,
    "startedAt": time.time(),
}


def log(msg: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def now_ms() -> int:
    return int(time.time() * 1000)


def extension_online() -> bool:
    with _lock:
        last = int(_extension.get("lastSeenMs") or 0)
    return last > 0 and (now_ms() - last) <= EXT_ONLINE_TTL_MS


def touch_extension(meta: Optional[dict] = None) -> None:
    with _lock:
        _extension["lastSeenMs"] = now_ms()
        if meta:
            if meta.get("extensionId"):
                _extension["extensionId"] = meta["extensionId"]
            if meta.get("version"):
                _extension["version"] = meta["version"]


def make_cmd(cmd_type: str, params: Optional[dict], timeout_ms: int) -> dict:
    cmd_id = f"cmd_{uuid.uuid4().hex[:12]}"
    item = {
        "id": cmd_id,
        "type": cmd_type,
        "params": params or {},
        "timeoutMs": timeout_ms,
        "createdAt": now_ms(),
        "event": threading.Event(),
        "result": None,
        "error": None,
        "done": False,
    }
    with _lock:
        _pending[cmd_id] = item
        _stats["cmds"] += 1
    _cmd_queue.put({"id": cmd_id, "type": cmd_type, "params": params or {}, "timeoutMs": timeout_ms})
    return item


def wait_cmd(item: dict, timeout_ms: int) -> dict:
    ok = item["event"].wait(timeout=timeout_ms / 1000.0)
    with _lock:
        if not ok and not item["done"]:
            item["done"] = True
            item["error"] = f"timeout after {timeout_ms}ms waiting for extension"
            _stats["err"] += 1
            # drop from queue if still sitting there is hard; extension will ignore unknown ids
        result = {
            "ok": item["error"] is None,
            "id": item["id"],
            "type": item["type"],
        }
        if item["error"] is None:
            result["result"] = item["result"]
            _stats["ok"] += 1
        else:
            result["error"] = item["error"]
        # cleanup old
        _pending.pop(item["id"], None)
    return result


def complete_cmd(cmd_id: str, ok: bool, result: Any = None, error: Optional[str] = None) -> bool:
    with _lock:
        item = _pending.get(cmd_id)
        if not item:
            return False
        if item["done"]:
            return True
        item["done"] = True
        if ok:
            item["result"] = result
            item["error"] = None
        else:
            item["error"] = error or "unknown error"
            item["result"] = None
        item["event"].set()
        return True


def doctor_payload() -> dict:
    online = extension_online()
    with _lock:
        ext = dict(_extension)
        stats = dict(_stats)
        pending = len(_pending)
        qsize = _cmd_queue.qsize()
    return {
        "ok": True,
        "bridge": {
            "host": HOST,
            "port": PORT,
            "uptimeSec": int(time.time() - stats["startedAt"]),
            "pendingCmds": pending,
            "queueSize": qsize,
            "stats": stats,
        },
        "extension": {
            "online": online,
            "lastSeenMs": ext.get("lastSeenMs") or 0,
            "ageMs": (now_ms() - int(ext.get("lastSeenMs") or 0)) if ext.get("lastSeenMs") else None,
            "extensionId": ext.get("extensionId"),
            "version": ext.get("version"),
            "helloCount": ext.get("helloCount") or 0,
        },
        "hints": _doctor_hints(online, ext),
    }


def _doctor_hints(online: bool, ext: dict) -> list:
    hints = []
    if not online:
        hints.append("扩展离线：请确认已在 Chrome 加载 extension/，并保持至少一个 Chrome 窗口打开。")
        hints.append("打开扩展 service worker 控制台，确认在轮询 http://127.0.0.1:19527/ext/poll。")
        hints.append("执行: ./scripts/doctor.sh")
    else:
        hints.append("扩展在线，可执行 sbc open-tabs / sbc start-task。")
    if not ext.get("extensionId"):
        hints.append("尚未收到 extensionId；扩展 hello 后会自动上报。")
    return hints


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        log(f"HTTP {self.address_string()} {fmt % args}")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as e:
            raise ValueError(f"invalid json: {e}") from e

    def _send(self, code: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(200, {"ok": True})

    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)

            if path == "/health":
                self._send(
                    200,
                    {
                        "ok": True,
                        "bridge": True,
                        "extensionOnline": extension_online(),
                        "lastSeenMs": _extension.get("lastSeenMs") or 0,
                    },
                )
                return

            if path == "/doctor":
                self._send(200, doctor_payload())
                return

            if path == "/ext/poll":
                touch_extension()
                wait_ms = int((qs.get("waitMs") or ["25000"])[0])
                wait_ms = max(0, min(wait_ms, 30000))
                try:
                    cmd = _cmd_queue.get(timeout=wait_ms / 1000.0 if wait_ms else 0.001)
                    touch_extension()
                    self._send(200, {"ok": True, "cmd": cmd})
                except queue.Empty:
                    touch_extension()
                    self._send(200, {"ok": True, "cmd": None})
                return

            self._send(404, {"ok": False, "error": f"unknown path {path}"})
        except Exception as e:
            log(f"GET error: {e}\n{traceback.format_exc()}")
            self._send(500, {"ok": False, "error": str(e)})

    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            body = self._read_json()

            if path == "/ext/hello":
                with _lock:
                    _extension["helloCount"] = int(_extension.get("helloCount") or 0) + 1
                touch_extension(body)
                log(f"extension hello id={body.get('extensionId')} ver={body.get('version')}")
                self._send(
                    200,
                    {
                        "ok": True,
                        "pollUrl": f"http://{HOST}:{PORT}/ext/poll",
                        "resultUrl": f"http://{HOST}:{PORT}/ext/result",
                    },
                )
                return

            if path == "/ext/result":
                touch_extension()
                cmd_id = body.get("id")
                if not cmd_id:
                    self._send(400, {"ok": False, "error": "missing id"})
                    return
                ok = bool(body.get("ok"))
                complete_cmd(cmd_id, ok=ok, result=body.get("result"), error=body.get("error"))
                self._send(200, {"ok": True})
                return

            if path == "/cmd":
                cmd_type = body.get("type")
                if not cmd_type:
                    self._send(400, {"ok": False, "error": "missing type"})
                    return
                if not extension_online():
                    self._send(
                        503,
                        {
                            "ok": False,
                            "error": "extension offline: load extension/ in Chrome and keep a window open",
                            "doctor": doctor_payload(),
                        },
                    )
                    return
                timeout_ms = int(body.get("timeoutMs") or DEFAULT_TIMEOUT_MS)
                timeout_ms = max(1000, min(timeout_ms, 120000))
                params = body.get("params") if isinstance(body.get("params"), dict) else {}
                # allow top-level fields as params convenience
                for k, v in body.items():
                    if k not in ("type", "timeoutMs", "params") and k not in params:
                        params[k] = v
                item = make_cmd(str(cmd_type), params, timeout_ms)
                log(f"cmd queued {item['id']} type={cmd_type}")
                result = wait_cmd(item, timeout_ms)
                code = 200 if result.get("ok") else 504 if "timeout" in str(result.get("error") or "") else 400
                self._send(code, result)
                return

            self._send(404, {"ok": False, "error": f"unknown path {path}"})
        except Exception as e:
            log(f"POST error: {e}\n{traceback.format_exc()}")
            self._send(500, {"ok": False, "error": str(e)})


def main() -> int:
    parser = argparse.ArgumentParser(description="stable-chrome bridge server")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log(f"stable-chrome bridge listening on http://{args.host}:{args.port}")
    log("waiting for Chrome extension to poll /ext/poll ...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
