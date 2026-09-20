"""Static checks for the optional decision layer.

决策层是「可选加速器」而不是依赖：没有 TYPESAFE_API_KEY 时 decide 必须优雅降级，
把本该喂给决策器的编号表交回给调用方自己的 LLM，而不是报错退出。
"""

import re
from pathlib import Path

CLI = Path(__file__).parents[1] / "cli" / "sbc"
BACKGROUND = Path(__file__).parents[1] / "extension" / "background.js"


def test_decide_command_exists():
    cli = CLI.read_text()
    assert 'sub.add_parser(\n        "decide"' in cli or '"decide"' in cli
    assert "def cmd_decide(args: argparse.Namespace) -> int:" in cli
    assert '"--goal"' in cli
    assert '"--allow"' in cli


def test_decider_is_optional_not_required():
    """决策器不可用时不能报错退出，要把编号表交回调用方。"""
    cli = CLI.read_text()
    assert '"decider": None' in cli
    assert "key_missing" in cli
    assert "DECISION_HINT" in cli
    # 降级路径也要给出可执行的下一步
    assert "sbc click --node" in cli
    assert "sbc fill --node" in cli


def test_choice_cardinality_is_capped():
    """JEV 的 Choice 基数上限是 255，超过要走两阶段打分，这里必须留余量。"""
    cli = CLI.read_text()
    assert "MAX_TARGET_OPTIONS = 200" in cli
    assert "truncated" in cli


def test_questions_are_a_closed_choice_set():
    """Decision must be a closed multiple-choice, not free-form generation."""
    cli = CLI.read_text()
    assert '"type": "choice"' in cli
    assert '"operation"' in cli
    assert '"click_target"' in cli
    assert '"type_target"' in cli
    # 选项 key 用 e<node>，可回译成 click --node
    assert 'f"e{it[\'node\']}"' in cli
    assert "def _node_from_choice(" in cli


def test_operation_space_is_bounded():
    cli = CLI.read_text()
    for op in ("CLICK", "TYPE_TEXT", "SCROLL_DOWN", "SCROLL_UP", "WAIT", "DONE"):
        assert f'"{op}"' in cli, f"缺少操作 {op}"
    # 没有可滚动余量时不该提供滚动选项
    assert 'operations.pop("SCROLL_DOWN", None)' in cli
    assert 'operations.pop("SCROLL_UP", None)' in cli


def test_editable_targets_also_offer_click():
    """可编辑元素既能输入也能点击（聚焦/展开），两个 head 都要包含它。"""
    cli = CLI.read_text()
    assert "TYPE_ROLES" in cli
    assert "CLICK_ROLES" in cli
    assert "typable.append(it)" in cli
    assert "clickable.append(it)" in cli


def test_decider_only_picks_target_text_comes_from_caller():
    """JEV 不生成文本：TYPE_TEXT 只选目标，文字由调用方提供。"""
    cli = CLI.read_text()
    assert "needsText=True" in cli
    assert "文字内容由调用方提供" in cli


def test_guard_is_not_sent_to_decider():
    """guard 含分隔符且很长，是 click 做 stale 校验用的，不该污染决策上下文。"""
    cli = CLI.read_text()
    assert "def _lean_item(item: dict) -> dict:" in cli
    assert '"parentNode",' in cli
    # keep 列表里不含 guard
    lean = cli.split("def _lean_item", 1)[1].split("def _describe_element", 1)[0]
    assert '"guard"' not in lean
    assert "coordinates" not in lean


def test_scroll_state_and_page_text_are_sent_as_context():
    cli = CLI.read_text()
    assert 'snapshot.get("pageText")' in cli
    assert 'snapshot.get("scroll")' in cli
    # 再截一刀，避免长页面撑爆上下文
    assert "[:2000]" in cli


def test_availability_is_probed_not_assumed():
    """有 key 不等于能用：key 可能无效、欠费、或网络不通。"""
    cli = CLI.read_text()
    assert "def probe_decider(force: bool = False) -> dict:" in cli
    assert "def _classify_decider_error(exc: Exception) -> tuple:" in cli
    # 探测要能区分「确定性配置问题」和「瞬时故障」
    for code in ("invalid_key", "quota_exhausted", "rate_limited", "unreachable", "timeout"):
        assert code in cli, f"缺少失败归类 {code}"
    assert "permanent" in cli


def test_probe_result_is_cached_on_disk():
    """CLI 每次都是新进程，缓存必须落盘；否则每次 decide 都要多付一次探测。"""
    cli = CLI.read_text()
    assert "DECIDER_STATE_PATH" in cli
    # 失败冷却期要短于成功信任期：故障恢复后不该等太久
    ok_ttl = int(re.search(r"DECIDER_OK_TTL_S\s*=\s*(\d+)", cli).group(1))
    fail_ttl = int(re.search(r"DECIDER_FAIL_TTL_S\s*=\s*(\d+)", cli).group(1))
    assert fail_ttl < ok_ttl
    assert "_load_decider_state" in cli and "_save_decider_state" in cli


def test_all_unavailable_reasons_share_one_fallback_contract():
    """所有「决策器给不出答案」的原因都返回同一份编号表，调用方只写一条分支。"""
    cli = CLI.read_text()
    assert "def _decision_degraded(" in cli
    body = cli.split("def _decision_degraded(", 1)[1].split("\ndef ", 1)[0]
    for field in ('"ok": False', '"decider": None', '"reasonCode"', '"elements": targets', '"hint"'):
        assert field in body, f"降级契约缺少 {field}"
    # 各条降级路径都走同一个函数
    assert cli.count("_decision_degraded(") >= 5


def test_confidence_gate_maps_to_recommended_action():
    cli = CLI.read_text()
    assert "def confidence_gate(" in cli
    assert 'return "high", "act"' in cli
    assert 'return "medium", "recheck"' in cli
    assert 'return "low", "escalate"' in cli
    # 取操作与目标里更低的那个：两个判断都得对，整条决策才可用
    assert "effective = min(numeric) if numeric else None" in cli
    assert "CONFIDENCE_HIGH = 0.9" in cli
    assert "CONFIDENCE_MEDIUM = 0.5" in cli


def test_low_confidence_returns_the_element_table():
    """置信度过低不是错误，是要把决策权交回调用方。"""
    cli = CLI.read_text()
    assert '"low_confidence"' in cli
    # 带上原始判断当参考
    assert "candidate={" in cli


def test_decider_can_be_skipped_entirely():
    cli = CLI.read_text()
    assert '"--no-decider"' in cli
    assert "decider_disabled" in cli
    assert '"--probe"' in cli
    assert '"--min-confidence"' in cli


def test_decider_never_touches_the_baseline_path():
    """决策层只在 CLI 里，扩展侧完全不知道它的存在 —— 它挂了也不影响 snapshot/click。"""
    background = BACKGROUND.read_text()
    for token in ("typesafe", "TypeSafe", "TYPESAFE", "jev", "decide"):
        assert token not in background, f"扩展侧不该出现 {token}"
    cli = CLI.read_text()
    # 快照命令不依赖决策层
    snap_fn = cli.split("def cmd_snapshot(", 1)[1].split("\ndef ", 1)[0]
    assert "decider" not in snap_fn
    assert "TYPESAFE" not in snap_fn
