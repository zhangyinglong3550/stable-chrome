"""Static checks for poll-loop liveness.

踩过的坑：pollLoop 用布尔量防重入，但 loop 一旦卡在永不返回的 await 里，
这个布尔量就永远是 true，alarm 里的 `if (!_pollRunning)` 恒不成立，
保活机制被自己的防重入锁挡住 —— 表现为扩展心跳正常、doctor 显示在线，
但所有命令超时，queueSize 持续增长。
"""

from pathlib import Path

BACKGROUND = Path(__file__).parents[1] / "extension" / "background.js"


def test_poll_loop_has_stall_watchdog():
    source = BACKGROUND.read_text()
    assert "POLL_STALL_MS" in source
    # 停滞判定必须比一次长轮询长，否则正常长轮询会被误判成卡死
    assert "POLL_WAIT_MS = 25000" in source
    assert "POLL_STALL_MS = 60000" in source
    assert "Date.now() - _pollTick < POLL_STALL_MS" in source


def test_poll_loop_uses_generation_to_avoid_double_loops():
    source = BACKGROUND.read_text()
    assert "_pollGen" in source
    assert "const gen = ++_pollGen;" in source
    # 旧 loop 恢复后要能发现自己已被取代
    assert "while (!state.pollAbort && gen === _pollGen)" in source
    assert "if (gen === _pollGen) _pollRunning = false;" in source


def test_alarm_revives_unconditionally():
    """alarm 不能再靠布尔量判断是否需要重启。"""
    source = BACKGROUND.read_text()
    idx = source.index("chrome.alarms.onAlarm.addListener")
    # 取监听器注册之后的一段窗口即可（避免被内部的 `});` 提前截断）
    window = source[idx : idx + 700]
    assert "pollLoop();" in window
    # 真实代码里不能再有这道守卫（注释里提到历史写法是允许的）
    code_lines = [
        ln for ln in window.splitlines() if not ln.strip().startswith("//")
    ]
    assert not any("if (!_pollRunning)" in ln for ln in code_lines)


def test_bridge_fetch_has_timeout():
    """没有超时的长轮询是卡死的源头。"""
    source = BACKGROUND.read_text()
    assert "const { timeoutMs = POLL_WAIT_MS + 10000, ...fetchOptions } = options;" in source
    assert "new AbortController()" in source
    assert "clearTimeout(timer)" in source


def test_poll_tick_is_updated_each_iteration():
    source = BACKGROUND.read_text()
    body = source.split("async function pollLoop()", 1)[1].split("\n}", 1)[0]
    # 每轮开始就要打点，否则停滞判定拿不到新鲜时间
    assert body.count("_pollTick = Date.now();") >= 2
