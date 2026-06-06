// ====================================================================
// 豆瓣证据保存器 v2.0 — 自包含 HTML 文件保存
// ====================================================================
// 保存为单文件 HTML（保留完整原始豆瓣样式，所有图片内嵌为 Base64）
// 多页帖子自动合并为一个 HTML 文件
// 可直接用桌面搜索工具全文检索
// ====================================================================

// ─── 工具函数 ─────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripStart(url) {
  return url.replace(/([?&])start=\d+(&|$)/, (_, pre, post) => post ? pre : '').replace(/[?&]$/, '');
}

// 📁 文件夹工具 ────────────────────────────────────────────────────
function folderFromFilename(absoluteFilename) {
  if (!absoluteFilename) return null;
  return absoluteFilename.replace(/\\/g, '/').replace(/\/[^/]+$/, '');
}

function absoluteToSub(absolutePath) {
  if (!absolutePath) return null;
  const norm = absolutePath.replace(/\\/g, '/').replace(/\/$/, '');
  const m = norm.match(/\/Downloads\/(.+)$/i);
  if (m) return m[1];
  if (/\/Downloads$/i.test(norm)) return '';
  return null;
}

async function persistFolder(folderSub) {
  if (folderSub === null) return;
  const parts = folderSub ? folderSub.split('/') : [];
  const label = parts[parts.length - 1] || 'Downloads';
  await chrome.storage.local.set({ folderSub, folderLabel: label });
}

function buildHtmlName(pageUrl, pageTitle, pageNum, totalPages) {
  const d = new Date();
  const ds = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const id = (pageUrl.match(/\/(\d{6,})\/?/) || [])[1] || '';
  const t = (pageTitle || '豆瓣页面').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 50);
  const suffix = totalPages > 1 ? `_p${pageNum}of${totalPages}` : '';
  return `豆瓣_${ds}_${t}${id ? '_' + id : ''}${suffix}.html`;
}

// ─── 键盘快捷键 ──────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('douban.com')) return;
  const opts = await chrome.storage.local.get({ mosaic: true, infobar: true, saveimgs: true });
  const result = await doSave(tab, opts.mosaic, opts.infobar, opts.saveimgs);
  if (result.success) {
    chrome.action.setBadgeText({ text: '✓', tabId: tab.id });
    chrome.action.setBadgeBackgroundColor({ color: '#3d6735', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2500);
  }
});

// ─── 端口连接（popup 通过长连接防止 SW 休眠）───────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    port.onDisconnect.addListener(() => {
      /* popup 关闭，可以清理 */
    });
  }
});

// ─── 消息处理 ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'save') {
    chrome.tabs.get(msg.tabId, async (tab) => {
      sendResponse(await doSave(tab, msg.mosaic, msg.infobar, msg.saveimgs));
    });
    return true;
  }
  if (msg.action === 'getPageCount') {
    chrome.tabs.get(msg.tabId, async (tab) => {
      const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: detectPageCount });
      sendResponse(r[0]?.result || { total: 1, current: 1, currentStart: 0, cleanBaseUrl: tab.url });
    });
    return true;
  }
  if (msg.action === 'getFolder') {
    chrome.storage.local.get({ folderLabel: '', folderSub: null }, d =>
      sendResponse({ label: d.folderLabel, sub: d.folderSub })
    );
    return true;
  }
  if (msg.action === 'resetFolder') {
    chrome.storage.local.remove(['folderLabel', 'folderSub']);
    sendResponse({ ok: true });
    return true;
  }
});

// ═══════════════════════════════════════════════════════════════════
// 新核心保存逻辑 — 自包含 HTML（保留完整豆瓣原始样式）
// ═══════════════════════════════════════════════════════════════════

// ─── 主入口 ──────────────────────────────────────────────────────
async function doSave(tab, mosaic, addInfoBar, saveImages) {
  console.log('[豆瓣证据保存] 开始保存:', tab.url);
  try {
    const pgResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: detectPageCount
    });
    const pg = pgResult[0]?.result || { total: 1, current: 1, currentStart: 0, cleanBaseUrl: tab.url };
    console.log('[豆瓣证据保存] 检测到页数:', pg.total);

    const stored = await chrome.storage.local.get({ folderLabel: '', folderSub: null });
    let folderSub = stored.folderSub;

    let result;
    if (pg.total <= 1) {
      result = await saveSinglePage(tab, mosaic, addInfoBar, saveImages, pg, folderSub);
    } else {
      result = await saveMultiPageMerged(tab, mosaic, addInfoBar, saveImages, pg, folderSub);
    }

    if (!result) return { success: false, error: '保存失败（未返回结果）' };
    if (result.folderSub !== undefined) {
      await persistFolder(result.folderSub);
    }
    return result;
  } catch (e) {
    console.error('[豆瓣证据保存] doSave 异常:', e.message, e.stack);
    try { await cleanupAfterCaptureInTab(tab.id); } catch (_) { }
    return { success: false, error: e.message };
  }
}

// ─── 单页保存 ────────────────────────────────────────────────────
async function saveSinglePage(tab, mosaic, addInfoBar, saveImages, pg, folderSub) {
  console.log('[豆瓣证据保存] 单页保存');

  // 1. 注入修改（马赛克、信息栏）
  await injectPageModifications(tab.id, mosaic, addInfoBar, pg.cleanBaseUrl, tab.title, 1, 1);
  await sleep(400);

  // 2. 捕获页面
  const pageData = await capturePage(tab.id);
  await cleanupAfterCaptureInTab(tab.id);
  if (!pageData) throw new Error('页面捕获失败');

  console.log('[豆瓣证据保存] 页面捕获完成, 图片数:', pageData.imageUrls?.length || 0, 'CSS 已在页面上下文内联');

  // 3. 内联资源（CSS + 可选内联图片）
  let finalHtml;
  if (saveImages) {
    finalHtml = await inlineAllResources(pageData);
  } else {
    // 只内联 CSS，不内联图片（文件更小，但离线时图片不可见）
    finalHtml = await inlineStylesOnly(pageData);
  }
  console.log('[豆瓣证据保存] 资源内联完成, HTML大小:', (finalHtml.length / 1024 / 1024).toFixed(1), 'MB');

  // 4. 保存文件
  const name = buildHtmlName(pg.cleanBaseUrl, tab.title, 1, 1);
  const newFolderSub = await saveHtmlFile(finalHtml, name, folderSub);
  return { success: true, folderSub: newFolderSub, message: '✅ 保存成功（自包含 HTML）' };
}

// ─── 多页分页保存（每页一个独立 HTML，分页器链接指向本地文件）──
async function saveMultiPageMerged(tab, mosaic, addInfoBar, saveImages, pg, folderSub) {
  console.log('[豆瓣证据保存] 多页分页保存, 共', pg.total, '页');

  const baseUrl = stripStart(pg.cleanBaseUrl);

  // 先生成所有页面的文件名（需要提前知道，用于替换分页器链接）
  // 文件名格式：豆瓣_日期_标题_p1of3.html / p2of3.html ...
  // title 从第一页拿，先占位，捕获后替换
  const pageNames = [];

  // 第一步：捕获所有页面数据
  const allPageData = [];
  for (let page = 1; page <= pg.total; page++) {
    const targetUrl = `${baseUrl}?start=${(page - 1) * 100}`;

    if (page > 1) {
      console.log('[豆瓣证据保存] 跳转到第', page, '页:', targetUrl);
      await navigateTo(tab.id, targetUrl);
      await sleep(500);
    }

    await injectPageModifications(tab.id, mosaic, addInfoBar, targetUrl, tab.title, page, pg.total);
    await sleep(400);

    const pageData = await capturePage(tab.id);
    await cleanupAfterCaptureInTab(tab.id);
    if (!pageData) throw new Error(`第 ${page} 页捕获失败`);

    allPageData.push(pageData);
    console.log(`[豆瓣证据保存] 第${page}页捕获完成, 图片: ${pageData.imageUrls.length}`);
  }

  // 恢复第一页
  try { await chrome.tabs.update(tab.id, { url: `${baseUrl}?start=0` }); } catch (_) { }

  // 用第一页的标题生成所有页面的文件名
  const firstTitle = allPageData[0].title;
  for (let page = 1; page <= pg.total; page++) {
    pageNames.push(buildHtmlName(baseUrl, firstTitle, page, pg.total));
  }
  console.log('[豆瓣证据保存] 文件名列表:', pageNames);

  // 第二步：处理每页 HTML，替换分页器链接为本地文件名，然后内联资源
  let resolvedFolderSub = folderSub;
  for (let page = 1; page <= pg.total; page++) {
    const pageData = allPageData[page - 1];

    // 替换分页器中的豆瓣在线链接为本地文件名
    let html = rewritePaginatorLinks(pageData.html, baseUrl, pageNames, page);

    // 内联 CSS + 可选内联图片
    html = await inlineCss(html, pageData.cssUrls || []);
    if (saveImages) {
      html = await inlineImages(html, pageData.imageUrls);
    }

    console.log(`[豆瓣证据保存] 第${page}页内联完成, 大小: ${(html.length / 1024 / 1024).toFixed(1)} MB`);

    // 保存文件（第一页弹窗选择文件夹，后续页静默保存到同处）
    resolvedFolderSub = await saveHtmlFile(html, pageNames[page - 1], resolvedFolderSub);
  }

  return {
    success: true,
    folderSub: resolvedFolderSub,
    message: `✅ 已保存全部 ${pg.total} 页（每页独立 HTML，分页可本地跳转）`
  };
}

// ─── 将 HTML 分页器里的在线链接替换为本地文件名 ─────────────────
function rewritePaginatorLinks(html, baseUrl, pageNames, currentPage) {
  // 豆瓣分页链接含 start=0, start=100, start=200 ...
  // 替换为对应的本地文件名：pageNames[0], pageNames[1], pageNames[2] ...
  //
  // 坑点：outerHTML 序列化时 & 会被编码为 &amp;，
  // 而且 _spm_id 等额外参数可能夹在中间。
  // 因此只搜索整型值 start=N，不依赖前后缀。
  let result = html;

  for (let i = 0; i < pageNames.length; i++) {
    const start = i * 100;
    const searchKey = `start=${start}`;

    let pos = 0;
    while ((pos = result.indexOf(searchKey, pos)) !== -1) {
      // 往前找 href=" 或 href='
      const dqPos = result.lastIndexOf('href="', pos);
      const sqPos = result.lastIndexOf("href='", pos);

      let hrefPos = -1;
      let quoteChar = '"';

      if (dqPos !== -1 && dqPos > pos - 400) {
        hrefPos = dqPos;
        quoteChar = '"';
      } else if (sqPos !== -1 && sqPos > pos - 400) {
        hrefPos = sqPos;
        quoteChar = "'";
      }

      if (hrefPos !== -1) {
        const hrefStart = `href=${quoteChar}`;
        const endPos = result.indexOf(quoteChar, hrefPos + hrefStart.length);
        if (endPos !== -1) {
          result = result.slice(0, hrefPos) + `href=${quoteChar}${pageNames[i]}${quoteChar}` + result.slice(endPos + 1);
          break; // 每个 start 值只替换一次
        }
      }
      pos++;
    }
  }

  console.log(`[分页替换] 第${currentPage}页分页器链接已替换为本地文件名`);
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// 页面捕获（注入到页面上下文执行）
// ═══════════════════════════════════════════════════════════════════

// ─── 触发懒加载 + 内联 CSS + 捕获完整页面快照 ───────────────────
// 注意：此函数会通过 executeScript 注入到页面中执行
// 关键设计：在页面上下文中先内联 CSS 和归一化图片 URL，
//           然后才取 outerHTML，避免后续 Service Worker
//           正则匹配 HTML 字符串时的 URL 格式不一致问题
function capturePageSnapshot() {
  return new Promise((resolve) => {
    // Step 1: 滚到底触发图片懒加载
    let lastH = 0;
    let rounds = 0;
    const MAX_ROUNDS = 8;

    function scrollDown() {
      window.scrollTo(0, document.documentElement.scrollHeight);
      setTimeout(checkProgress, 500);
    }

    function checkProgress() {
      const h = document.documentElement.scrollHeight;
      if (h > lastH && rounds < MAX_ROUNDS) {
        lastH = h;
        rounds++;
        scrollDown();
      } else {
        window.scrollTo(0, 0);
        setTimeout(inlineThenCapture, 800);
      }
    }

    async function inlineThenCapture() {
      try {
        // ─── Step A: 收集 CSS URL（不在页面上下文内联，避免 CORS 失败）──
        // CSS 文件在 doubanio.com，跨域 fetch/CSSOM 均被拦截。
        // 改为：收集所有 <link stylesheet> 的绝对 URL，
        // 交给 Service Worker（background.js）统一 fetch 后内联。
        const cssUrls = [];
        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
          if (link.href) {
            // 确保是绝对 URL
            try {
              cssUrls.push(new URL(link.href, location.href).href);
            } catch (_) {}
          }
        });

        // ─── Step B: 归一化图片 URL ──────────────────────────────
        // 1) data-src → src（懒加载图片激活）
        // 2) 相对路径 → 绝对路径（后续 Service Worker 抓取用）
        document.querySelectorAll('img').forEach(img => {
          const ds = img.getAttribute('data-src');
          if (ds) img.setAttribute('src', ds);
          let src = img.getAttribute('src');
          if (src && !src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://')) {
            try { img.setAttribute('src', new URL(src, location.href).href); } catch (_) { }
          }
        });

        // ─── Step C: 收集图片 URL ────────────────────────────────
        const imgSet = new Set();
        document.querySelectorAll('img').forEach(img => {
          let src = img.getAttribute('src') || '';
          if (src && !src.startsWith('data:')) {
            try { imgSet.add(new URL(src, location.href).href); } catch (_) { }
          }
        });

        // ─── Step D: 清理其他扩展注入的元素 ────────────────────────
        // 移除所有 position:fixed/sticky 且明显是第三方插件注入的浮层
        // 判断依据：id 或 class 包含常见插件关键词，或者是完全不含豆瓣内容的空壳浮层
        const DOUBAN_ID_PREFIXES = ['db-', 'douban', 'lnk-', 'shire', 'site-', 'top-nav', 'bottom-nav'];
        const PLUGIN_KEYWORDS = [
          // 常见扩展注入特征
          'extension', 'inject', 'plugin', 'addon', 'widget',
          'greasemonkey', 'tampermonkey', 'violentmonkey',
          // 常见功能型悬浮窗关键词
          'translate', 'translation', 'translator',
          'shadow', 'overlay', 'tooltip', 'popup', 'modal',
          'helper', 'assistant', 'toolbar', 'sidebar',
          'floating', 'float-btn', 'back-top', 'backtop', 'scroll-top',
          'reader', 'readability', 'dark-mode', 'night-mode',
          'password', 'lastpass', 'bitwarden', 'dashlane', '1password',
          'adblock', 'ublock', 'grammarly', 'evernote', 'pocket',
          // 本插件自己的元素（顺带清理）
          '__dsaver',
        ];
        document.querySelectorAll('*').forEach(el => {
          try {
            const style = window.getComputedStyle(el);
            const pos = style.position;
            if (pos !== 'fixed' && pos !== 'sticky') return;
            const id = (el.id || '').toLowerCase();
            const cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
            const combined = id + ' ' + cls;
            // 保留豆瓣原生元素
            const isDouban = DOUBAN_ID_PREFIXES.some(p => id.startsWith(p));
            if (isDouban) return;
            // 移除含插件关键词的元素
            const isPlugin = PLUGIN_KEYWORDS.some(k => combined.includes(k));
            if (isPlugin) { el.remove(); return; }
            // 移除 z-index 超高（> 9999）且不是豆瓣的元素（几乎都是插件浮层）
            const z = parseInt(style.zIndex) || 0;
            if (z > 9999) { el.remove(); }
          } catch (_) {}
        });

        // ─── Step E: 捕获 HTML ───────────────────────────────────────
        const doctypeStr = document.doctype ? '<!DOCTYPE html>\n' : '';
        resolve({
          html: doctypeStr + document.documentElement.outerHTML,
          title: document.title || '',
          url: location.href,
          imageUrls: [...imgSet],
          cssUrls: cssUrls,
        });
      } catch (e) {
        resolve({
          html: '<!DOCTYPE html>\n' + document.documentElement.outerHTML,
          title: document.title || '',
          url: location.href,
          imageUrls: [],
          error: e.message,
        });
      }
    }

    scrollDown();
  });
}

// ─── 捕获完整页面（包装 executeScript）──────────────────────────
async function capturePage(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: capturePageSnapshot,
  });

  const data = result[0]?.result;
  if (!data || !data.html) throw new Error('捕获页面失败');
  return data;
}

// ─── 捕获回复区域（多页合并用）───────────────────────────────────
// 同样在页面上下文内先归一化图片 URL
function captureRepliesOnlySnapshot() {
  // 找到回复容器
  const replyContainer = document.querySelector('#comments')
    || document.querySelector('.topic-reply')
    || document.querySelector('.reply-list')
    || document.querySelector('[id*="reply"]')
    || document.querySelector('[class*="reply"]');

  if (!replyContainer) return { replyHTML: '', imageUrls: [] };

  // 归一化回复中的图片 URL
  replyContainer.querySelectorAll('img').forEach(img => {
    const ds = img.getAttribute('data-src');
    if (ds) img.setAttribute('src', ds);
    let src = img.getAttribute('src');
    if (src && !src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://')) {
      try { img.setAttribute('src', new URL(src, location.href).href); } catch (_) { }
    }
  });

  const replyHTML = replyContainer.innerHTML;

  // 收集回复中的图片 URL
  const imgSet = new Set();
  replyContainer.querySelectorAll('img').forEach(img => {
    let src = img.getAttribute('src') || '';
    if (src && !src.startsWith('data:')) {
      try { imgSet.add(new URL(src, location.href).href); } catch (_) { }
    }
  });

  return { replyHTML, imageUrls: [...imgSet] };
}

async function captureRepliesOnly(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: captureRepliesOnlySnapshot,
  });
  return result[0]?.result || { replyHTML: '', imageUrls: [] };
}

// ─── 注入页面修改（马赛克/信息栏）────────────────────────────────
// 注意：注入到页面上下文（ISOLATED world 可以操作 DOM）
function injectModifications(applyMosaic, addInfoBar, cleanPageUrl, pageTitle, pageNum, totalPages) {
  // 马赛克遮罩
  if (applyMosaic) {
    const s = document.createElement('style');
    s.id = '__dsaver_mosaic__';
    s.textContent = `
      #db-nav-sns .nav-user-account, .nav-user-account,
      #db-top-nav .top-nav-info, .top-nav-info,
      #db-global-nav .accounts, #db-top-nav .accounts,
      .nav-items .accounts, .db-nav-user,
      .user-info, .user-account, .account-info,
      [class*="user"][class*="info"], [class*="account"] {
        filter: blur(10px) !important;
        -webkit-filter: blur(10px) !important;
        pointer-events: none !important;
        user-select: none !important;
      }`;
    document.head.appendChild(s);
  }

  // 底部来源信息栏
  if (addInfoBar) {
    const d = new Date();
    const ds = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pi = totalPages > 1 ? ` · 第 ${pageNum}/${totalPages} 页` : '';

    const bar = document.createElement('div');
    bar.id = '__dsaver_infobar__';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:rgba(38,65,33,0.97);color:#fff;font-family:PingFang SC,Microsoft YaHei,sans-serif;padding:6px 16px;display:flex;align-items:center;gap:6px;box-shadow:0 -2px 12px rgba(0,0,0,0.35);overflow:hidden;line-height:1.4';
    bar.innerHTML = `
      <span style="font-size:11px;opacity:.6;flex-shrink:0">📅 ${esc(ds)}${esc(pi)}</span>
      <span style="opacity:.25;flex-shrink:0">｜</span>
      <span style="font-size:12px;font-weight:600;flex-shrink:0;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pageTitle)}</span>
      <span style="opacity:.25;flex-shrink:0">｜</span>
      <span style="font-size:10px;opacity:.55;flex-shrink:0">来源：</span>
      <a href="${esc(cleanPageUrl)}" style="color:#9ed49a;font-size:11px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 0">${esc(cleanPageUrl)}</a>`;
    document.body.appendChild(bar);
  }
}

async function injectPageModifications(tabId, mosaic, infoBar, url, title, pageNum, totalPages) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectModifications,
    args: [mosaic, infoBar, url, title, pageNum, totalPages]
  });
}

// ─── 清理页面修改 ────────────────────────────────────────────────
function cleanupModifications() {
  ['__dsaver_mosaic__', '__dsaver_infobar__'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
}

async function cleanupAfterCaptureInTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, func: cleanupModifications
    });
  } catch (_) { }
}

// ═══════════════════════════════════════════════════════════════════
// 资源内联（在 background/service worker 中执行）
// ═══════════════════════════════════════════════════════════════════
// CSS 已在页面上下文内联完毕，这里只处理图片 → Base64

// ─── 在 Service Worker 中内联 CSS（绕过页面上下文的 CORS 限制）────
async function inlineCss(html, cssUrls) {
  if (!cssUrls || cssUrls.length === 0) return html;

  // 去重
  const uniqueUrls = [...new Set(cssUrls)];
  console.log('[CSS内联] 开始内联', uniqueUrls.length, '个 CSS 文件（Service Worker 无 CORS 限制）');

  // 批量 fetch CSS
  const cssMap = new Map();
  await Promise.all(uniqueUrls.map(async (url) => {
    try {
      const resp = await fetch(url, { referrer: 'https://www.douban.com/' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let cssText = await resp.text();
      // 把 CSS 中相对 url() 路径转为绝对路径（背景图、字体等）
      cssText = cssText.replace(/url\(\s*(['"]?)([^)'"]\S*?)\1\s*\)/g, function(match, quote, urlVal) {
        if (!urlVal || urlVal.startsWith('data:') || urlVal.startsWith('http://') ||
            urlVal.startsWith('https://') || urlVal.startsWith('//') || urlVal.startsWith('#')) {
          return match;
        }
        try {
          return 'url(' + quote + new URL(urlVal, url).href + quote + ')';
        } catch (_) { return match; }
      });
      cssMap.set(url, cssText);
    } catch (e) {
      console.warn('[CSS内联] 获取失败:', url.slice(0, 80), e.message);
    }
  }));

  console.log('[CSS内联] 成功获取', cssMap.size, '/', uniqueUrls.length, '个 CSS 文件');

  // 用正则替换 HTML 里对应的 <link rel="stylesheet" href="..."> 为 <style>...</style>
  // 匹配各种属性顺序的 link 标签
  let result = html;
  for (const [url, cssText] of cssMap) {
    // 转义 URL 用于正则
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 匹配 <link ... href="url" ...> 或 <link ... href='url' ...>（属性顺序不固定）
    const linkRe = new RegExp('<link[^>]+href=["\'\']' + escapedUrl + '["\'\'][^>]*/?>', 'gi');
    const styleTag = '<style>\n' + cssText + '\n</style>';
    const before = result.length;
    result = result.replace(linkRe, styleTag);
    if (result.length !== before) {
      // 也处理 //开头的 URL（protocol-relative）
    } else {
      // 尝试 protocol-relative 版本
      const prUrl = url.replace(/^https?:/, '');
      const escapedPr = prUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const prRe = new RegExp('<link[^>]+href=["\'\']' + escapedPr + '["\'\'][^>]*/?>', 'gi');
      result = result.replace(prRe, styleTag);
    }
  }

  return result;
}

// ─── 获取并内联所有资源（CSS + 图片）───────────────────────────
async function inlineAllResources(pageData) {
  const htmlWithCss = await inlineCss(pageData.html, pageData.cssUrls);
  return inlineImages(htmlWithCss, pageData.imageUrls);
}

// ─── 仅内联 CSS（不内联图片）────────────────────────────────────
async function inlineStylesOnly(pageData) {
  return inlineCss(pageData.html, pageData.cssUrls);
}

// ─── 将外部图片抓取后内联为 Base64 data URI ────────────────────
async function inlineImages(html, imageUrls) {
  let result = html;

  if (imageUrls && imageUrls.length > 0) {
    const imgMap = new Map();
    // 分批获取，避免同时发太多请求
    const BATCH_SIZE = 10;
    for (let i = 0; i < imageUrls.length; i += BATCH_SIZE) {
      const batch = imageUrls.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (url) => {
        try {
          const resp = await fetch(url, {
            referrer: 'https://www.douban.com/',
            credentials: 'include',
          });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const blob = await resp.blob();
          if (blob.size === 0) throw new Error('空响应');
          const ab = await blob.arrayBuffer();
          const base64 = arrayBufferToBase64(ab);
          const dataUri = `data:${blob.type || 'image/jpeg'};base64,${base64}`;
          imgMap.set(url, dataUri);
        } catch (e) {
          console.warn('[内联] 图片获取失败:', url.slice(0, 80), e.message);
        }
      });
      await Promise.all(batchPromises);
      console.log('[内联] 图片批次完成:', Math.min(i + BATCH_SIZE, imageUrls.length), '/', imageUrls.length);
    }

    // 替换 HTML 中的图片引用
    // 注意：页面上下文已把 src 归一化为绝对 URL，此处直接用 split-join
    for (const [originalUrl, dataUri] of imgMap) {
      result = result.split(`"${originalUrl}"`).join(`"${dataUri}"`);
      result = result.split(`'${originalUrl}'`).join(`'${dataUri}'`);
    }
    console.log('[内联] 图片内联完成, 替换了', imgMap.size, '张图片');
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════
// 多页合并逻辑
// ═══════════════════════════════════════════════════════════════════

// ─── 将后续页面的回复合并到第一页 HTML ──────────────────────────
function mergeReplyContent(firstPageHtml, extraReplies) {
  if (!extraReplies || extraReplies.length === 0) return firstPageHtml;

  let html = firstPageHtml;

  // 收集所有额外回复的 HTML
  let allExtraContent = '';
  extraReplies.forEach((reply, idx) => {
    const pageNum = idx + 2;
    allExtraContent += `\n<!-- ═════ 以下内容来自第 ${pageNum} 页 ═════ -->\n`;
    allExtraContent += reply.replyHTML;
  });

  if (!allExtraContent) return html;

  // ─── 策略：插入到 <ul id="comments"> 的 </ul> 闭合标签之前 ───
  // 豆瓣结构：<ul id="comments">...<li>回复</li>...</ul><div class="paginator">
  // 必须插入到 </ul> 内部，否则 <li> 游离在 <ul> 外，浏览器修复时样式错乱。

  // 方法1: 找到 <ul id="comments"> 对应的 </ul>，在它前面插入
  const commentsUlMatch = html.match(/<ul[^>]*id=["']comments["'][^>]*>/i);
  if (commentsUlMatch) {
    // 找到这个 <ul> 之后的第一个 </ul>
    const ulStart = html.indexOf(commentsUlMatch[0]);
    const ulEnd = html.indexOf('</ul>', ulStart + commentsUlMatch[0].length);
    if (ulEnd > ulStart) {
      html = html.slice(0, ulEnd) + allExtraContent + '\n' + html.slice(ulEnd);
      console.log('[合并] 插入到 #comments </ul> 内部');
      return html;
    }
  }

  // 方法2: 找到 <ul class="topic-reply"...> 对应的 </ul>
  const topicReplyMatch = html.match(/<ul[^>]*class=["'][^"']*topic-reply[^"']*["'][^>]*>/i);
  if (topicReplyMatch) {
    const ulStart = html.indexOf(topicReplyMatch[0]);
    const ulEnd = html.indexOf('</ul>', ulStart + topicReplyMatch[0].length);
    if (ulEnd > ulStart) {
      html = html.slice(0, ulEnd) + allExtraContent + '\n' + html.slice(ulEnd);
      console.log('[合并] 插入到 .topic-reply </ul> 内部');
      return html;
    }
  }

  // 方法3: 兜底 — 在 </body> 前插入独立区块
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose > 0) {
    const mergedSection = `
<div style="border-top:3px solid #ccc;margin-top:20px;padding-top:20px;background:#fafafa;">
  <h3 style="padding:10px;margin:0;background:#f5f5f5;color:#666;font-size:14px;">
    📋 以下为合并的其他页面回复内容
  </h3>
  <ul>${allExtraContent}</ul>
</div>
`;
    html = html.slice(0, bodyClose) + mergedSection + html.slice(bodyClose);
    console.log('[合并] 兜底：在 </body> 前插入回复区');
  }

  return html;
}

// ═══════════════════════════════════════════════════════════════════
// 文件保存
// ═══════════════════════════════════════════════════════════════════

// ─── 保存 HTML 文件 ─────────────────────────────────────────────
// 注：MV3 Service Worker 不支持 URL.createObjectURL，改用 data URL
function htmlToDataUrl(htmlContent) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(htmlContent);
  const base64 = arrayBufferToBase64(bytes.buffer);
  return 'data:text/html;charset=utf-8;base64,' + base64;
}

async function saveHtmlFile(htmlContent, filename, folderSub) {
  const dataUrl = htmlToDataUrl(htmlContent);

  console.log('[保存] 文件名:', filename, '| HTML大小:', (htmlContent.length / 1024 / 1024).toFixed(1), 'MB');

  try {
    if (folderSub === null) {
      // 首次：弹窗让用户选择
      const dlId = await chromeDownloadsDownload({ url: dataUrl, filename, saveAs: true });
      const chosenPath = await waitForFilenameResolved(dlId);
      return absoluteToSub(chosenPath);
    } else {
      // 已知文件夹：静默保存
      const filePath = folderSub ? `${folderSub}/${filename}` : filename;
      await chromeDownloadsDownload({ url: dataUrl, filename: filePath, saveAs: false });
      return folderSub;
    }
  } catch (e) {
    throw e;
  }
}

// ─── 下载包装 ────────────────────────────────────────────────────
function chromeDownloadsDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(downloadId);
      }
    });
  });
}

// ─── 等待文件名确认（首次弹窗后）────────────────────────────────
function waitForFilenameResolved(downloadId) {
  // 修复：第一次点保存无响应的 bug
  // 原因：弹窗保存时，用户选择文件夹后 onChanged 会先触发 filename 更新，
  //       但旧逻辑在 search 查到空 filename 时没有继续等待，导致 folderSub 未被记录。
  // 修复：监听 onChanged 的 filename 变化 和 state 变化（complete/in_progress 都说明已确认），
  //       并加入轮询兜底，确保拿到用户选择的路径后才 resolve。
  return new Promise((resolve) => {
    let resolved = false;

    function done(path) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      clearInterval(pollTimer);
      chrome.downloads.onChanged.removeListener(listener);
      resolve(path);
    }

    // 超时兜底（2分钟）：用户可能花很久选择文件夹
    const timeout = setTimeout(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        done(item?.filename ? folderFromFilename(item.filename) : null);
      } catch (_) { done(null); }
    }, 120000);

    // 主监听：onChanged 事件
    function listener(delta) {
      if (delta.id !== downloadId) return;
      // filename 出现 = 用户已选择保存路径
      const newName = delta.filename?.current;
      if (newName && newName.trim() !== '') {
        done(folderFromFilename(newName));
        return;
      }
      // 下载完成也说明有了路径（state 变为 complete）
      if (delta.state?.current === 'complete') {
        chrome.downloads.search({ id: downloadId }).then(([item]) => {
          done(item?.filename ? folderFromFilename(item.filename) : null);
        }).catch(() => done(null));
        return;
      }
      if (delta.state?.current === 'interrupted' || delta.error?.current) {
        done(null);
      }
    }
    chrome.downloads.onChanged.addListener(listener);

    // 轮询兜底：每500ms 查询一次，防止 onChanged 漏事件（MV3 SW 已唤醒时偶发）
    const pollTimer = setInterval(async () => {
      try {
        const [item] = await chrome.downloads.search({ id: downloadId });
        if (!item) return;
        if (item.filename && item.filename.trim() !== '') {
          done(folderFromFilename(item.filename));
        } else if (item.state === 'interrupted' || item.error) {
          done(null);
        }
      } catch (_) {}
    }, 500);
  });
}

// ═══════════════════════════════════════════════════════════════════
// 页面导航（多页用）
// ═══════════════════════════════════════════════════════════════════

async function navigateTo(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await sleep(300);
  const deadline = Date.now() + 20000;
  let wasLoading = false;
  while (Date.now() < deadline) {
    await sleep(400);
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'loading') wasLoading = true;
    if (wasLoading && t.status === 'complete') {
      await sleep(1000);
      return;
    }
  }
  await sleep(1500);
}

// ═══════════════════════════════════════════════════════════════════
// 注入到页面执行的函数（被 executeScript 调用）
// ═══════════════════════════════════════════════════════════════════

// ─── 检测页数 ────────────────────────────────────────────────────
function detectPageCount() {
  function cleanUrl(url) {
    try {
      const u = new URL(url);
      ['_spm_id', '_i', 'spm', 'from', 'fr', 'source', 'ref', 'referer',
       'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(k => u.searchParams.delete(k));
      for (const k of [...u.searchParams.keys()]) if (k.startsWith('_')) u.searchParams.delete(k);
      return u.searchParams.toString() ? u.toString() : u.origin + u.pathname;
    } catch { return location.href.split('?')[0]; }
  }

  const url = location.href;
  const currentStart = parseInt((url.match(/[?&]start=(\d+)/) || [])[1] || '0');
  let total = 1, maxStart = currentStart;
  const c = document.querySelector('.count, #count');
  if (c) { const m = c.textContent.match(/(\d+)/); if (m) total = Math.max(total, Math.ceil(+m[1] / 100)); }
  document.querySelectorAll('a[href*="start="]').forEach(a => {
    try { const s = new URL(a.href).searchParams.get('start'); if (s && a.href.includes(location.pathname)) maxStart = Math.max(maxStart, +s); } catch (_) { }
  });
  if (maxStart >= 100) total = Math.max(total, Math.floor(maxStart / 100) + 1);
  return { total, current: Math.floor(currentStart / 100) + 1, currentStart, cleanBaseUrl: cleanUrl(url) };
}
