"""sbc setup：图标生成、skill 拷贝、Agent 入口文案。"""

import importlib.machinery
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_sbc():
    path = ROOT / "cli" / "sbc"
    loader = importlib.machinery.SourceFileLoader("sbc", str(path))
    spec = importlib.util.spec_from_loader("sbc", loader)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_ensure_icons_writes_pngs(tmp_path: Path):
    sbc = load_sbc()
    out = sbc.ensure_icons(tmp_path / "icons")
    for size in (16, 48, 128):
        p = out / f"icon{size}.png"
        assert p.is_file() and p.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_install_skills_copies_skill_and_config(tmp_path: Path):
    sbc = load_sbc()
    dests = sbc.default_skill_dirs(tmp_path)
    written = sbc.install_skills(
        ROOT / "skill" / "SKILL.md",
        dests,
        {"root": str(ROOT), "bridge": "http://127.0.0.1:19527"},
    )
    assert len(written) == 4
    for dest in dests:
        text = (dest / "SKILL.md").read_text(encoding="utf-8")
        assert text.startswith("---")
        assert "sbc setup" in text
        cfg = json.loads((dest / "config.json").read_text(encoding="utf-8"))
        assert cfg["root"] == str(ROOT)


def test_agents_md_tells_any_agent_to_run_setup():
    text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "python3 cli/sbc setup" in text
    assert r"python cli\sbc setup" in text
    assert "extensionDir" in text
