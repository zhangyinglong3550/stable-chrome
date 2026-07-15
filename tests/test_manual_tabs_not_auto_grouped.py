from pathlib import Path


BACKGROUND = Path(__file__).parents[1] / "extension" / "background.js"


def test_manual_tabs_are_not_auto_grouped_by_global_tab_listeners():
    source = BACKGROUND.read_text()

    assert "chrome.tabs.onCreated.addListener" not in source
    assert "chrome.tabs.onUpdated.addListener" not in source
    assert "await groupTabIfNeeded(tab.id);" in source
