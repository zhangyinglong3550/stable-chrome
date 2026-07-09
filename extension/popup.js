async function check() {
  document.getElementById('extId').textContent = chrome.runtime.id;
  const el = document.getElementById('bridge');
  try {
    const res = await fetch('http://127.0.0.1:19527/health', { cache: 'no-store' });
    const data = await res.json();
    if (data.ok) {
      el.innerHTML = data.extensionOnline
        ? '<span class="ok">在线（扩展已被识别）</span>'
        : '<span class="ok">Bridge 在线</span>（等待扩展 poll）';
    } else {
      el.innerHTML = '<span class="bad">Bridge 异常</span>';
    }
  } catch {
    el.innerHTML = '<span class="bad">Bridge 未启动</span>（运行 ./scripts/start-bridge.sh）';
  }
}

document.getElementById('retry').addEventListener('click', check);
check();
