/**
 * Stable Chrome Attach — MV3 service worker
 * Polls local bridge for commands and executes them against real Chrome tabs.
 */

const BRIDGE = 'http://127.0.0.1:19527';
const POLL_WAIT_MS = 25000;
const HELLO_EVERY_MS = 5000;

const state = {
  taskActive: false,
  taskTitle: 'Claude Task',
  taskGroupId: null,
  rootTabId: null,
  claimedTabId: null,
  pollAbort: false,
  debuggerAttached: new Set(), // tabId numbers
};

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

async function ensureTaskGroup(tabId, title) {
  if (title) state.taskTitle = title;
  const tab = await chrome.tabs.get(tabId);
  if (tab.groupId != null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    state.taskGroupId = tab.groupId;
    try {
      await chrome.tabGroups.update(tab.groupId, {
        title: state.taskTitle,
        color: 'blue',
        collapsed: false,
      });
    } catch {}
    return tab.groupId;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, {
    title: state.taskTitle,
    color: 'blue',
    collapsed: false,
  });
  state.taskGroupId = groupId;
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

async function claimTab(tabId, title) {
  const id = Number(tabId);
  if (Number.isNaN(id)) throw new Error('invalid tabId');
  const tab = await chrome.tabs.get(id);
  if (!tab) throw new Error('tab not found');
  state.claimedTabId = id;
  state.rootTabId = id;
  state.taskActive = true;
  const groupId = await ensureTaskGroup(id, title || state.taskTitle);
  try {
    await chrome.tabs.update(id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {}
  return {
    tabId: String(id),
    title: tab.title || '',
    url: tab.url || '',
    groupId,
    taskTitle: state.taskTitle,
  };
}

async function claimCurrentTab(title) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('没有活动标签页');
  return claimTab(String(tab.id), title);
}

async function startTask(title) {
  state.taskActive = true;
  if (title) state.taskTitle = title;
  let groupId = state.taskGroupId;
  if (state.claimedTabId != null) {
    groupId = await ensureTaskGroup(state.claimedTabId, state.taskTitle);
  } else {
    // create blank root tab for the task
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    state.claimedTabId = tab.id;
    state.rootTabId = tab.id;
    groupId = await ensureTaskGroup(tab.id, state.taskTitle);
  }
  return {
    taskActive: true,
    taskTitle: state.taskTitle,
    groupId,
    rootTabId: state.rootTabId != null ? String(state.rootTabId) : null,
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
  return { ended: true, closedGroup: Boolean(closeGroup), previousGroupId: groupId };
}

async function resolveTabId(params = {}) {
  if (params.tabId != null) return Number(params.tabId);
  if (state.claimedTabId != null) return state.claimedTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('no active tab');
  return tab.id;
}

async function newTab(params = {}) {
  const url = params.url || 'about:blank';
  const active = params.active !== false;
  const tab = await chrome.tabs.create({ url, active });
  if (state.taskActive) {
    await groupTabIfNeeded(tab.id);
  }
  state.claimedTabId = tab.id;
  return {
    tabId: String(tab.id),
    url: tab.pendingUrl || tab.url || url,
    groupId: state.taskGroupId,
  };
}

async function goto(params = {}) {
  const tabId = await resolveTabId(params);
  const url = params.url;
  if (!url) throw new Error('missing url');
  await chrome.tabs.update(tabId, { url, active: params.active !== false });
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
  await chrome.debugger.attach({ tabId }, '1.3');
  state.debuggerAttached.add(tabId);
}

async function screenshot(params = {}) {
  const tabId = await resolveTabId(params);
  // Prefer captureVisibleTab for simplicity (active window)
  const tab = await chrome.tabs.get(tabId);
  try {
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}
  await sleep(150);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  // store via bridge? return base64 for CLI to save
  const base64 = (dataUrl || '').split(',')[1] || '';
  return {
    tabId: String(tabId),
    mime: 'image/png',
    base64,
    dataUrlPrefix: 'data:image/png;base64,',
  };
}

async function handleCommand(cmd) {
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
      };
    case 'openTabs':
      return { tabs: await listOpenTabs() };
    case 'claimTab':
      return claimTab(params.tabId, params.title);
    case 'claimCurrentTab':
      return claimCurrentTab(params.title);
    case 'startTask':
      return startTask(params.title);
    case 'endTask':
      return endTask(Boolean(params.closeGroup));
    case 'setGroupTitle':
      if (state.taskGroupId == null) throw new Error('no task group');
      state.taskTitle = params.title || state.taskTitle;
      await chrome.tabGroups.update(state.taskGroupId, { title: state.taskTitle });
      return { title: state.taskTitle, groupId: state.taskGroupId };
    case 'newTab':
      return newTab(params);
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
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[stable-chrome] installed', chrome.runtime.id);
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[stable-chrome] startup');
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab?.id != null) await groupTabIfNeeded(tab.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === 'complete') await groupTabIfNeeded(tabId);
});

// keep-alive alarm
chrome.alarms.create('stable-chrome-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'stable-chrome-keepalive') {
    hello().catch(() => {});
  }
});

// start poll loop
pollLoop();
