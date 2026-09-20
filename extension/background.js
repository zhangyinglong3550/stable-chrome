/**
 * Stable Chrome Attach — MV3 service worker
 * Polls local bridge for commands and executes them against real Chrome tabs.
 */

const BRIDGE = 'http://127.0.0.1:19527';
const POLL_WAIT_MS = 25000;
const HELLO_EVERY_MS = 5000;
// 长轮询最多等 POLL_WAIT_MS，超过这个时间没再往 bridge 要过命令就认定 loop 卡死。
// 必须大于 POLL_WAIT_MS，否则正常的长轮询会被误判。
const POLL_STALL_MS = 60000;
const DEFAULT_TASK_TITLE = 'Agent 任务';
const STATE_STORAGE_KEY = 'stableChromeTaskState';

// SW 被 Chrome 挂起后，上下文重置，pollLoop 会停掉。
// alarm 唤醒时用此标志判断是否需要重新启动。
//
// 注意：单靠这个布尔量不够 —— 如果 loop 卡在某个永不返回的 await 里，
// _pollRunning 会一直是 true，alarm 的 `if (!_pollRunning)` 永远不成立，
// 保活机制就被自己的防重入锁挡住了（实测踩过）。所以额外用
// _pollTick 记录最后一次活动时间，超时即强制换新一代 loop。
let _pollRunning = false;
let _pollTick = 0;
// 代际计数：卡死的旧 loop 恢复后会发现自己已被取代，自行退出，避免两个 loop 并存
let _pollGen = 0;
let _stateReady = null; // Promise：首次从 storage 恢复完成

// Chrome tabGroups 支持的颜色（新建分组时轮换/随机，避免永远同一色）
const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'grey'];

const state = {
  taskActive: false,
  taskTitle: DEFAULT_TASK_TITLE,
  taskGroupId: null,
  taskGroupColor: null,
  rootTabId: null,
  claimedTabId: null,
  /** Agent 专用窗口 id；设置后 new-tab 优先落在此窗口，避免和用户同窗抢标签 */
  taskWindowId: null,
  /** start-task --window：首次开页时再建独立窗口（deferred） */
  preferTaskWindow: false,
  pollAbort: false,
  debuggerAttached: new Set(), // tabId numbers
};

function snapshotTaskState() {
  return {
    taskActive: state.taskActive,
    taskTitle: state.taskTitle,
    taskGroupId: state.taskGroupId,
    taskGroupColor: state.taskGroupColor,
    rootTabId: state.rootTabId,
    claimedTabId: state.claimedTabId,
    taskWindowId: state.taskWindowId,
    preferTaskWindow: state.preferTaskWindow,
  };
}

async function persistTaskState() {
  try {
    await chrome.storage.session.set({ [STATE_STORAGE_KEY]: snapshotTaskState() });
  } catch (e) {
    // session storage 不可用时降级到 local，尽量保住跨 SW 重启的状态
    try {
      await chrome.storage.local.set({ [STATE_STORAGE_KEY]: snapshotTaskState() });
    } catch (e2) {
      console.warn('[stable-chrome] persistTaskState failed', e2);
    }
  }
}

async function loadPersistedTaskState() {
  try {
    let data = await chrome.storage.session.get(STATE_STORAGE_KEY);
    let saved = data?.[STATE_STORAGE_KEY];
    if (!saved) {
      data = await chrome.storage.local.get(STATE_STORAGE_KEY);
      saved = data?.[STATE_STORAGE_KEY];
    }
    if (!saved || typeof saved !== 'object') return;
    state.taskActive = Boolean(saved.taskActive);
    if (saved.taskTitle) state.taskTitle = String(saved.taskTitle);
    state.taskGroupId = saved.taskGroupId ?? null;
    state.taskGroupColor = saved.taskGroupColor ?? null;
    state.rootTabId = saved.rootTabId ?? null;
    state.claimedTabId = saved.claimedTabId ?? null;
    state.taskWindowId = saved.taskWindowId ?? null;
    state.preferTaskWindow = Boolean(saved.preferTaskWindow);
  } catch (e) {
    console.warn('[stable-chrome] loadPersistedTaskState failed', e);
  }
}

/** 校验内存里的 tab/group id 是否仍有效；失效则清掉并写回 storage */
async function reconcileTaskState() {
  if (state.claimedTabId != null) {
    const claimed = state.claimedTabId;
    try {
      await chrome.tabs.get(claimed);
    } catch {
      if (state.rootTabId === claimed) state.rootTabId = null;
      state.claimedTabId = null;
    }
  }
  if (state.rootTabId != null && state.rootTabId !== state.claimedTabId) {
    try {
      await chrome.tabs.get(state.rootTabId);
    } catch {
      state.rootTabId = null;
    }
  }
  if (state.taskGroupId != null) {
    try {
      const g = await chrome.tabGroups.get(state.taskGroupId);
      state.taskGroupColor = g?.color || state.taskGroupColor;
      // 组还在但 claimed 丢了：从组内挑一个可用标签接上
      if (state.claimedTabId == null) {
        const tabs = await chrome.tabs.query({ groupId: state.taskGroupId });
        const usable = tabs.find((t) => t.id != null && !isRestrictedUrl(t.url || ''));
        const any = usable || tabs.find((t) => t.id != null);
        if (any?.id != null) {
          state.claimedTabId = any.id;
          if (state.rootTabId == null) state.rootTabId = any.id;
        } else {
          state.taskGroupId = null;
          state.taskActive = false;
        }
      }
    } catch {
      state.taskGroupId = null;
      // 组没了但 claimed 还在：保留 claimed，后续 ensureTaskGroup 会重建
    }
  }
  if (state.taskWindowId != null) {
    try {
      await chrome.windows.get(state.taskWindowId);
    } catch {
      state.taskWindowId = null;
    }
  }
  // 若既无 claimed 也无 group，任务视为未激活
  if (state.claimedTabId == null && state.taskGroupId == null) {
    state.taskActive = false;
  }
  await persistTaskState();
}

/**
 * 解析是否要独立任务窗口：params.window / newWindow / separateWindow
 */
function wantsTaskWindow(params = {}) {
  return (
    params.window === true ||
    params.newWindow === true ||
    params.separateWindow === true
  );
}

/**
 * 确保 Agent 有独立窗口（默认 focused:false，不抢系统前台）。
 * - 已有有效 taskWindowId：直接复用
 * - 已有 claimed 标签：把它移到新窗口（不 focus）
 * - 否则：建 unfocused 空白窗，并把其中标签作为 claimed 根
 */
async function ensureAgentWindow(params = {}) {
  if (state.taskWindowId != null) {
    try {
      await chrome.windows.get(state.taskWindowId);
      return { windowId: state.taskWindowId, created: false, moved: false };
    } catch {
      state.taskWindowId = null;
    }
  }

  // 把已有 claimed 标签拆到独立窗口
  if (state.claimedTabId != null) {
    try {
      const tab = await chrome.tabs.get(state.claimedTabId);
      if (tab?.id != null) {
        const win = await chrome.windows.create({
          tabId: tab.id,
          focused: false,
          type: 'normal',
        });
        state.taskWindowId = win.id;
        state.preferTaskWindow = true;
        return { windowId: state.taskWindowId, created: true, moved: true };
      }
    } catch (e) {
      console.warn('[stable-chrome] ensureAgentWindow move failed', e);
    }
  }

  // 无 claimed：建后台空白窗作为任务根（仍 focused:false）
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    type: 'normal',
  });
  state.taskWindowId = win.id;
  state.preferTaskWindow = true;
  const seed = win.tabs && win.tabs[0];
  if (seed?.id != null) {
    state.claimedTabId = seed.id;
    if (state.rootTabId == null) state.rootTabId = seed.id;
  }
  return {
    windowId: state.taskWindowId,
    created: true,
    moved: false,
    seededTabId: seed?.id != null ? String(seed.id) : null,
  };
}

/** 创建标签时优先落到 task 窗口；窗口失效则清掉再退回默认 */
async function createTabInTaskContext(createProps = {}) {
  const props = { ...createProps };
  if (props.active == null) props.active = false;

  if (state.taskWindowId != null) {
    try {
      await chrome.windows.get(state.taskWindowId);
      props.windowId = state.taskWindowId;
    } catch {
      state.taskWindowId = null;
    }
  }

  // preferTaskWindow 且还没有窗口：先建独立窗再开页
  if (state.preferTaskWindow && state.taskWindowId == null && props.url) {
    const win = await chrome.windows.create({
      url: props.url,
      focused: false,
      type: 'normal',
    });
    state.taskWindowId = win.id;
    const tab = win.tabs && win.tabs[0];
    if (!tab?.id) throw new Error('failed to create task window tab');
    return tab;
  }

  return chrome.tabs.create(props);
}

function ensureStateReady() {
  if (!_stateReady) {
    _stateReady = (async () => {
      await loadPersistedTaskState();
      await reconcileTaskState();
    })();
  }
  return _stateReady;
}

function isBlankTabUrl(url = '') {
  return (
    !url ||
    url === 'about:blank' ||
    url.startsWith('chrome://newtab') ||
    url.startsWith('chrome://new-tab-page') ||
    url === 'chrome://newtab/'
  );
}

/** 为新任务组选一个颜色：优先用入参，否则按标题 hash + 时间戳打散 */
function pickGroupColor(title = '', preferred) {
  if (preferred && GROUP_COLORS.includes(preferred)) return preferred;
  const s = `${title || 'task'}|${Date.now()}|${Math.random()}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bridgeFetch(path, options = {}) {
  // 必须带超时：长轮询一旦连接卡住而不返回，await 会永久挂起，
  // pollLoop 就死在那里（保活也救不回来）。默认比长轮询多留 10s 余量。
  const { timeoutMs = POLL_WAIT_MS + 10000, ...fetchOptions } = options;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE}${path}`, {
      ...fetchOptions,
      signal: fetchOptions.signal || ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(fetchOptions.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`bridge non-json ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok && data?.ok === false) {
      const err = new Error(data.error || `bridge http ${res.status}`);
      err.payload = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function hello() {
  try {
    await bridgeFetch('/ext/hello', {
      method: 'POST',
      body: JSON.stringify({
        extensionId: chrome.runtime.id,
        version: chrome.runtime.getManifest().version,
        ts: Date.now(),
      }),
    });
    return true;
  } catch (e) {
    console.warn('[stable-chrome] hello failed', e);
    return false;
  }
}

function isRestrictedUrl(url = '') {
  return (
    !url ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('devtools://') ||
    url.startsWith('chrome-search://')
  );
}

async function listOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const out = [];
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    out.push({
      id: String(tab.id),
      title: tab.title || '',
      url: tab.url,
      windowId: tab.windowId,
      groupId: tab.groupId,
      active: Boolean(tab.active),
      pinned: Boolean(tab.pinned),
      audible: Boolean(tab.audible),
      status: tab.status || '',
      lastAccessed: tab.lastAccessed || 0,
      restricted: isRestrictedUrl(tab.url),
    });
  }
  out.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return out;
}

async function ensureTaskGroup(tabId, title, preferredColor) {
  if (title) state.taskTitle = title;
  const tab = await chrome.tabs.get(tabId);

  // 1) 已有「本任务」分组：只把标签移入，绝不改名用户其它组
  if (state.taskGroupId != null) {
    try {
      const existing = await chrome.tabGroups.get(state.taskGroupId);
      state.taskGroupColor = existing?.color || state.taskGroupColor;
      if (tab.groupId !== state.taskGroupId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: state.taskGroupId });
      }
      // 仅更新本任务组标题；不碰颜色（复用时保留）
      await chrome.tabGroups.update(state.taskGroupId, {
        title: state.taskTitle,
        collapsed: false,
      });
      return state.taskGroupId;
    } catch {
      state.taskGroupId = null;
    }
  }

  // 2) 标签已在某个分组里：禁止「收养并改名」整个用户分组
  //    （旧逻辑会把用户工作区整组改成任务标题，并拖进自动化）
  //    正确做法：把该标签移出，单独建 Agent 任务组
  // 3) 标签不在组里：直接新建任务组
  const color = pickGroupColor(state.taskTitle, preferredColor || state.taskGroupColor);
  // 关键：必须带 createProperties.windowId。
  // 若省略，Chrome 会按「当前聚焦窗口」建组，把独立任务窗里的标签拽回用户窗口。
  const groupOpts = { tabIds: [tabId] };
  if (tab.windowId != null) {
    groupOpts.createProperties = { windowId: tab.windowId };
  }
  const groupId = await chrome.tabs.group(groupOpts);
  await chrome.tabGroups.update(groupId, {
    title: state.taskTitle,
    color,
    collapsed: false,
  });
  state.taskGroupId = groupId;
  state.taskGroupColor = color;
  if (tab.windowId != null) state.taskWindowId = tab.windowId;
  return groupId;
}

async function groupTabIfNeeded(tabId) {
  try {
    if (!state.taskActive || state.taskGroupId == null) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || isRestrictedUrl(tab.url)) return;
    if (tab.groupId === state.taskGroupId) return;
    await chrome.tabs.group({ tabIds: [tabId], groupId: state.taskGroupId });
  } catch (e) {
    console.warn('groupTabIfNeeded', e);
  }
}

/**
 * claim 默认不抢焦点（不 active、不 focus 窗口）。
 * 仅当 params.focus === true 时才激活标签并前置 Chrome 窗口。
 */
async function claimTab(tabId, title, params = {}) {
  const id = Number(tabId);
  if (Number.isNaN(id)) throw new Error('invalid tabId');
  const tab = await chrome.tabs.get(id);
  if (!tab) throw new Error('tab not found');
  state.claimedTabId = id;
  state.rootTabId = id;
  state.taskActive = true;
  if (tab.windowId != null) state.taskWindowId = tab.windowId;
  // claim + --window：把该标签拆到独立后台窗口，避免和用户同窗
  if (wantsTaskWindow(params)) {
    state.preferTaskWindow = true;
    await ensureAgentWindow(params);
  }
  const groupId = await ensureTaskGroup(
    state.claimedTabId,
    title || state.taskTitle,
    params.color,
  );
  await persistTaskState();
  // 默认静默：只建组/接管，不把浏览器弹到前台
  if (params.focus === true) {
    try {
      await chrome.tabs.update(state.claimedTabId, { active: true });
      const t2 = await chrome.tabs.get(state.claimedTabId);
      if (t2.windowId != null) {
        await chrome.windows.update(t2.windowId, { focused: true });
      }
    } catch {}
  }
  const finalTab = await chrome.tabs.get(state.claimedTabId);
  return {
    tabId: String(state.claimedTabId),
    title: finalTab.title || '',
    url: finalTab.url || '',
    groupId,
    groupColor: state.taskGroupColor,
    taskTitle: state.taskTitle,
    windowId: finalTab.windowId != null ? String(finalTab.windowId) : null,
    preferTaskWindow: state.preferTaskWindow,
  };
}

async function claimCurrentTab(title, params = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('没有活动标签页');
  return claimTab(String(tab.id), title, params);
}

async function startTask(title, params = {}) {
  await reconcileTaskState();
  state.taskActive = true;
  // 仅当调用方显式传入 title 时才改名；缺省保持已有任务名 / 默认 Agent 任务
  if (title) state.taskTitle = title;
  // 允许调用方预置颜色（等第一次 new-tab/claim 建组时用）
  if (params.color && GROUP_COLORS.includes(params.color)) {
    state.taskGroupColor = params.color;
  }
  // --window：后续 new-tab 进独立窗口；已有 claimed 时立刻拆窗
  if (wantsTaskWindow(params)) {
    state.preferTaskWindow = true;
  }

  let groupId = state.taskGroupId;
  let reused = false;
  let createdBlank = false;
  let windowInfo = null;

  if (state.claimedTabId != null) {
    // 复用已有 claimed 标签与分组，绝不新建空白页
    groupId = await ensureTaskGroup(state.claimedTabId, state.taskTitle, params.color);
    reused = true;
  } else if (state.taskGroupId != null) {
    // 组还在但 claimed 丢了（reconcile 已尝试恢复）；再保险一次
    const tabs = await chrome.tabs.query({ groupId: state.taskGroupId });
    const pick = tabs.find((t) => t.id != null);
    if (pick?.id != null) {
      state.claimedTabId = pick.id;
      if (state.rootTabId == null) state.rootTabId = pick.id;
      groupId = await ensureTaskGroup(pick.id, state.taskTitle, params.color);
      reused = true;
    }
  }

  // 需要独立窗且已有 claimed：立刻把标签拆到后台新窗口，避免和用户同窗
  if (state.preferTaskWindow && state.claimedTabId != null && state.taskWindowId == null) {
    windowInfo = await ensureAgentWindow(params);
    // 移窗后 group 可能仍有效；再确保一次
    if (state.claimedTabId != null) {
      groupId = await ensureTaskGroup(state.claimedTabId, state.taskTitle, params.color);
    }
  }

  // 默认不再 start-task 时开 about:blank：
  // 否则「start-task + new-tab」会立刻堆出 2 个标签。
  // 只有显式 seedBlank:true 才预建空白根标签（兼容旧脚本）。
  // 若同时 --window 且尚无 claimed，也用 ensureAgentWindow 建独立空白窗。
  if (state.claimedTabId == null && params.seedBlank === true) {
    if (state.preferTaskWindow) {
      windowInfo = await ensureAgentWindow(params);
      if (state.claimedTabId != null) {
        groupId = await ensureTaskGroup(state.claimedTabId, state.taskTitle, params.color);
        createdBlank = true;
      }
    } else {
      const tab = await createTabInTaskContext({ url: 'about:blank', active: false });
      state.claimedTabId = tab.id;
      state.rootTabId = tab.id;
      groupId = await ensureTaskGroup(tab.id, state.taskTitle, params.color);
      createdBlank = true;
    }
  }

  await persistTaskState();
  return {
    taskActive: true,
    taskTitle: state.taskTitle,
    groupId,
    groupColor: state.taskGroupColor,
    rootTabId: state.rootTabId != null ? String(state.rootTabId) : null,
    claimedTabId: state.claimedTabId != null ? String(state.claimedTabId) : null,
    taskWindowId: state.taskWindowId != null ? String(state.taskWindowId) : null,
    preferTaskWindow: state.preferTaskWindow,
    reused,
    createdBlank,
    deferredTab: state.claimedTabId == null,
    window: windowInfo,
  };
}

async function endTask(closeGroup = false, closeTabs = false) {
  state.taskActive = false;
  const groupId = state.taskGroupId;
  if ((closeGroup || closeTabs) && groupId != null) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.groupId === groupId && tab.id != null) {
        try {
          if (closeTabs) {
            // 真正关闭页面：任务确认完成后回收手段型标签页。
            // 关掉组内全部标签后 Chrome 会自动解散空分组。
            await chrome.tabs.remove(tab.id);
          } else {
            // 只解散分组，标签保留（散落回窗口）——默认的安全行为
            await chrome.tabs.ungroup(tab.id);
          }
        } catch {}
      }
    }
  }
  // detach debuggers
  for (const tabId of [...state.debuggerAttached]) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
    state.debuggerAttached.delete(tabId);
  }
  state.taskGroupId = null;
  state.taskGroupColor = null;
  state.claimedTabId = null;
  state.rootTabId = null;
  state.taskWindowId = null;
  state.preferTaskWindow = false;
  await persistTaskState();
  return { ended: true, closedGroup: Boolean(closeGroup), closedTabs: Boolean(closeTabs), previousGroupId: groupId };
}

/** 热重载扩展自身（加载磁盘上最新 background.js）。调用后 SW 会短暂离线再上线。 */
async function reloadExtension() {
  // 异步触发，先把结果回传再 reload
  setTimeout(() => {
    try {
      chrome.runtime.reload();
    } catch (e) {
      console.warn('reloadExtension failed', e);
    }
  }, 200);
  return { reloading: true };
}

async function resolveTabId(params = {}) {
  if (params.tabId != null) return Number(params.tabId);
  if (state.claimedTabId != null) {
    try {
      await chrome.tabs.get(state.claimedTabId);
      return state.claimedTabId;
    } catch {
      state.claimedTabId = null;
      await persistTaskState();
    }
  }
  // 任务已激活但还没 new-tab/claim：不要回落到用户当前标签（会误操作/抢焦点）
  if (state.taskActive) {
    throw new Error(
      'task active but no claimed tab; run `sbc new-tab --url ...` or `sbc claim` first',
    );
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  return tab.id;
}

async function newTab(params = {}) {
  const url = params.url || 'about:blank';
  // 默认后台开页，只有显式 active:true 才切到该标签
  const active = params.active === true;
  // 同任务默认永远单标签：有 claimed 就 navigate 复用；只有 force 才新建
  const forceNew = params.force === true || params.forceNew === true;

  // 任务已激活但还没有 claimed（start-task 延迟建标签）：直接创建并建组
  // preferTaskWindow 时优先落到独立后台窗口
  if (!forceNew && state.taskActive && state.claimedTabId == null) {
    const tab = await createTabInTaskContext({ url, active });
    state.claimedTabId = tab.id;
    state.rootTabId = tab.id;
    if (tab.windowId != null) state.taskWindowId = tab.windowId;
    await ensureTaskGroup(tab.id, state.taskTitle, state.taskGroupColor);
    await persistTaskState();
    return {
      tabId: String(tab.id),
      url: tab.pendingUrl || tab.url || url,
      groupId: state.taskGroupId,
      windowId: tab.windowId != null ? String(tab.windowId) : null,
      active,
      reused: false,
      seeded: true,
      singleTab: true,
    };
  }

  // 同任务单标签策略：无论空白还是已有内容，一律在 claimed 标签上导航
  if (!forceNew && state.claimedTabId != null) {
    try {
      const existing = await chrome.tabs.get(state.claimedTabId);
      if (existing?.id != null) {
        // 若要求独立窗但 claimed 还在用户窗口，先拆出去再导航
        if (
          state.preferTaskWindow &&
          state.taskWindowId == null &&
          existing.windowId != null
        ) {
          await ensureAgentWindow(params);
        }
        const update = { url };
        if (active) update.active = true;
        await chrome.tabs.update(existing.id, update);
        if (state.taskActive) {
          if (state.taskGroupId == null) {
            await ensureTaskGroup(existing.id, state.taskTitle, state.taskGroupColor);
          } else {
            await groupTabIfNeeded(existing.id);
          }
        }
        const after = await chrome.tabs.get(existing.id);
        if (after?.windowId != null) state.taskWindowId = after.windowId;
        await persistTaskState();
        return {
          tabId: String(existing.id),
          url,
          groupId: state.taskGroupId,
          windowId: after?.windowId != null ? String(after.windowId) : null,
          active,
          reused: true,
          singleTab: true,
        };
      }
    } catch {
      // claimed 已失效，走下面新建
      state.claimedTabId = null;
    }
  }

  // force 新建，或无 claimed / 无任务：真正 create
  const tab = await createTabInTaskContext({ url, active });
  if (tab.windowId != null && state.taskActive) {
    state.taskWindowId = tab.windowId;
  }
  if (state.taskActive) {
    if (state.taskGroupId == null) {
      // 任务组尚未建立：以此标签为根建组
      state.claimedTabId = tab.id;
      if (state.rootTabId == null) state.rootTabId = tab.id;
      await ensureTaskGroup(tab.id, state.taskTitle, state.taskGroupColor);
    } else {
      // force 多标签：新标签进任务组，并成为当前 claimed（后续默认仍单标签落在它上面）
      await groupTabIfNeeded(tab.id);
      state.claimedTabId = tab.id;
      if (state.rootTabId == null) state.rootTabId = tab.id;
    }
  } else {
    // 无任务时 new-tab：只开标签，不建组、不标记 claimed，避免污染用户下次 start-task
  }
  await persistTaskState();
  return {
    tabId: String(tab.id),
    url: tab.pendingUrl || tab.url || url,
    groupId: state.taskGroupId,
    windowId: tab.windowId != null ? String(tab.windowId) : null,
    active,
    reused: false,
    forced: forceNew,
    singleTab: !forceNew,
  };
}

async function closeTab(params = {}) {
  let tabId;
  if (params.tabId != null) {
    tabId = Number(params.tabId);
  } else if (state.claimedTabId != null) {
    tabId = state.claimedTabId;
  } else {
    throw new Error('closeTab requires --tab-id or an active claimed tab');
  }
  if (Number.isNaN(tabId)) throw new Error('invalid tabId');
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    throw new Error(`closeTab failed: ${e?.message || e}`);
  }
  if (state.claimedTabId === tabId) state.claimedTabId = null;
  if (state.rootTabId === tabId) state.rootTabId = null;
  // 若任务组已空，清掉 group 引用
  if (state.taskGroupId != null) {
    try {
      const left = await chrome.tabs.query({ groupId: state.taskGroupId });
      if (!left.length) {
        state.taskGroupId = null;
        state.taskGroupColor = null;
      } else if (state.claimedTabId == null && left[0]?.id != null) {
        state.claimedTabId = left[0].id;
      }
    } catch {
      state.taskGroupId = null;
    }
  }
  await persistTaskState();
  return { closed: true, tabId: String(tabId) };
}

async function goto(params = {}) {
  const tabId = await resolveTabId(params);
  const url = params.url;
  if (!url) throw new Error('missing url');
  // 默认不改 active，避免后台导航时抢走用户正在看的标签
  const update = { url };
  if (params.active === true) update.active = true;
  await chrome.tabs.update(tabId, update);
  // wait complete
  const timeout = params.timeoutMs || 30000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return { tabId: String(tabId), url: tab.url, title: tab.title, status: tab.status };
    }
    await sleep(200);
  }
  const tab = await chrome.tabs.get(tabId);
  return { tabId: String(tabId), url: tab.url, title: tab.title, status: tab.status, timedOut: true };
}

async function reload(params = {}) {
  const tabId = await resolveTabId(params);
  await chrome.tabs.reload(tabId, { bypassCache: Boolean(params.bypassCache) });
  await sleep(300);
  const tab = await chrome.tabs.get(tabId);
  return { tabId: String(tabId), url: tab.url, title: tab.title, status: tab.status };
}

async function evalInTab(tabId, expression, awaitPromise = true) {
  if (isRestrictedUrl((await chrome.tabs.get(tabId)).url || '')) {
    throw new Error('restricted url cannot be scripted');
  }
  // Prefer chrome.scripting; expression is evaluated as an expression body.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [String(expression), Boolean(awaitPromise)],
    func: (expr, wait) => {
      const run = () => {
        // eslint-disable-next-line no-eval
        return eval(`(${expr})`);
      };
      try {
        const value = run();
        if (wait && value && typeof value.then === 'function') {
          return Promise.resolve(value).then((v) => ({ ok: true, value: v }));
        }
        return { ok: true, value };
      } catch (e) {
        // fallback: statement-ish eval
        try {
          // eslint-disable-next-line no-eval
          const value = eval(expr);
          if (wait && value && typeof value.then === 'function') {
            return Promise.resolve(value).then((v) => ({ ok: true, value: v }));
          }
          return { ok: true, value };
        } catch (e2) {
          return { ok: false, error: String(e2?.message || e2) };
        }
      }
    },
  });
  const packed = results?.[0]?.result;
  if (packed && packed.ok === false) throw new Error(packed.error || 'eval failed');
  return packed?.value;
}

async function evalCmd(params = {}) {
  const tabId = await resolveTabId(params);
  const expression = params.expression ?? params.js ?? params.code;
  if (!expression) throw new Error('missing expression');
  const result = await evalInTab(tabId, expression, params.awaitPromise !== false);
  return { tabId: String(tabId), result };
}

// ===== 页面元素扫描器 =====
// snapshot 和 click 共用同一份采集逻辑，保证「看到的编号」和「点到的元素」永远一致。
// 每个 DOM 节点会分配一个跨快照稳定的编号（缓存挂在页面的 window 上），
// 这样 Agent 可以先 snapshot 拿编号，再用 click --node 精准定位，无需重新查询页面。
function scanPage(opts) {
  const options = opts || {};
  const maxResults = options.max || 80;
  const withGuards = options.guards !== false;

  // ids 用 WeakMap：节点被回收后不会泄漏。nodes 反向映射供后续注入按编号取回元素。
  // guards 记住「快照那一刻」每个元素的指纹，点击前用来发现元素已被改写。
  const cache = (window.__sbcScan = window.__sbcScan || {
    ids: new WeakMap(),
    nodes: new Map(),
    guards: new Map(),
    next: 1,
  });
  if (!cache.guards) cache.guards = new Map();
  for (const [id, el] of cache.nodes) {
    if (!el.isConnected) {
      cache.nodes.delete(id);
      cache.guards.delete(id);
    }
  }

  const identity = (el) => {
    if (!cache.ids.has(el)) cache.ids.set(el, cache.next++);
    const id = cache.ids.get(el);
    cache.nodes.set(id, el);
    return id;
  };

  const visibleText = (el) => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);

  // 可见性：优先用标准的 checkVisibility，缺失时退回 style 判断
  const visible = (el) => {
    if (el.closest('[aria-hidden="true"],[inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  // 可访问名称：aria-labelledby → aria-label → <label> → value → alt → 文本 → title → placeholder
  // 图标按钮只有 aria-label、没有可见文字，靠这条链才能被正确识别。
  const accessibleName = (el, seen) => {
    const visited = seen || new Set();
    if (!el || visited.has(el)) return '';
    visited.add(el);
    const fromRefs = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => accessibleName(document.getElementById(id), visited))
      .filter(Boolean)
      .join(' ');
    if (fromRefs) return fromRefs;
    const own = el.getAttribute('aria-label');
    if (own) return own;
    const fromLabels = [...(el.labels || [])]
      .map((l) => accessibleName(l, visited))
      .filter(Boolean)
      .join(' ');
    if (fromLabels) return fromLabels;
    if (['button', 'submit', 'reset'].includes(el.type) && el.value) return el.value;
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    if (el.tagName !== 'INPUT') {
      const t = visibleText(el);
      if (t) return t;
    }
    // 图片链接常见于 logo / 图标入口：名称在子元素的 alt 里
    const img = el.querySelector && el.querySelector('img[alt], svg title');
    if (img) {
      const alt = img.getAttribute('alt') || (img.textContent || '').trim();
      if (alt) return alt;
    }
    return el.getAttribute('title') || el.getAttribute('placeholder') || '';
  };

  const ROLES = [
    'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'menuitemradio', 'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton',
  ];
  const SELECTOR =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    ROLES.map((r) => '[role="' + r + '"]').join(',');

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (ROLES.includes(explicit)) return explicit;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA' || el.isContentEditable) return 'textbox';
    if (tag === 'INPUT') {
      if (el.type === 'checkbox' || el.type === 'radio') return el.type;
      if (['button', 'submit', 'reset', 'image'].includes(el.type)) return 'button';
      if (el.type === 'search') return 'searchbox';
      if (el.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(el.type)) return 'textbox';
    }
    return null;
  };

  // 元素指纹：执行前用它确认「决策时看到的」和「现在要点的」是同一个元素。
  // 除自身属性外还带一段邻近上下文文本，避免同名元素被替换后误判为同一个。
  const guardOf = (el) => {
    if (!el.isConnected || !visible(el)) return null;
    const scope = el.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || el.parentElement;
    return [
      identity(el),
      roleOf(el),
      accessibleName(el),
      el.value === undefined ? null : el.value,
      el.checked === undefined ? null : el.checked,
      el.selectedIndex === undefined ? null : el.selectedIndex,
      el.readOnly === undefined ? null : el.readOnly,
      el.matches(':disabled'),
      el.getAttribute('aria-disabled'),
      el.getAttribute('aria-expanded'),
      el.getAttribute('aria-checked'),
      el.getAttribute('aria-selected'),
      el.getAttribute('href'),
      scope && scope.innerText ? scope.innerText.slice(0, 3000) : '',
    ].join('\u0001');
  };

  // 兜底 selector：无 id/name 时不再退化成裸 tag 名，而是带上 role 和名称
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(el.name) + '"]';
    const role = roleOf(el);
    const label = accessibleName(el).slice(0, 40);
    if (role && label) return '[role="' + role + '"][aria-label="' + label.replace(/"/g, '\\"') + '"]';
    return el.tagName.toLowerCase();
  };

  const items = [];
  const seen = new Set();
  let omitted = 0;
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (['password', 'file', 'hidden'].includes(el.type)) continue;
    if (!visible(el)) continue;
    // 不可交互的元素不进候选表，避免 Agent 去点一个点不动的按钮
    if (el.matches(':disabled') || el.closest('[aria-disabled="true"]')) continue;
    const r = el.getBoundingClientRect();
    // 小于 5px 的元素视觉上不可感知，通常是隐藏表单或无障碍占位，
    // 放进来只会给决策添噪音（坐标点击也落不到它身上）
    if (r.width < 5 || r.height < 5) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const role = roleOf(el);
    if (!role) continue;

    const label = accessibleName(el) || role;
    const key = [el.tagName, role, label, Math.round(r.x), Math.round(r.y)].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const item = {
      node: identity(el),
      index: items.length,
      tag: el.tagName.toLowerCase(),
      role,
      name: label,
      text: visibleText(el),
      type: el.getAttribute('type'),
      value: 'value' in el ? String(el.value === undefined ? '' : el.value) : '',
      href: el.getAttribute('href'),
      placeholder: el.getAttribute('placeholder'),
      selector: selectorOf(el),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      readOnly: Boolean(el.readOnly) || el.getAttribute('aria-readonly') === 'true',
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
    if (typeof el.checked === 'boolean') item.checked = el.checked;
    if (el.tagName === 'SELECT') item.selectedValue = el.value;
    for (const attr of ['expanded', 'selected', 'pressed']) {
      const v = el.getAttribute('aria-' + attr);
      if (v !== null) item[attr] = v;
    }
    if (withGuards) {
      const guard = guardOf(el);
      item.guard = guard;
      // 记住快照时刻的指纹；click 时重算比对，就能发现「同一个节点已被改写」
      if (guard !== null) cache.guards.set(item.node, guard);
    }
    if (items.length >= maxResults) {
      omitted += 1;
      continue;
    }
    items.push(item);

    // select 的每个「未选中且未禁用」的选项单独成条：Agent 才能看到有哪些可选值。
    // click --node 命中 option 时会映射回父 select 的赋值（见 resolveClickTarget）。
    if (el.tagName === 'SELECT') {
      for (const opt of el.options) {
        if (opt.selected || opt.disabled || opt.closest('optgroup[disabled]')) continue;
        if (items.length >= maxResults) {
          omitted += 1;
          continue;
        }
        items.push({
          node: identity(opt),
          index: items.length,
          tag: 'option',
          role: 'option',
          name: (opt.label || opt.textContent || '').trim().slice(0, 120),
          text: (opt.textContent || '').trim().slice(0, 120),
          type: null,
          value: String(opt.value),
          href: null,
          placeholder: null,
          // option 本身没有独立选择器，用父 select 的
          selector: item.selector,
          disabled: false,
          readOnly: false,
          selected: false,
          // 指向所属 select，便于调用方理解层级
          parentNode: item.node,
          parentValue: item.selectedValue,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        });
      }
    }
  }

  // ===== 兜底：无 role 的自定义控件 =====
  // 现代前端框架的自定义下拉/菜单常常是纯 div/span，不带任何 role，
  // 只按 role 采集会整个漏掉（实测某后台的时间维度菜单就是这种结构）。
  // 这里补扫「指针光标 + 叶子节点」作为启发式候选，并加硬上限控制开销：
  // 先做便宜判断，只有通过筛选的元素才算 getComputedStyle。
  const FALLBACK_MAX = 20;
  const FALLBACK_SCAN_MAX = 3000;
  let scanned = 0;
  let fallbackCount = 0;
  if (items.length < maxResults) {
    for (const el of document.querySelectorAll('*')) {
      if (fallbackCount >= FALLBACK_MAX || scanned >= FALLBACK_SCAN_MAX) break;
      if (items.length >= maxResults) break;
      scanned += 1;
      // 有 role 的元素归主循环管，这里只管没有 role 的
      if (roleOf(el)) continue;
      if (el.children.length !== 0) continue;
      const rawText = (el.textContent || '').trim();
      if (!rawText || rawText.length > 60) continue;
      if (['password', 'file', 'hidden'].includes(el.type)) continue;
      const fr = el.getBoundingClientRect();
      if (fr.width < 8 || fr.height < 8) continue;
      if (fr.bottom < 0 || fr.right < 0 || fr.top > innerHeight || fr.left > innerWidth) continue;
      if (!visible(el)) continue;
      // 到这里候选已经很少了，再算样式
      if (getComputedStyle(el).cursor !== 'pointer') continue;

      fallbackCount += 1;
      const label = rawText.replace(/\s+/g, ' ').slice(0, 120);
      const item = {
        node: identity(el),
        index: items.length,
        tag: el.tagName.toLowerCase(),
        // 用 clickable 而不是 button：不谎报语义，调用方要按启发式对待
        role: 'clickable',
        name: label,
        text: label,
        type: el.getAttribute('type'),
        value: 'value' in el ? String(el.value === undefined ? '' : el.value) : '',
        href: el.getAttribute('href'),
        placeholder: el.getAttribute('placeholder'),
        selector: selectorOf(el),
        disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
        readOnly: Boolean(el.readOnly) || el.getAttribute('aria-readonly') === 'true',
        // 明确标注这是启发式条目，不是按 role 采集到的
        heuristic: true,
        x: Math.round(fr.x),
        y: Math.round(fr.y),
        width: Math.round(fr.width),
        height: Math.round(fr.height),
      };
      if (withGuards) {
        const guard = guardOf(el);
        item.guard = guard;
        if (guard !== null) cache.guards.set(item.node, guard);
      }
      items.push(item);
    }
  }

  // 页面级指纹：用来判断「决策时的页面」和「执行时的页面」是否还是同一个
  const formState = [...document.querySelectorAll('input,textarea,select')]
    .filter((e) => !['password', 'file', 'hidden'].includes(e.type))
    .map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled].join('~'))
    .join('|');

  const marker = [
    location.href,
    document.title,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    document.querySelectorAll('*').length,
    formState,
  ].join('\u0002');

  // 把指纹函数挂到缓存上，供后续注入（click / fill）重算比对。
  // 闭包引用的是同一个 cache 对象，不会额外持有旧状态。
  cache.guardOf = guardOf;

  // 与「快照那一刻」的指纹比对。元素还在、但自身属性已被改写时要说出来——
  // 这正是「决策时看到的」和「现在要操作的」不是同一个东西的典型情形。
  // 前 13 段是元素自身属性，第 14 段是邻近上下文文本（后者变化频繁，单独区分）。
  cache.staleCheck = (node, el) => {
    const out = { stale: false, staleFields: [], contextChanged: false };
    if (node == null || !cache.guards) return out;
    const stored = cache.guards.get(node);
    const current = guardOf(el);
    if (!stored || !current || stored === current) return out;
    const FIELDS = [
      'node', 'role', 'name', 'value', 'checked', 'selectedIndex', 'readOnly',
      'disabled', 'aria-disabled', 'aria-expanded', 'aria-checked', 'aria-selected',
      'href', 'context',
    ];
    const before = stored.split('\u0001');
    const now = current.split('\u0001');
    for (let i = 0; i < Math.max(before.length, now.length); i += 1) {
      if (before[i] === now[i]) continue;
      const field = FIELDS[i] || 'field' + i;
      if (field === 'context') out.contextChanged = true;
      else {
        out.stale = true;
        out.staleFields.push(field);
      }
    }
    return out;
  };

  // 视口内可见文本：给调用方做页面上下文。屏幕外的正文不进上下文，避免上下文被撑爆。
  const words = [];
  let textLen = 0;
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node;
    while ((node = walker.nextNode()) && textLen < 4000) {
      const value = (node.textContent || '').trim();
      const parent = node.parentElement;
      if (!value || !parent) continue;
      if (parent.closest('script,style,noscript,template')) continue;
      if (!visible(parent)) continue;
      range.selectNodeContents(node);
      const tr = range.getBoundingClientRect();
      if (tr.width > 0 && tr.height > 0 && tr.bottom > 0 && tr.top < innerHeight && tr.right > 0 && tr.left < innerWidth) {
        words.push(value);
        textLen += value.length;
      }
    }
  }

  const scrollHeight = document.documentElement.scrollHeight;
  return {
    url: location.href,
    title: document.title,
    marker,
    pageText: words.join('\n').slice(0, 4000),
    // 页面比视口高时，调用方据此判断该不该滚动
    scroll: {
      y: Math.round(scrollY),
      height: scrollHeight,
      viewport: innerHeight,
      canScrollUp: scrollY > 0,
      canScrollDown: scrollY + innerHeight < scrollHeight - 2,
    },
    count: items.length,
    // 被 max 截断掉的候选数量：非 0 说明还有元素没列出来
    omitted,
    items,
  };
}

async function snapshot(params = {}) {
  const tabId = await resolveTabId(params);
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanPage,
    args: [{ max: params.max || 80 }],
  });
  const page = result?.[0]?.result || { url: '', title: '', marker: '', items: [] };
  return {
    tabId: String(tabId),
    url: page.url,
    title: page.title,
    marker: page.marker,
    pageText: page.pageText || '',
    scroll: page.scroll || null,
    count: page.items.length,
    omitted: page.omitted || 0,
    items: page.items,
  };
}

// 动作后等页面稳定。
// 计时必须放在扩展侧：页面里的 setTimeout 在后台标签会被 Chrome 节流到约 1 秒，
// 用它做轮询会把 120ms 的等待拖成 800ms+。页面里只装 MutationObserver 记录变动。
async function waitForSettle(tabId, maxMs) {
  const cap = Math.max(0, Math.min(Number(maxMs) || 0, 3000));
  if (!cap) return { changed: false, waitedMs: 0 };
  const started = Date.now();
  const first = Math.min(cap, 60);
  await sleep(first);
  let mutated = await readMutationFlag(tabId);
  // 前 60ms 没动静，再给剩下的时间一次机会；有动静就提前结束
  if (!mutated && cap > first) {
    await sleep(cap - first);
    mutated = await readMutationFlag(tabId);
  }
  return { changed: mutated, waitedMs: Date.now() - started };
}

// 读取页面上的变动计数（由 pageMarker 里的观察器维护）
async function readMutationFlag(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const m = window.__sbcMut;
        return m ? m.count > 0 : false;
      },
    });
    return Boolean(r?.[0]?.result);
  } catch {
    return false;
  }
}

// 轻量页面指纹：只用于判断「动作前后页面是否变化」，不做全量扫描。
// 顺带装好变动观察器并清零计数，供动作后的等待判断是否该提前结束。
async function pageMarker(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body ? document.body.innerText || '' : '';
        // 表单值也算页面状态：select/checkbox 的改动不会改变节点数或文本长度
        const forms = [...document.querySelectorAll('input,textarea,select')]
          .filter((e) => !['password', 'file', 'hidden'].includes(e.type))
          .map((e) => e.value + ':' + (e.checked === undefined ? '' : e.checked))
          .join('|')
          .slice(0, 2000);
        // 变动观察器：幂等安装，每次调用清零计数
        if (!window.__sbcMut) {
          const state = { count: 0 };
          window.__sbcMut = state;
          try {
            new MutationObserver(() => {
              state.count += 1;
            }).observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });
          } catch {
            /* 少数页面不允许观察，此时 count 恒为 0，等待会走满上限 */
          }
        }
        window.__sbcMut.count = 0;
        return {
          url: location.href,
          title: document.title,
          marker: [
            location.href,
            document.title,
            document.querySelectorAll('*').length,
            text.length,
            scrollX,
            scrollY,
            forms,
          ].join('|'),
        };
      },
    });
    return r?.[0]?.result || { url: '', title: '', marker: '' };
  } catch {
    return { url: '', title: '', marker: '' };
  }
}

// 解析点击目标并算出屏幕坐标。
// node 走页面内的稳定编号缓存；index 走与 snapshot 完全相同的扫描逻辑
// （修复原先只按几何过滤、漏掉可见性与去重导致的编号错位）。
// 把 node / index 统一解析成稳定编号。index 走与 snapshot 完全相同的扫描逻辑
// （修复原先只按几何过滤、漏掉可见性与去重导致的编号错位）。
// 返回 null 表示调用方给的是 selector/text，需要各自再解析。
async function resolveNode(tabId, params) {
  if (params.node != null) return params.node;
  if (typeof params.index !== 'number') return null;
  const scan = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanPage,
    args: [{ max: params.index + 1, guards: false }],
  });
  const items = scan?.[0]?.result?.items || [];
  const hit = items[params.index];
  if (!hit) {
    throw new Error(`index ${params.index} out of range (page has ${items.length} interactive elements)`);
  }
  return hit.node;
}

async function resolveClickTarget(tabId, params) {
  const node = await resolveNode(tabId, params);
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts) => {
      const cache = window.__sbcScan;
      let el = null;
      let how = '';
      if (opts.node != null) {
        el = cache && cache.nodes ? cache.nodes.get(opts.node) : null;
        how = 'node';
      }
      if (!el && opts.selector) {
        el = document.querySelector(opts.selector);
        how = 'selector';
      }
      if (!el && opts.text) {
        const all = Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],span,div'));
        el =
          all.find((n) => (n.innerText || n.textContent || '').trim() === opts.text) ||
          all.find((n) => (n.innerText || n.textContent || '').trim().includes(opts.text)) ||
          null;
        how = 'text';
      }
      if (!el) return { ok: false, error: 'element not found' };
      if (!el.isConnected) return { ok: false, error: 'element is detached from the document' };

      const stale = cache && cache.staleCheck ? cache.staleCheck(opts.node, el) : {};

      // option 没法用坐标点（原生下拉的选项不在普通命中测试里），
      // 映射成「给父 select 赋值」，由调用方在记录前置状态之后再执行。
      if (el.tagName === 'OPTION') {
        const parent = el.closest('select');
        if (!parent) return { ok: false, error: 'option has no parent select' };
        if (parent.disabled || el.disabled) return { ok: false, error: 'target is disabled' };
        return {
          ok: true,
          kind: 'select',
          how,
          selectNode: cache && cache.ids ? cache.ids.get(parent) : null,
          optionValue: String(el.value),
          tag: 'option',
          name: (el.label || el.textContent || '').trim().slice(0, 120),
          currentValue: String(parent.value),
          stale: Boolean(stale.stale),
          staleFields: stale.staleFields || [],
          contextChanged: Boolean(stale.contextChanged),
        };
      }

      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { ok: false, error: 'element has no visible box' };
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // 遮挡检测：中心点被别的元素盖住时，点击落不到目标上
      const top = document.elementFromPoint(cx, cy);
      const occluded = !(top === el || el.contains(top) || (top && top.contains(el)));
      const text = (el.innerText || el.textContent || '').trim().slice(0, 120);
      const name = el.getAttribute('aria-label') || el.getAttribute('title') || text;
      return {
        ok: true,
        how,
        x: cx,
        y: cy,
        tag: el.tagName.toLowerCase(),
        name: String(name).slice(0, 120),
        text,
        occluded,
        coveredBy: occluded && top ? top.tagName.toLowerCase() : null,
        disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
        stale: Boolean(stale.stale),
        staleFields: stale.staleFields || [],
        contextChanged: Boolean(stale.contextChanged),
      };
    },
    args: [{ node: node == null ? null : node, selector: params.selector || null, text: params.text || null }],
  });
  const value = result?.[0]?.result;
  if (!value?.ok) throw new Error(value?.error || 'click failed');
  return value;
}

async function click(params = {}) {
  const tabId = await resolveTabId(params);
  const { selector, text, index, node } = params;
  if (selector == null && text == null && index == null && node == null) {
    throw new Error('click requires node | index | selector | text');
  }
  const target = await resolveClickTarget(tabId, params);
  if (target.disabled) throw new Error(`target is disabled: ${target.name || target.tag}`);
  if (target.occluded) {
    throw new Error(`target is covered by <${target.coveredBy}>; scroll or dismiss the overlay first`);
  }

  const before = await pageMarker(tabId);

  // option 走「给父 select 赋值」，不派发鼠标事件
  if (target.kind === 'select') {
    const applied = await chrome.scripting.executeScript({
      target: { tabId },
      func: (selectNode, val) => {
        const cache = window.__sbcScan;
        const el = cache && cache.nodes ? cache.nodes.get(selectNode) : null;
        if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'parent select is gone; re-run snapshot' };
        let proto = Object.getPrototypeOf(el);
        let setter = null;
        while (proto && !setter) {
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) setter = desc.set;
          proto = Object.getPrototypeOf(proto);
        }
        if (setter) setter.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: String(el.value) };
      },
      args: [target.selectNode, target.optionValue],
    });
    const a = applied?.[0]?.result;
    if (!a?.ok) throw new Error(a?.error || 'select failed');
    const settleMs = params.settle === undefined ? 120 : Number(params.settle) || 0;
    const settle = await waitForSettle(tabId, settleMs);
    const afterSel = await pageMarker(tabId);
    return {
      tabId: String(tabId),
      ok: true,
      via: 'select',
      how: target.how,
      tag: target.tag,
      name: target.name,
      previousValue: target.currentValue,
      value: a.value,
      stale: target.stale,
      staleFields: target.staleFields,
      contextChanged: target.contextChanged,
      changed: before.marker !== afterSel.marker,
      settleMs: settle.waitedMs,
      settleSawMutation: settle.changed,
      urlChanged: before.url !== afterSel.url,
      url: afterSel.url,
    };
  }

  // 优先走 CDP 可信输入：合成事件不带 isTrusted，对做校验的站点点不动。
  // 注意：后台标签页只收得到 mouseMoved、收不到 mousePressed，所以可信模式
  // 需要先把标签提到前台（Page.bringToFront）。这是 --trusted 的已知代价。
  let via = 'synthetic';
  if (params.trusted === true) {
    try {
      await ensureDebugger(tabId);
      await chrome.debugger.sendCommand({ tabId }, 'Page.bringToFront');
      const base = { x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 };
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: target.x, y: target.y,
      });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
      via = 'cdp';
    } catch {
      via = 'synthetic';
    }
  }
  if (via === 'synthetic') {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return false;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }),
          );
        }
        return true;
      },
      args: [target.x, target.y],
    });
  }
  // 等页面稳定再取后置指纹：异步渲染的站点不会立刻反映变化，直接比较会误报 changed=false。
  // 默认 120ms 上限；传 settle: 0 可关闭，传更大的值可等更久。
  const settleMs = params.settle === undefined ? 120 : Number(params.settle) || 0;
  const settle = await waitForSettle(tabId, settleMs);
  const after = await pageMarker(tabId);
  return {
    tabId: String(tabId),
    ok: true,
    via,
    how: target.how,
    tag: target.tag,
    name: target.name,
    x: Math.round(target.x),
    y: Math.round(target.y),
    // stale：元素的自身属性相对「快照那一刻」变了（名称/值/勾选/禁用等）。
    // 这通常意味着你要点的已经不是当初看到的那个东西，建议重新 snapshot 再决定。
    // contextChanged：只是邻近上下文文本变了，元素本身没变，一般是安全的。
    stale: target.stale,
    staleFields: target.staleFields,
    contextChanged: target.contextChanged,
    // changed：URL、标题、节点数、文本长度或滚动位置有变化。
    // 已经等过 settle 毫秒，因此对异步渲染的站点也基本可靠；仍为 false 时可用 sbc wait 再确认。
    changed: before.marker !== after.marker,
    settleMs: settle.waitedMs,
    settleSawMutation: settle.changed,
    urlChanged: before.url !== after.url,
    url: after.url,
  };
}

async function fill(params = {}) {
  const tabId = await resolveTabId(params);
  const value = params.value ?? params.text ?? '';
  const { selector, index, node } = params;
  if (selector == null && node == null && index == null) {
    throw new Error('fill requires node | index | selector');
  }
  const resolved = await resolveNode(tabId, params);
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (opts, val) => {
      try {
        const cache = window.__sbcScan;
        let el = null;
        let how = '';
        if (opts.node != null) {
          el = cache && cache.nodes ? cache.nodes.get(opts.node) : null;
          how = 'node';
        }
        if (!el && opts.selector) {
          el = document.querySelector(opts.selector);
          how = 'selector';
        }
        if (!el) return { ok: false, error: 'element not found' };
        if (!el.isConnected) return { ok: false, error: 'element is detached from the document' };
        if (el.matches(':disabled') || el.readOnly || el.getAttribute('aria-readonly') === 'true') {
          return { ok: false, error: 'element is not editable (disabled or read-only)' };
        }
        // 勾选类控件没有「填值」语义，写 value 不会改变勾选状态，容易误导
        if (el.type === 'checkbox' || el.type === 'radio') {
          return { ok: false, error: 'use click to toggle a checkbox or radio, not fill' };
        }
        const stale = cache && cache.staleCheck ? cache.staleCheck(opts.node, el) : {};
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if ('value' in el) {
          // 沿原型链找 value 的 setter：input / textarea / select 各有各的原型，
          // 写死 HTMLInputElement.prototype 对 select 会抛 Illegal invocation
          let proto = Object.getPrototypeOf(el);
          let setter = null;
          while (proto && !setter) {
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) setter = desc.set;
            proto = Object.getPrototypeOf(proto);
          }
          if (setter) setter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          return { ok: false, error: 'element not fillable' };
        }
        const text = (el.innerText || el.textContent || '').trim().slice(0, 120);
        const name = el.getAttribute('aria-label') || el.getAttribute('title') || text;
        return {
          ok: true,
          how,
          tag: el.tagName.toLowerCase(),
          name: String(name).slice(0, 120),
          value: 'value' in el ? String(el.value === undefined ? '' : el.value) : text,
          stale: Boolean(stale.stale),
          staleFields: stale.staleFields || [],
          contextChanged: Boolean(stale.contextChanged),
        };
      } catch (e) {
        return { ok: false, error: 'fill threw: ' + String((e && e.message) || e).slice(0, 160) };
      }
    },
    args: [{ node: resolved == null ? null : resolved, selector: selector || null }, String(value)],
  });
  const v = result?.[0]?.result;
  if (!v?.ok) throw new Error(v?.error || 'fill failed');
  return {
    tabId: String(tabId),
    ok: true,
    how: v.how,
    tag: v.tag,
    name: v.name,
    value: v.value,
    stale: v.stale,
    staleFields: v.staleFields,
    contextChanged: v.contextChanged,
  };
}


async function typeText(params = {}) {
  const tabId = await resolveTabId(params);
  const text = params.text ?? params.value ?? '';
  if (!text && !params.ctrlKey) throw new Error('typeText requires text');
  await ensureDebugger(tabId);
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: "(() => { const ta=document.querySelector('textarea.xterm-helper-textarea'); if(ta){ ta.focus(); } return !!ta; })()",
    });
  } catch {}
  // Ctrl+C special
  if (params.ctrlKey && (params.key === 'c' || params.key === 'C' || text === '\u0003' || text === '\x03')) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', modifiers: 2, windowsVirtualKeyCode: 67, code: 'KeyC', key: 'c',
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 67, code: 'KeyC', key: 'c',
    });
    return { tabId: String(tabId), ok: true, ctrlC: true };
  }
  const s = String(text || '');
  // Prefer insertText first (fast path)
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: s });
  } catch {
    for (const ch of s) {
      if (ch === '\n') {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter',
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter',
        });
      } else {
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyDown', text: ch, unmodifiedText: ch, key: ch,
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'char', text: ch, unmodifiedText: ch, key: ch,
        });
        await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key: ch,
        });
      }
    }
  }
  if (params.enter === true || params.submit === true) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r',
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'char', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter',
    });
  }
  return { tabId: String(tabId), ok: true, len: s.length };
}

async function press(params = {}) {
  const tabId = await resolveTabId(params);
  const key = params.key || 'Enter';
  const selector = params.selector;
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, k) => {
      const el = sel ? document.querySelector(sel) : document.activeElement || document.body;
      if (!el) return { ok: false, error: 'no target' };
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
      return { ok: true };
    },
    args: [selector || null, key],
  });
  const v = result?.[0]?.result;
  if (!v?.ok) throw new Error(v?.error || 'press failed');
  return { tabId: String(tabId), key, ok: true };
}

async function waitFor(params = {}) {
  const tabId = await resolveTabId(params);
  const selector = params.selector;
  const text = params.text;
  const timeout = params.timeoutMs || 15000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, txt) => {
        if (sel && document.querySelector(sel)) return { ok: true, via: 'selector' };
        if (txt && document.body && (document.body.innerText || '').includes(txt)) return { ok: true, via: 'text' };
        return { ok: false };
      },
      args: [selector || null, text || null],
    });
    if (result?.[0]?.result?.ok) {
      return { tabId: String(tabId), ...result[0].result, waitedMs: Date.now() - start };
    }
    await sleep(250);
  }
  throw new Error(`waitFor timeout after ${timeout}ms`);
}

async function content(params = {}) {
  const tabId = await resolveTabId(params);
  const tab = await chrome.tabs.get(tabId);
  let text = '';
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (document.body?.innerText || '').slice(0, 8000),
    });
    text = result?.[0]?.result || '';
  } catch (e) {
    text = '';
  }
  return {
    tabId: String(tabId),
    title: tab.title || '',
    url: tab.url || '',
    text,
  };
}

async function ensureDebugger(tabId) {
  if (state.debuggerAttached.has(tabId)) return;
  // net-capture 可能已 attach 但未登记；或 attach 失败需重试
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    const msg = String(e?.message || e || '');
    // Already attached：当作成功
    if (!/already attached|Another debugger/i.test(msg)) {
      throw e;
    }
  }
  state.debuggerAttached.add(tabId);
}

/**
 * 后台截图：优先 CDP Page.captureScreenshot，不需要把标签切成 active，
 * 也不会 windows.focus。失败时再降级 captureVisibleTab（会短暂切标签并恢复）。
 */
async function screenshotViaDebugger(tabId) {
  await ensureDebugger(tabId);
  // 部分页面需先启用 Page domain
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
  } catch {}
  const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
  });
  const b64 = result?.data || '';
  if (!b64) throw new Error('Page.captureScreenshot returned empty data');
  return b64;
}

async function screenshotViaVisibleTab(tabId, params = {}) {
  // captureVisibleTab 要求目标标签在所属窗口内是当前可见标签。
  // 仅作 fallback：临时切 active，截完恢复；绝不默认 windows.focus。
  const tab = await chrome.tabs.get(tabId);
  let previousActiveId = null;
  let switched = false;
  try {
    if (!tab.active) {
      try {
        const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        if (prev?.id != null && prev.id !== tabId) previousActiveId = prev.id;
      } catch {}
      await chrome.tabs.update(tabId, { active: true });
      switched = true;
      await sleep(150);
    }
    if (params.focus === true && tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {}

  let dataUrl = '';
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (switched && previousActiveId != null && params.focus !== true) {
      try {
        await chrome.tabs.update(previousActiveId, { active: true });
      } catch {}
    }
  }
  return {
    base64: (dataUrl || '').split(',')[1] || '',
    restoredActiveTabId: previousActiveId != null ? String(previousActiveId) : null,
  };
}

async function screenshot(params = {}) {
  const tabId = await resolveTabId(params);
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url || '')) {
    throw new Error('restricted url cannot be screenshot via debugger; open a normal page first');
  }

  // 仅当显式 focus 时抢系统前台（与 claim 一致）；默认绝不 focus
  if (params.focus === true && tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {}
  }

  // 1) 优先 CDP：不切换 active 标签，不抢用户当前浏览
  let method = 'debugger';
  let base64 = '';
  let restoredActiveTabId = null;
  let fallbackError = null;
  try {
    base64 = await screenshotViaDebugger(tabId);
  } catch (e) {
    fallbackError = String(e?.message || e);
    method = 'captureVisibleTab';
    const fb = await screenshotViaVisibleTab(tabId, params);
    base64 = fb.base64;
    restoredActiveTabId = fb.restoredActiveTabId;
  }

  if (!base64) {
    throw new Error(
      `screenshot failed${fallbackError ? ` (debugger: ${fallbackError})` : ''}`,
    );
  }

  return {
    tabId: String(tabId),
    mime: 'image/png',
    base64,
    dataUrlPrefix: 'data:image/png;base64,',
    method,
    restoredActiveTabId,
    debuggerError: method === 'captureVisibleTab' ? fallbackError : null,
  };
}

// ── Network capture via chrome.debugger ──────────────────────────────────────
const _netCapture = new Map(); // tabId → { requests: [], navigations: [] }

async function startNetCapture(tabId) {
  const id = Number(tabId);
  if (Number.isNaN(id)) throw new Error('invalid tabId');
  // detach if already attached
  try { await chrome.debugger.detach({ tabId: id }); } catch {}
  await chrome.debugger.attach({ tabId: id }, '1.3');
  _netCapture.set(id, { requests: [], navigations: [] });
  await chrome.debugger.sendCommand({ tabId: id }, 'Network.enable', {});
  return { ok: true, tabId: String(id), status: 'capturing' };
}

async function stopNetCapture(tabId) {
  const id = Number(tabId);
  const data = _netCapture.get(id) || { requests: [], navigations: [] };
  _netCapture.delete(id);
  try { await chrome.debugger.detach({ tabId: id }); } catch {}
  return { ok: true, tabId: String(id), requests: data.requests, navigations: data.navigations };
}

function getNetCapture(tabId) {
  const id = Number(tabId);
  const data = _netCapture.get(id) || { requests: [], navigations: [] };
  return { ok: true, tabId: String(id), requests: data.requests, navigations: data.navigations };
}

// CDP event listener for network capture
chrome.debugger.onEvent.addListener((source, method, params) => {
  const data = _netCapture.get(source.tabId);
  if (!data) return;
  if (method === 'Network.requestWillBeSent') {
    const r = params.request;
    data.requests.push({
      requestId: params.requestId,
      url: r.url,
      method: r.method,
      postData: r.postData ? r.postData.slice(0, 500) : null,
      headers: Object.fromEntries(
        Object.entries(r.headers || {}).filter(([k]) =>
          ['content-type', 'authorization', 'x-requested-with', 'accept'].includes(k.toLowerCase())
        )
      ),
    });
  }
  if (method === 'Network.responseReceived') {
    const req = data.requests.find(r => r.requestId === params.requestId);
    if (req) req.status = params.response.status;
  }
});
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读 cookie（含 HttpOnly）。
 *
 * 走 debugger 已有的 CDP 能力（Network.getCookies），因此**不需要 manifest 的 cookies 权限**，
 * 也就不会触发 Chrome 的权限变更重新授权。这是"复用用户已登录会话"取凭证的通用手段：
 * 普通 JS 的 document.cookie 看不到 HttpOnly，而 DevTools 能看到正是因为 DevTools 走 CDP。
 *
 * params: { name?, url?, tabId? }  —— 不给 url 时用目标标签当前地址。
 * 返回 cookies 明细；调用方负责不要把 value 打进日志。
 */
async function cookieGet(params = {}) {
  const tabId = await resolveTabId(params);
  let url = params.url;
  if (!url) {
    const tab = await chrome.tabs.get(tabId);
    url = tab?.url || '';
  }
  if (!url || !/^https?:/i.test(url)) {
    throw new Error(`cookieGet 需要一个 http(s) url（当前：${url || '空'}）`);
  }
  await ensureDebugger(tabId);
  const res = await chrome.debugger.sendCommand({ tabId }, 'Network.getCookies', { urls: [url] });
  const all = res?.cookies || [];
  const picked = params.name ? all.filter((c) => c.name === params.name) : all;
  return {
    tabId: String(tabId),
    url,
    count: picked.length,
    cookies: picked.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
    })),
  };
}

async function handleCommand(cmd) {
  await ensureStateReady();
  const type = cmd?.type;
  const params = cmd?.params || {};
  switch (type) {
    case 'ping':
      return {
        pong: true,
        extensionId: chrome.runtime.id,
        taskActive: state.taskActive,
        taskTitle: state.taskTitle,
        claimedTabId: state.claimedTabId != null ? String(state.claimedTabId) : null,
        taskGroupId: state.taskGroupId,
        taskWindowId: state.taskWindowId != null ? String(state.taskWindowId) : null,
        preferTaskWindow: state.preferTaskWindow,
      };
    case 'openTabs':
      return { tabs: await listOpenTabs() };
    case 'claimTab':
      return claimTab(params.tabId, params.title, params);
    case 'claimCurrentTab':
      return claimCurrentTab(params.title, params);
    case 'startTask':
      return startTask(params.title, params);
    case 'endTask':
      return endTask(Boolean(params.closeGroup), Boolean(params.closeTabs));
    case 'reloadExtension':
      return reloadExtension();
    case 'setGroupTitle':
      if (state.taskGroupId == null) throw new Error('no task group');
      state.taskTitle = params.title || state.taskTitle;
      await chrome.tabGroups.update(state.taskGroupId, { title: state.taskTitle });
      return { title: state.taskTitle, groupId: state.taskGroupId };
    case 'newTab':
      return newTab(params);
    case 'closeTab':
      return closeTab(params);
    case 'goto':
      return goto(params);
    case 'reload':
      return reload(params);
    case 'eval':
      return evalCmd(params);
    case 'cookieGet':
      return cookieGet(params);
    case 'snapshot':
      return snapshot(params);
    case 'click':
      return click(params);
    case 'fill':
      return fill(params);
    case 'press':
      return press(params);
    case 'typeText':
      return typeText(params);
    case 'waitFor':
      return waitFor(params);
    case 'content':
      return content(params);
    case 'screenshot':
      return screenshot(params);
    case 'startNetCapture':
      return startNetCapture(params.tabId || state.claimedTabId);
    case 'stopNetCapture':
      return stopNetCapture(params.tabId || state.claimedTabId);
    case 'getNetCapture':
      return getNetCapture(params.tabId || state.claimedTabId);
    default:
      throw new Error(`unknown command: ${type}`);
  }
}

async function postResult(id, ok, result, error) {
  try {
    await bridgeFetch('/ext/result', {
      method: 'POST',
      body: JSON.stringify(ok ? { id, ok: true, result } : { id, ok: false, error: error || 'error' }),
    });
  } catch (e) {
    console.warn('postResult failed', e);
  }
}

async function pollLoop() {
  // 防重入，但如果上一次已经卡死超过 POLL_STALL_MS，就放行并换新一代 loop。
  // 旧 loop 恢复后会在下一次循环条件里发现 gen 不匹配，自行退出。
  if (_pollRunning && Date.now() - _pollTick < POLL_STALL_MS) return;
  if (_pollRunning) {
    console.warn('[stable-chrome] pollLoop 卡住超过', POLL_STALL_MS, 'ms，强制换新 loop');
  }
  const gen = ++_pollGen;
  _pollRunning = true;
  _pollTick = Date.now();
  console.log('[stable-chrome] pollLoop started gen=', gen);
  while (!state.pollAbort && gen === _pollGen) {
    _pollTick = Date.now();
    try {
      await hello();
      const data = await bridgeFetch(`/ext/poll?waitMs=${POLL_WAIT_MS}`, { method: 'GET' });
      const cmd = data?.cmd;
      if (!cmd) {
        await sleep(200);
        continue;
      }
      console.log('[stable-chrome] cmd', cmd.id, cmd.type);
      try {
        const result = await handleCommand(cmd);
        await postResult(cmd.id, true, result);
      } catch (e) {
        await postResult(cmd.id, false, null, String(e?.message || e));
      }
    } catch (e) {
      console.warn('[stable-chrome] poll error', e);
      await sleep(1500);
    }
  }
  if (gen === _pollGen) _pollRunning = false;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[stable-chrome] installed', chrome.runtime.id);
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[stable-chrome] startup');
});

// keep-alive alarm：每 15s 触发一次，唤醒 SW 并确保 pollLoop 在跑
chrome.alarms.create('stable-chrome-keepalive', { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'stable-chrome-keepalive') {
    hello().catch(() => {});
    // 无条件调用：pollLoop 自己判断是「还在正常跑」还是「已卡死需要换新」。
    // 早先这里写 `if (!_pollRunning)`，结果 loop 卡在 await 里时该判断恒不成立，
    // 保活反而彻底失效。
    pollLoop();
  }
});

// start poll loop
pollLoop();
