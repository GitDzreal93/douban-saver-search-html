document.addEventListener('DOMContentLoaded', async () => {
  // ─── 建立长连接，防止 MV3 Service Worker 休眠（修复首次保存无响应）──
  const swPort = chrome.runtime.connect({ name: 'popup' });
  window.addEventListener('unload', () => { try { swPort.disconnect(); } catch (_) { } });

  const openSearchPage = () => chrome.tabs.create({ url: chrome.runtime.getURL('search.html') });
  document.getElementById('btn-open-search')?.addEventListener('click', openSearchPage);
  document.getElementById('btn-open-search-alt')?.addEventListener('click', openSearchPage);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isDouban = tab && tab.url && tab.url.includes('douban.com');

  if (!isDouban) {
    document.getElementById('main-content').style.display = 'none';
    document.getElementById('not-douban').style.display = 'block';
    return;
  }

  document.getElementById('page-title').textContent = tab.title || '（无标题）';
  document.getElementById('page-url').textContent = cleanUrl(tab.url);

  await refreshFolderDisplay();

  // Detect page count
  try {
    const pg = await chrome.runtime.sendMessage({ action: 'getPageCount', tabId: tab.id });
    const badge = document.getElementById('page-badge');
    const desc  = document.getElementById('page-desc');
    if (pg && pg.total > 1) {
      badge.textContent = `共 ${pg.total} 页`;
      badge.className = 'badge badge-multi';
      desc.textContent = `当前第 ${pg.current} 页，将全部保存`;
      document.getElementById('btn-save').textContent = `💾 保存全部 ${pg.total} 页`;
    }
  } catch(e) {}

  // Restore toggle states
  const opts = await chrome.storage.local.get({ mosaic: true, infobar: true, saveimgs: true });
  document.getElementById('opt-mosaic').checked   = opts.mosaic;
  document.getElementById('opt-infobar').checked  = opts.infobar;
  document.getElementById('opt-saveimgs').checked = opts.saveimgs;
  ['opt-mosaic','opt-infobar','opt-saveimgs'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
      chrome.storage.local.set({
        mosaic:    document.getElementById('opt-mosaic').checked,
        infobar:   document.getElementById('opt-infobar').checked,
        saveimgs:  document.getElementById('opt-saveimgs').checked
      });
    });
  });

  // Change folder button
  document.getElementById('btn-change-folder').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'resetFolder' });
    await refreshFolderDisplay();
    document.getElementById('status').textContent = '📁 下次保存时重新选择文件夹';
    document.getElementById('status').className = 'status';
  });

  document.getElementById('link-shortcuts').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  document.getElementById('btn-save').addEventListener('click', () => triggerSave(tab));
});

async function refreshFolderDisplay() {
  const info = await chrome.runtime.sendMessage({ action: 'getFolder' });
  const pathEl    = document.getElementById('folder-path');
  const changeBtn = document.getElementById('btn-change-folder');
  // folderSub===null means never set; ''=Downloads root; 'abc'=Downloads/abc
  if (info && info.sub !== null && info.sub !== undefined && info.label) {
    pathEl.textContent = info.sub === '' ? '📁 Downloads（根目录）' : '📁 Downloads/' + info.label;
    pathEl.className = 'folder-path';
    changeBtn.style.display = 'block';
  } else {
    pathEl.textContent = '首次保存时弹窗选择，之后自动保存到同处';
    pathEl.className = 'folder-path unset';
    changeBtn.style.display = 'none';
  }
}

function cleanUrl(url) {
  try {
    const u = new URL(url);
    ['_spm_id','_i','spm','from','fr','source','ref','referer',
     'utm_source','utm_medium','utm_campaign','utm_content','utm_term'].forEach(k => u.searchParams.delete(k));
    for (const key of [...u.searchParams.keys()]) { if (key.startsWith('_')) u.searchParams.delete(key); }
    return u.searchParams.toString() ? u.toString() : u.origin + u.pathname;
  } catch { return url.split('?')[0]; }
}

async function triggerSave(tab) {
  const btn      = document.getElementById('btn-save');
  const status   = document.getElementById('status');
  const progress = document.getElementById('progress');
  const bar      = document.getElementById('progress-bar');

  btn.disabled = true;
  btn.innerHTML = '⏳ 正在保存...';
  status.textContent = '';
  status.className = 'status';
  progress.style.display = 'block';
  bar.style.width = '10%';

  let pct = 10;
  const tick = setInterval(() => { pct = Math.min(pct + 7, 85); bar.style.width = pct + '%'; }, 700);

  try {
    // 发送保存消息，首次无响应时重试一次（修复 MV3 SW 冷启动时序）
    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      result = await chrome.runtime.sendMessage({
        action: 'save', tabId: tab.id,
        mosaic:   document.getElementById('opt-mosaic').checked,
        infobar:  document.getElementById('opt-infobar').checked,
        saveimgs: document.getElementById('opt-saveimgs').checked
      });
      if (result) break;
      console.log('[豆瓣证据保存] 首次无响应，重试第', attempt, '次');
      await new Promise(r => setTimeout(r, 500));
    }

    clearInterval(tick);
    bar.style.width = '100%';

    if (result && result.success) {
      status.textContent = '✅ ' + (result.message || '保存成功！');
      status.className = 'status success';
      btn.innerHTML = '✅ 完成';
      await refreshFolderDisplay();
    } else {
      throw new Error(result?.error || '未知错误');
    }
  } catch(e) {
    clearInterval(tick);
    bar.style.width = '0%';
    status.textContent = '❌ 保存失败：' + e.message;
    status.className = 'status error';
    btn.innerHTML = '💾 重新保存';
    btn.disabled = false;
  }

  setTimeout(() => {
    btn.innerHTML = '💾 保存网页';
    btn.disabled = false;
    progress.style.display = 'none';
    bar.style.width = '0%';
  }, 3500);
}
