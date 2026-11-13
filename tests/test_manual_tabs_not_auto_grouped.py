from pathlib import Path


BACKGROUND = Path(__file__).parents[1] / "extension" / "background.js"


def test_manual_tabs_are_not_auto_grouped_by_global_tab_listeners():
    source = BACKGROUND.read_text()

    # 只认领从已拥有任务标签开出来的页。没有 opener 的用户新标签不进组。
    assert "chrome.tabs.onCreated.addListener" in source
    assert "async function noteSpawnedTab" in source
    assert "tab.openerTabId == null" in source
    assert "chrome.tabs.onUpdated.addListener" not in source
    assert "await groupTabIfNeeded(tab.id);" in source
