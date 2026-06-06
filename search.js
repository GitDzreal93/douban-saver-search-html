const DB_NAME = 'doubanSaverSearchDB';
const DB_VERSION = 2;
const HANDLE_STORE = 'handles';
const DATA_STORE = 'data';
const ROOT_HANDLE_KEY = 'root-folder';
const INDEX_CACHE_KEY = 'index-cache';

const state = {
  rootHandle: null,
  index: [],
  filtered: [],
  busy: false
};

const els = {
  chooseFolder: document.getElementById('choose-folder'),
  refreshIndex: document.getElementById('refresh-index'),
  searchInput: document.getElementById('search-input'),
  folderName: document.getElementById('folder-name'),
  folderHint: document.getElementById('folder-hint'),
  statFiles: document.getElementById('stat-files'),
  statResults: document.getElementById('stat-results'),
  statusText: document.getElementById('status-text'),
  lastUpdated: document.getElementById('last-updated'),
  resultsSummary: document.getElementById('results-summary'),
  resultsList: document.getElementById('results-list')
};

init().catch(error => {
  console.error(error);
  setStatus(`初始化失败：${error.message}`, 'error');
});

async function init() {
  bindEvents();
  const cachedIndex = await loadFromStore(INDEX_CACHE_KEY);
  if (Array.isArray(cachedIndex?.items) && cachedIndex.items.every(isStructuredRecord)) {
    state.index = cachedIndex.items;
    state.filtered = cachedIndex.items;
    syncStats();
    renderResults(cachedIndex.items, '');
    updateLastUpdated(cachedIndex.updatedAt);
  }

  const savedHandle = await loadFromStore(ROOT_HANDLE_KEY, HANDLE_STORE);
  if (!savedHandle) {
    setStatus('请先选择保存豆瓣帖子的文件夹。', '');
    return;
  }

  state.rootHandle = savedHandle;
  await restoreHandleState();
}

function bindEvents() {
  els.chooseFolder.addEventListener('click', chooseFolder);
  els.refreshIndex.addEventListener('click', () => refreshIndex({ announce: true }));
  els.searchInput.addEventListener('input', () => {
    const query = els.searchInput.value.trim();
    const matches = searchIndex(query);
    state.filtered = matches;
    syncStats();
    renderResults(matches, query);
  });
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    setStatus('当前浏览器不支持本地文件夹授权。请使用最新版 Chrome 或 Edge。', 'error');
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    const permission = await ensurePermission(handle);
    if (permission !== 'granted') {
      setStatus('没有获得文件夹读取权限，暂时无法建立索引。', 'error');
      return;
    }

    state.rootHandle = handle;
    await saveToStore(ROOT_HANDLE_KEY, handle, HANDLE_STORE);
    updateFolderInfo(handle.name, '已连接帖子文件夹，可以直接搜索。');
    await refreshIndex({ announce: true });
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error(error);
    setStatus(`选择文件夹失败：${error.message}`, 'error');
  }
}

async function restoreHandleState() {
  try {
    const permission = await state.rootHandle.queryPermission({ mode: 'read' });
    updateFolderInfo(state.rootHandle.name, permission === 'granted'
      ? '已读取上次选择的文件夹。你可以直接搜索，也可以手动刷新索引。'
      : '找到了上次选择的文件夹，但浏览器需要你重新点一次“选择文件夹”来授权。');

    if (permission === 'granted') {
      els.refreshIndex.disabled = false;
      els.searchInput.disabled = state.index.length === 0;
      if (state.index.length === 0) {
        setStatus('已找到上次的文件夹。请点击“刷新索引”开始读取帖子。', '');
      } else {
        setStatus('已加载上次的索引。如果你刚保存了新帖子，请点击“刷新索引”。', 'success');
      }
    } else {
      els.refreshIndex.disabled = true;
      els.searchInput.disabled = true;
      setStatus('浏览器暂时没有文件夹读取权限，请重新点击“选择文件夹”。', 'error');
    }
  } catch (error) {
    console.error(error);
    setStatus('无法恢复上次的文件夹，请重新选择。', 'error');
  }
}

async function refreshIndex({ announce = false } = {}) {
  if (!state.rootHandle || state.busy) return;

  try {
    const permission = await ensurePermission(state.rootHandle);
    if (permission !== 'granted') {
      setStatus('浏览器暂时没有文件夹读取权限，请重新点击“选择文件夹”。', 'error');
      els.refreshIndex.disabled = true;
      els.searchInput.disabled = true;
      return;
    }

    state.busy = true;
    syncBusyState();
    setStatus('正在更新帖子索引，请稍等……', '');

    const items = await scanDirectory(state.rootHandle);
    items.sort((a, b) => (b.modifiedMs || 0) - (a.modifiedMs || 0));

    state.index = items;
    const query = els.searchInput.value.trim();
    const matches = searchIndex(query);
    state.filtered = matches;

    const updatedAt = new Date().toISOString();
    await saveToStore(INDEX_CACHE_KEY, { items, updatedAt }, DATA_STORE);

    els.searchInput.disabled = items.length === 0;
    els.refreshIndex.disabled = false;
    syncStats();
    updateLastUpdated(updatedAt);
    renderResults(matches, query);

    if (items.length === 0) {
      setStatus('没有在这个文件夹里找到 HTML 文件。请确认你选的是保存帖子的文件夹。', 'error');
    } else if (announce) {
      setStatus(`索引已更新，共读取 ${items.length} 个 HTML 文件。保存新帖子后，记得再点一次“刷新索引”。`, 'success');
    } else {
      setStatus('索引已准备好，可以直接搜索。保存新帖子后，请点“刷新索引”。', 'success');
    }
  } catch (error) {
    console.error(error);
    setStatus(`刷新索引失败：${error.message}`, 'error');
  } finally {
    state.busy = false;
    syncBusyState();
  }
}

async function scanDirectory(rootHandle) {
  const items = [];
  await walkDirectory(rootHandle, [], items);
  return items;
}

async function walkDirectory(directoryHandle, segments, items) {
  for await (const entry of directoryHandle.values()) {
    if (entry.kind === 'directory') {
      await walkDirectory(entry, [...segments, entry.name], items);
      continue;
    }

    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith('.html')) continue;
    const file = await entry.getFile();
    const html = await file.text();
    const record = buildRecord(file, html, [...segments, entry.name]);
    items.push(record);
  }
}

function buildRecord(file, html, pathSegments) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript').forEach(node => node.remove());

  const extracted = extractStructuredContent(doc);
  const title = extracted.title || cleanText(doc.querySelector('title')?.textContent) || file.name.replace(/\.html$/i, '') || '未命名帖子';
  const path = pathSegments.join('/');
  const modifiedMs = file.lastModified || 0;
  const modifiedAt = modifiedMs ? new Date(modifiedMs).toISOString() : '';
  const replyText = extracted.replies.map(reply => `${reply.author} ${reply.content}`).join('\n');
  const authorText = extracted.authors.join('\n');
  const searchText = `${title}\n${file.name}\n${path}\n${authorText}\n${replyText}`.toLowerCase();

  return {
    id: path,
    path,
    fileName: file.name,
    title,
    authors: extracted.authors,
    replies: extracted.replies,
    bodyText: replyText,
    searchText,
    modifiedMs,
    modifiedAt
  };
}

function isStructuredRecord(item) {
  return item
    && typeof item.title === 'string'
    && Array.isArray(item.authors)
    && Array.isArray(item.replies);
}

function searchIndex(query) {
  const trimmed = query.trim();
  if (!trimmed) return state.index.slice(0, 200);

  const terms = tokenize(trimmed);
  return state.index
    .filter(item => terms.every(term => item.searchText.includes(term)))
    .sort((a, b) => scoreItem(b, terms) - scoreItem(a, terms))
    .slice(0, 200);
}

function scoreItem(item, terms) {
  let score = item.modifiedMs || 0;
  const titleLower = item.title.toLowerCase();
  const fileLower = item.fileName.toLowerCase();
  const authorsLower = item.authors.join(' ').toLowerCase();
  for (const term of terms) {
    if (titleLower.includes(term)) score += 5000000000000;
    if (authorsLower.includes(term)) score += 2000000000000;
    if (fileLower.includes(term)) score += 1000000000000;
    if (item.bodyText.toLowerCase().includes(term)) score += 1000000000;
  }
  return score;
}

function renderResults(items, query) {
  els.resultsList.innerHTML = '';
  els.resultsSummary.textContent = buildResultsSummary(items.length, query);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = query
      ? '没有找到相关内容。你可以换个关键词，或者先点击“刷新索引”。'
      : '索引已经准备好。现在可以直接在上方输入关键词开始搜索。';
    els.resultsList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach(item => {
    const card = document.createElement('article');
    card.className = 'result-card';

    const info = document.createElement('div');
    const kicker = document.createElement('div');
    kicker.className = 'result-kicker';
    kicker.textContent = 'Douban HTML Archive';

    const title = document.createElement('h3');
    title.className = 'result-title';
    title.innerHTML = highlightText(escapeHtml(item.title), tokenize(query));

    const snippet = document.createElement('p');
    snippet.className = 'result-snippet';
    snippet.innerHTML = highlightText(escapeHtml(buildSnippet(item, query)), tokenize(query));

    info.append(kicker, title, snippet);

    const openBtn = document.createElement('button');
    openBtn.className = 'result-open';
    openBtn.textContent = '打开原 HTML';
    openBtn.addEventListener('click', () => openRecord(item.path));

    card.append(info, openBtn);
    fragment.appendChild(card);
  });

  els.resultsList.appendChild(fragment);
}

async function openRecord(path) {
  if (!state.rootHandle) {
    setStatus('请先选择帖子文件夹。', 'error');
    return;
  }

  try {
    const permission = await ensurePermission(state.rootHandle);
    if (permission !== 'granted') {
      setStatus('浏览器暂时没有文件夹读取权限，请重新点击“选择文件夹”。', 'error');
      return;
    }

    const fileHandle = await getFileHandleByPath(state.rootHandle, path);
    const file = await fileHandle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error(error);
    setStatus(`打开文件失败：${error.message}`, 'error');
  }
}

async function getFileHandleByPath(rootHandle, path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('文件路径无效');
  }

  let current = rootHandle;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = await current.getDirectoryHandle(parts[i]);
  }
  return current.getFileHandle(parts[parts.length - 1]);
}

function updateFolderInfo(name, hint) {
  els.folderName.textContent = name || '还没有选择文件夹';
  els.folderHint.textContent = hint;
}

function syncBusyState() {
  els.chooseFolder.disabled = state.busy;
  els.refreshIndex.disabled = state.busy || !state.rootHandle;
}

function syncStats() {
  els.statFiles.textContent = String(state.index.length);
  els.statResults.textContent = String(state.filtered.length);
}

function updateLastUpdated(isoString) {
  els.lastUpdated.textContent = isoString
    ? `上次建立索引：${formatDate(isoString)}`
    : '尚未建立索引';
}

function buildResultsSummary(count, query) {
  if (!query) {
    return state.index.length
      ? `当前已读取 ${state.index.length} 个 HTML 文件，输入关键词后会在帖子标题、用户昵称和回复内容里一起搜索。`
      : '先建立索引，然后就可以直接搜索。';
  }
  return `关键词“${query}”共找到 ${count} 条结果。`;
}

function buildSnippet(item, query) {
  const terms = tokenize(query);
  const matchedReply = findMatchedReply(item, terms);

  if (matchedReply) {
    const author = matchedReply.author || '未知昵称';
    const content = shortenText(matchedReply.content || '这条回复没有识别到正文。', 120);
    return `${author}：${content}`;
  }

  if (terms.length === 0) {
    if (item.replies.length > 0) {
      const firstReply = item.replies.find(reply => reply.content) || item.replies[0];
      return `${firstReply.author || '未知昵称'}：${shortenText(firstReply.content || '这条回复没有识别到正文。', 120)}`;
    }
    if (item.authors.length > 0) {
      return `已识别昵称：${item.authors.slice(0, 6).join('、')}`;
    }
    return '这个文件里没有识别到清晰的回复内容。';
  }

  const matchedAuthor = item.authors.find(author => terms.every(term => author.toLowerCase().includes(term)));
  if (matchedAuthor) {
    return `命中昵称：${matchedAuthor}`;
  }

  if (terms.every(term => item.title.toLowerCase().includes(term))) {
    return `命中帖子标题：${item.title}`;
  }

  return '找到了匹配项，但这条帖子里没有提取到更适合展示的回复摘要。';
}

function tokenize(text) {
  return text.toLowerCase().split(/\s+/).map(part => part.trim()).filter(Boolean);
}

function cleanText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function extractStructuredContent(doc) {
  const pageTitle = cleanText(
    doc.querySelector('h1')?.textContent
      || doc.querySelector('.article h1')?.textContent
      || doc.querySelector('title')?.textContent
  );

  const replyRoot = doc.querySelector('#comments')
    || doc.querySelector('.topic-reply')
    || doc.querySelector('.reply-list')
    || doc.querySelector('[id*="reply"]')
    || doc.querySelector('[class*="reply"]');

  const replies = collectReplies(replyRoot);
  const authors = [...new Set(replies.map(reply => reply.author).filter(Boolean))];

  return {
    title: pageTitle,
    authors,
    replies
  };
}

function collectReplies(replyRoot) {
  if (!replyRoot) return [];

  const selectors = [
    ':scope > li',
    ':scope > .comment-item',
    ':scope > .reply-item',
    ':scope > .reply-doc',
    ':scope > .topic-reply-item'
  ];

  let nodes = [];
  for (const selector of selectors) {
    nodes = [...replyRoot.querySelectorAll(selector)];
    if (nodes.length > 0) break;
  }

  if (nodes.length === 0) {
    nodes = [...replyRoot.children];
  }

  const replies = [];
  nodes.forEach(node => {
    const reply = extractReply(node);
    if (reply) replies.push(reply);
  });

  return replies;
}

function extractReply(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll('script, style, img, svg, button, form, textarea').forEach(el => el.remove());

  const author = extractReplyAuthor(clone);
  const content = extractReplyContent(clone);
  if (!author && !content) return null;

  return {
    author,
    content
  };
}

function extractReplyAuthor(node) {
  const selectors = [
    '.user-face + div a',
    '.reply-doc .content h4 a',
    'h4 a',
    '.pubtime a',
    '.author a',
    'a[href*="/people/"]',
    'a[href*="/group/topic/"] + a'
  ];

  for (const selector of selectors) {
    const text = cleanText(node.querySelector(selector)?.textContent);
    if (isMeaningfulNickname(text)) return text;
  }

  const links = [...node.querySelectorAll('a')].map(el => cleanText(el.textContent)).filter(isMeaningfulNickname);
  return links[0] || '';
}

function extractReplyContent(node) {
  const selectors = [
    '.reply-content',
    '.reply-doc .content',
    '.content',
    '.comment',
    '.text',
    'blockquote',
    'p'
  ];

  for (const selector of selectors) {
    const text = normalizeReplyText(node.querySelector(selector)?.textContent || '');
    if (text) return text;
  }

  return normalizeReplyText(node.textContent || '');
}

function normalizeReplyText(text) {
  if (!text) return '';

  const junkPatterns = [
    /^投诉$/,
    /^赞(\s*\(\d+\))?$/,
    /^回复$/,
    /^删除$/,
    /^删除图片$/,
    /^添加图片$/,
    /^推荐到广播$/,
    /^转发$/,
    /^收藏$/,
    /^分享$/,
    /^只看楼主$/,
    /^来自.*$/,
    /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}.*$/,
    /^[A-Za-z0-9_+\-]+$/
  ];

  const lines = String(text)
    .split(/\n+/)
    .map(line => cleanText(line))
    .filter(Boolean)
    .filter(line => !junkPatterns.some(pattern => pattern.test(line)));

  const merged = lines.join(' ');
  return merged
    .replace(/投诉\s*赞(?:\s*\(\d+\))?\s*回复/g, ' ')
    .replace(/添加图片\s*删除图片/g, ' ')
    .replace(/推荐到广播/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMeaningfulNickname(text) {
  if (!text) return false;
  const junk = new Set(['投诉', '赞', '回复', '删除', '添加图片', '删除图片', '推荐到广播']);
  return !junk.has(text) && text.length <= 40;
}

function findMatchedReply(item, terms) {
  if (!item.replies?.length) return null;
  if (!terms.length) return item.replies[0];

  const reply = item.replies.find(entry => {
    const haystack = `${entry.author} ${entry.content}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });

  if (reply) return reply;

  return item.replies.find(entry => {
    const haystack = `${entry.author} ${entry.content}`.toLowerCase();
    return terms.some(term => haystack.includes(term));
  }) || null;
}

function shortenText(text, maxLength) {
  const value = cleanText(text);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}...`;
}

function highlightText(text, terms) {
  if (!terms.length) return text;
  let output = text;
  const uniqueTerms = [...new Set(terms)].sort((a, b) => b.length - a.length);
  uniqueTerms.forEach(term => {
    const escaped = escapeRegExp(term);
    output = output.replace(new RegExp(`(${escaped})`, 'ig'), '<mark>$1</mark>');
  });
  return output;
}

function setStatus(text, tone) {
  els.statusText.textContent = text;
  els.statusText.className = `status-pill${tone ? ` ${tone}` : ''}`;
}

async function ensurePermission(handle) {
  const current = await handle.queryPermission({ mode: 'read' });
  if (current === 'granted') return current;
  return handle.requestPermission({ mode: 'read' });
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      if (!db.objectStoreNames.contains(DATA_STORE)) db.createObjectStore(DATA_STORE);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function saveToStore(key, value, storeName = DATA_STORE) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(storeName).put(value, key);
  });
}

async function loadFromStore(key, storeName = DATA_STORE) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    tx.onerror = () => reject(tx.error);
    const request = tx.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
