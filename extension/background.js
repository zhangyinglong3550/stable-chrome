/**
 * Stable Chrome Attach — MV3 service worker
 * Polls local bridge for commands and executes them against real Chrome tabs.
 */

const BRIDGE = 'http://127.0.0.1:19527';
const POLL_WAIT_MS = 25000;
const HELLO_EVERY_MS = 5000;
const DEFAULT_TASK_TITLE = 'Agent Task';
const STATE_STORAGE_KEY = 'stableChromeTaskState';

// SW 被 Chrome 挂起后，上下文重置，pollLoop 会停掉。
// alarm 唤醒时用此标志判断是否需要重新启动。
let _pollRunning = false;
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
  const res = await fetch(`${BRIDGE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
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
  // 仅当调用方显式传入 title 时才改名；缺省保持已有任务名 / 默认 Agent Task
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

async function endTask(closeGroup = false) {
  state.taskActive = false;
  const groupId = state.taskGroupId;
  if (closeGroup && groupId != null) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.groupId === groupId && tab.id != null) {
        try {
          await chrome.tabs.ungroup(tab.id);
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
  return { ended: true, closedGroup: Boolean(closeGroup), previousGroupId: groupId };
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

async function snapshot(params = {}) {
  const tabId = await resolveTabId(params);
  const max = params.max || 80;
  const items = await chrome.scripting.executeScript({
    target: { tabId },
    func: (maxResults) => {
      const selectors = [
        'button',
        'a[href]',
        'input',
        'textarea',
        'select',
        '[role="button"]',
        '[role="link"]',
        '[contenteditable="true"]',
      ];
      const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
      const seen = new Set();
      const items = [];
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const text = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 120);
        const key = [el.tagName, text, Math.round(r.x), Math.round(r.y)].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        // generate a reasonably stable selector
        let selector = el.tagName.toLowerCase();
        if (el.id) selector = `#${CSS.escape(el.id)}`;
        else if (el.name) selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
        items.push({
          index: items.length,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          placeholder: el.getAttribute('placeholder'),
          ariaLabel: el.getAttribute('aria-label'),
          text,
          href: el.getAttribute('href'),
          selector,
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        });
        if (items.length >= maxResults) break;
      }
      return items;
    },
    args: [max],
  });
  return { tabId: String(tabId), items: items?.[0]?.result || [] };
}

async function click(params = {}) {
  const tabId = await resolveTabId(params);
  const selector = params.selector;
  const text = params.text;
  const index = params.index;
  if (selector == null && text == null && index == null) {
    throw new Error('click requires selector | text | index');
  }
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, txt, idx) => {
      let el = null;
      if (typeof idx === 'number') {
        // rebuild snapshot order roughly
        const selectors = [
          'button',
          'a[href]',
          'input',
          'textarea',
          'select',
          '[role="button"]',
          '[role="link"]',
          '[contenteditable="true"]',
        ];
        const nodes = Array.from(document.querySelectorAll(selectors.join(','))).filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width >= 2 && r.height >= 2 && r.bottom >= 0 && r.right >= 0 && r.top <= innerHeight && r.left <= innerWidth;
        });
        el = nodes[idx] || null;
      } else if (sel) {
        el = document.querySelector(sel);
      } else if (txt) {
        const all = Array.from(document.querySelectorAll('button,a,[role="button"],[role="link"],span,div'));
        el =
          all.find((n) => (n.innerText || n.textContent || '').trim() === txt) ||
          all.find((n) => (n.innerText || n.textContent || '').trim().includes(txt)) ||
          null;
      }
      if (!el) return { ok: false, error: 'element not found' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: cx,
            clientY: cy,
          }),
        );
      }
      if (typeof el.click === 'function') {
        try {
          el.click();
        } catch {}
      }
      return {
        ok: true,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 120),
      };
    },
    args: [selector || null, text || null, typeof index === 'number' ? index : null],
  });
  const value = result?.[0]?.result;
  if (!value?.ok) throw new Error(value?.error || 'click failed');
  return { tabId: String(tabId), ...value };
}

async function fill(params = {}) {
  const tabId = await resolveTabId(params);
  const selector = params.selector;
  const value = params.value ?? params.text ?? '';
  if (!selector) throw new Error('fill requires selector');
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: 'element not found' };
      el.focus();
      if ('value' in el) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.set) desc.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        return { ok: false, error: 'element not fillable' };
      }
      return { ok: true };
    },
    args: [selector, String(value)],
  });
  const v = result?.[0]?.result;
  if (!v?.ok) throw new Error(v?.error || 'fill failed');
  return { tabId: String(tabId), ok: true, selector, value: String(value) };
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
      return endTask(Boolean(params.closeGroup));
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
    case 'snapshot':
      return snapshot(params);
    case 'click':
      return click(params);
    case 'fill':
      return fill(params);
    case 'press':
      return press(params);
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
  if (_pollRunning) return; // 防重入
  _pollRunning = true;
  console.log('[stable-chrome] pollLoop started');
  while (!state.pollAbort) {
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
  _pollRunning = false;
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
    // SW 被 suspend 后上下文重置，_pollRunning 归 false，重新启动 loop
    if (!_pollRunning) {
      console.log('[stable-chrome] alarm revived pollLoop');
      pollLoop();
    }
  }
});

// start poll loop
pollLoop();
