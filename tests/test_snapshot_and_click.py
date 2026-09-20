"""Static checks for snapshot element collection and click target resolution.

这些是源码级断言，配合 tests/fixtures 之外的真实页面手测使用。
行为级验证见仓库根目录的验证脚本说明。
"""

from pathlib import Path

BACKGROUND = Path(__file__).parents[1] / "extension" / "background.js"
CLI = Path(__file__).parents[1] / "cli" / "sbc"
SKILL = Path(__file__).parents[1] / "skill" / "SKILL.md"
PROTOCOL = Path(__file__).parents[1] / "docs" / "protocol.md"


def test_snapshot_and_click_share_one_scanner():
    """click 必须复用 snapshot 的采集逻辑，否则 --index 会再次错位。"""
    source = BACKGROUND.read_text()
    assert "function scanPage(opts)" in source
    # snapshot 与 click 都走 scanPage
    assert source.count("func: scanPage") >= 2
    # 旧的「只按几何过滤重建顺序」实现必须消失
    assert "rebuild snapshot order roughly" not in source


def test_stable_node_ids_use_weakmap():
    source = BACKGROUND.read_text()
    assert "window.__sbcScan" in source
    assert "new WeakMap()" in source
    assert "cache.ids.set(el, cache.next++)" in source
    # 断开的节点要从反向映射和指纹表里一起清掉，避免持有已卸载元素
    assert "cache.nodes.delete(id)" in source
    assert "cache.guards.delete(id)" in source


def test_accessible_name_chain_is_implemented():
    """图标按钮只有 aria-label，必须能算出来。"""
    source = BACKGROUND.read_text()
    assert "const accessibleName = (el, seen) =>" in source
    assert "aria-labelledby" in source
    assert "el.labels" in source
    assert "el.getAttribute('placeholder')" in source


def test_element_state_is_collected():
    source = BACKGROUND.read_text()
    for field in ["checked", "selectedValue", "readOnly", "disabled"]:
        assert field in source, f"缺少状态字段 {field}"
    assert "aria-expanded" in source
    assert "aria-selected" in source


def test_non_interactable_elements_are_filtered():
    source = BACKGROUND.read_text()
    # disabled 与 aria-disabled 都要过滤
    assert "el.matches(':disabled') || el.closest('[aria-disabled=\"true\"]')" in source
    # 隐藏：aria-hidden / inert / checkVisibility
    assert "'[aria-hidden=\"true\"],[inert]'" in source
    assert "checkVisibility" in source
    # 视觉上不可感知的小元素
    assert "if (r.width < 5 || r.height < 5) continue;" in source


def test_click_rejects_occluded_and_disabled_targets():
    source = BACKGROUND.read_text()
    assert "document.elementFromPoint(cx, cy)" in source
    assert "target is covered by" in source
    assert "target is disabled" in source


def test_click_reports_whether_page_changed():
    source = BACKGROUND.read_text()
    assert "async function pageMarker(tabId)" in source
    # 指纹要包含可见文本长度，否则纯文字更新检测不到
    assert "text.length" in source
    assert "changed:" in source
    assert "urlChanged:" in source


def test_trusted_click_brings_tab_to_front():
    """后台标签收不到 CDP mousePressed，可信模式必须先前置标签。"""
    source = BACKGROUND.read_text()
    assert "Page.bringToFront" in source
    assert "Input.dispatchMouseEvent" in source
    assert "params.trusted === true" in source
    # 默认必须是合成事件，不能默默抢焦点
    assert "let via = 'synthetic';" in source


def test_index_out_of_range_gives_clear_error():
    source = BACKGROUND.read_text()
    assert "out of range (page has" in source


def test_cli_exposes_node_and_trusted():
    cli = CLI.read_text()
    assert '"--node"' in cli
    assert '"--trusted"' in cli
    # 旧的 --no-trusted 语义已反转为 --trusted
    assert "--no-trusted" not in cli
    assert 'params["node"] = args.node' in cli
    assert 'params["trusted"] = True' in cli


def test_guard_is_stored_and_rechecked_before_acting():
    """快照记下元素指纹，操作前重算比对，发现元素被改写就报 stale。"""
    source = BACKGROUND.read_text()
    assert "cache.guards.set(item.node, guard)" in source
    assert "cache.guardOf = guardOf" in source
    assert "cache.staleCheck = (node, el) =>" in source
    # click 与 fill 都要走这道校验
    assert source.count("cache.staleCheck(opts.node, el)") >= 2
    assert "staleFields" in source
    # 邻近上下文变化与元素自身变化要区分开
    assert "contextChanged" in source


def test_fill_supports_node_and_index():
    source = BACKGROUND.read_text()
    cli = CLI.read_text()
    assert "async function resolveNode(tabId, params)" in source
    # click 与 fill 共用同一套 node/index 解析
    assert source.count("await resolveNode(tabId, params)") >= 2
    assert "fill requires node | index | selector" in source
    assert 'f.add_argument("--node", type=int' in cli


def test_fill_resolves_value_setter_along_prototype_chain():
    """写死 HTMLInputElement.prototype 对 select 会抛 Illegal invocation。"""
    source = BACKGROUND.read_text()
    assert "Object.getPrototypeOf(el)" in source
    assert "Illegal invocation" in source
    # 旧的写死原型写法必须消失
    assert "el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype" not in source


def test_fill_rejects_checkbox_and_radio():
    source = BACKGROUND.read_text()
    assert "use click to toggle a checkbox or radio, not fill" in source


def test_select_options_are_expanded():
    """原生下拉的选项要单独成条，否则 Agent 看不到有哪些可选值。"""
    source = BACKGROUND.read_text()
    assert "el.tagName === 'SELECT'" in source
    assert "role: 'option'" in source
    assert "parentNode: item.node" in source
    # 已选中的、禁用的选项不重复列出
    assert "if (opt.selected || opt.disabled || opt.closest('optgroup[disabled]')) continue;" in source
    # 点击 option 要映射成给父 select 赋值，而不是派发鼠标事件
    assert "kind: 'select'" in source
    assert "optionValue" in source
    assert "parent select is gone" in source


def test_snapshot_reports_scroll_and_page_text():
    source = BACKGROUND.read_text()
    assert "pageText" in source
    assert "canScrollDown" in source
    assert "canScrollUp" in source
    # 屏幕外正文不进上下文
    assert "tr.top < innerHeight" in source
    assert "omitted" in source


def test_click_waits_for_page_to_settle():
    """异步渲染的站点不会立刻反映变化，直接比较会误报 changed=false。"""
    source = BACKGROUND.read_text()
    assert "async function waitForSettle(tabId, maxMs)" in source
    # 计时必须在扩展侧：页面里的 setTimeout 在后台标签会被节流到约 1 秒
    assert "await sleep(first)" in source
    assert "setTimeout(tick" not in source
    # 页面侧只装观察器记录变动
    assert "window.__sbcMut" in source
    assert "new MutationObserver(" in source
    assert "async function readMutationFlag(tabId)" in source
    # click 与 select 两条路径都要等
    assert source.count("await waitForSettle(tabId, settleMs)") >= 2
    # 上限可调，且不能无上限等待
    assert "Math.min(Number(maxMs) || 0, 3000)" in source


def test_change_detection_includes_form_state():
    """select/checkbox 的改动不改变节点数或文本长度，必须单独纳入指纹。"""
    source = BACKGROUND.read_text()
    assert "const forms = [...document.querySelectorAll('input,textarea,select')]" in source


def test_cli_exposes_settle():
    cli = CLI.read_text()
    assert '"--settle"' in cli
    assert 'params["settle"] = args.settle' in cli


def test_docs_describe_the_new_surface():
    skill = SKILL.read_text()
    protocol = PROTOCOL.read_text()
    for doc in (skill, protocol):
        assert "--node" in doc
        assert "trusted" in doc
    assert "window.__sbcScan" in protocol
    assert "可访问名称" in skill
    assert "只收录视口内的元素" in skill
