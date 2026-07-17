"""Static checks for task-state persistence, tab reuse, and focus safety."""

from pathlib import Path

BACKGROUND = Path(__file__).parents[1] / "extension" / "background.js"
CLI = Path(__file__).parents[1] / "cli" / "sbc"


def test_default_title_is_agent_task_not_claude():
    source = BACKGROUND.read_text()
    cli = CLI.read_text()
    assert "DEFAULT_TASK_TITLE = 'Agent Task'" in source or 'DEFAULT_TASK_TITLE = "Agent Task"' in source
    # 运行时默认名不得再是 Claude Task（注释里可提旧名）
    assert "taskTitle: 'Claude Task'" not in source
    assert 'taskTitle: "Claude Task"' not in source
    assert 'DEFAULT_TASK_TITLE = "Agent Task"' in cli
    assert 'default="Claude Task"' not in cli


def test_task_state_is_persisted_across_sw_restart():
    source = BACKGROUND.read_text()
    assert "STATE_STORAGE_KEY" in source
    assert "persistTaskState" in source
    assert "loadPersistedTaskState" in source
    assert "reconcileTaskState" in source
    assert "ensureStateReady" in source
    assert "chrome.storage.session" in source


def test_start_task_does_not_always_create_blank_tab():
    source = BACKGROUND.read_text()
    # seedBlank 门控，默认 deferred
    assert "params.seedBlank === true" in source
    assert "deferredTab" in source
    # 复用路径存在
    assert "reused" in source


def test_new_tab_single_tab_by_default():
    source = BACKGROUND.read_text()
    assert "同任务默认永远单标签" in source or "singleTab: true" in source
    assert "reused: true" in source
    assert "params.force === true" in source or "forceNew" in source
    # 默认路径不应再只限空白才复用
    assert "isBlankTabUrl(existingUrl)" not in source


def test_screenshot_prefers_cdp_debugger_no_tab_switch():
    source = BACKGROUND.read_text()
    assert "screenshotViaDebugger" in source
    assert "Page.captureScreenshot" in source
    assert "method = 'debugger'" in source or 'method = "debugger"' in source
    # fallback 仍保留 restore，防止 CDP 失败时抢工作区
    assert "previousActiveId" in source
    assert "restoredActiveTabId" in source
    assert "await chrome.tabs.update(previousActiveId, { active: true })" in source


def test_task_window_isolation_helpers_exist():
    source = BACKGROUND.read_text()
    cli = CLI.read_text()
    assert "taskWindowId" in source
    assert "preferTaskWindow" in source
    assert "ensureAgentWindow" in source
    assert "createTabInTaskContext" in source
    assert "wantsTaskWindow" in source
    assert "focused: false" in source
    # CLI：start-task 默认独立窗；--same-window 可关
    assert '"--window"' in cli or "'--window'" in cli
    assert "--same-window" in cli
    assert 'params["window"] = True' in cli


def test_resolve_tab_does_not_fall_back_to_user_tab_when_task_active():
    source = BACKGROUND.read_text()
    assert "task active but no claimed tab" in source


def test_manual_tabs_still_not_auto_grouped():
    source = BACKGROUND.read_text()
    assert "chrome.tabs.onCreated.addListener" not in source
    assert "chrome.tabs.onUpdated.addListener" not in source


def test_ensure_task_group_does_not_adopt_user_groups():
    source = BACKGROUND.read_text()
    assert "禁止「收养并改名」整个用户分组" in source
    # 新建组必须带 windowId，否则会把独立窗标签拽回用户当前窗
    assert "createProperties" in source
    assert "windowId: tab.windowId" in source


def test_close_tab_command_exists():
    source = BACKGROUND.read_text()
    cli = CLI.read_text()
    assert "async function closeTab" in source
    assert "case 'closeTab'" in source
    assert "close-tab" in cli
