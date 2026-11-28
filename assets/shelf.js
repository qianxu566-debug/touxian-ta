import { isStandaloneApp } from './reader.js?v=25';

const SHELF_KEY = 'touxian-shelf-v1';

let memoryCache = null;

function emptyShelf() {
  return { v: 1, updatedAt: '', items: {} };
}

function nativeBridge() {
  try {
    const b = window.TouxianNativeShelf;
    if (b && typeof b.getAll === 'function' && typeof b.save === 'function') return b;
  } catch {}
  return null;
}

export function hasNativeShelfBridge() {
  return Boolean(nativeBridge());
}

export function shouldShowOldAppTip() {
  return isStandaloneApp() && !hasNativeShelfBridge();
}

function normalizeShelf(raw) {
  if (!raw || typeof raw !== 'object') return emptyShelf();
  const srcItems = raw.items && typeof raw.items === 'object' ? raw.items : {};
  const cleanItems = {};
  for (const [k, item] of Object.entries(srcItems)) {
    if (!item || typeof item !== 'object') continue;
    const bid = String(item.id || k || '').trim();
    if (!bid) continue;
    cleanItems[bid] = {
      id: bid,
      state: item.state === 'reading' || item.state === 'done' ? item.state : 'want',
      addedAt: item.addedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.addedAt || new Date().toISOString(),
      snap: item.snap && typeof item.snap === 'object' ? { ...item.snap } : {},
    };
  }
  return {
    v: 1,
    updatedAt: String(raw.updatedAt || ''),
    items: cleanItems,
  };
}

function readRawJson() {
  const bridge = nativeBridge();
  if (bridge) {
    try {
      const nativeStr = bridge.getAll();
      if (nativeStr && typeof nativeStr === 'string') {
        return JSON.parse(nativeStr);
      }
    } catch {}
  }
  try {
    const localStr = localStorage.getItem(SHELF_KEY);
    if (localStr) return JSON.parse(localStr);
  } catch {}
  return null;
}

function writeShelfState(nextState) {
  const json = JSON.stringify(nextState);
  const bridge = nativeBridge();
  let bridgeOk = true;
  if (bridge) {
    try {
      const res = bridge.save(json);
      if (res === false) bridgeOk = false;
    } catch {
      bridgeOk = false;
    }
  }
  try {
    localStorage.setItem(SHELF_KEY, json);
    const verify = localStorage.getItem(SHELF_KEY);
    if (!verify || verify !== json) {
      throw Error('STORAGE_VERIFY_MISMATCH');
    }
  } catch (err) {
    if (!bridge || !bridgeOk) {
      return { ok: false, error: err?.message || '浏览器存储写入失败，请检查隐私模式或磁盘空间' };
    }
  }
  if (!bridgeOk && bridge) {
    return { ok: false, error: '应用本机存储写入失败，请重试' };
  }
  memoryCache = nextState;
  return { ok: true };
}

export function loadShelf({ forceReload = false } = {}) {
  if (!memoryCache || forceReload) {
    memoryCache = normalizeShelf(readRawJson());
  }
  return memoryCache;
}

export function hasBook(id) {
  const bid = String(id || '').trim();
  if (!bid) return false;
  return Boolean(loadShelf().items[bid]);
}

export function getShelfItem(id) {
  const bid = String(id || '').trim();
  if (!bid) return null;
  return loadShelf().items[bid] || null;
}

export function listShelfItems() {
  const items = Object.values(loadShelf().items);
  return items.sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')) || String(a.id).localeCompare(String(b.id)));
}

export function shelfCount() {
  return Object.keys(loadShelf().items).length;
}

function buildSnapshot(book, obsDate = '', prevSnap = {}) {
  const cleanCover = typeof book?.coverUrl === 'string' && book.coverUrl.startsWith('https://')
    ? book.coverUrl
    : (prevSnap.coverUrl || '');
  return {
    title: String(book?.title || prevSnap.title || '').trim(),
    author: String(book?.author || prevSnap.author || '').trim(),
    primary: Array.isArray(book?.primary) && book.primary.length ? book.primary.slice(0, 3) : (prevSnap.primary || []),
    channel: String(book?.channel || prevSnap.channel || ''),
    words: Number.isFinite(book?.words) ? book.words : (prevSnap.words ?? null),
    status: String(book?.status || prevSnap.status || ''),
    readers: Number.isFinite(book?.readers) ? book.readers : (prevSnap.readers ?? null),
    score: Number.isFinite(book?.score) && book.score > 0 ? book.score : (prevSnap.score ?? null),
    scoreCount: Number.isFinite(book?.scoreCount) && book.scoreCount > 0 ? book.scoreCount : (prevSnap.scoreCount ?? null),
    coverUrl: cleanCover,
    obsDate: String(obsDate || prevSnap.obsDate || ''),
  };
}

export function saveBookToShelf(book, obsDate = '') {
  const bid = String(book?.id || '').trim();
  if (!bid) return { ok: false, added: false, error: '无效书号' };
  const current = loadShelf({ forceReload: true });
  const existing = current.items[bid];
  const nowIso = new Date().toISOString();
  const nextItem = {
    id: bid,
    state: existing?.state || 'want',
    addedAt: existing?.addedAt || nowIso,
    updatedAt: nowIso,
    snap: buildSnapshot(book, obsDate, existing?.snap),
  };
  const nextState = {
    v: 1,
    updatedAt: nowIso,
    items: { ...current.items, [bid]: nextItem },
  };
  const writeRes = writeShelfState(nextState);
  if (!writeRes.ok) {
    return { ok: false, added: false, error: writeRes.error };
  }
  return { ok: true, added: !existing, item: nextItem };
}

export function removeBookFromShelf(id) {
  const bid = String(id || '').trim();
  if (!bid) return { ok: false, removed: false, error: '无效书号' };
  const current = loadShelf({ forceReload: true });
  if (!current.items[bid]) {
    return { ok: true, removed: false };
  }
  const nextItems = { ...current.items };
  delete nextItems[bid];
  const nextState = {
    v: 1,
    updatedAt: new Date().toISOString(),
    items: nextItems,
  };
  const writeRes = writeShelfState(nextState);
  if (!writeRes.ok) {
    return { ok: false, removed: false, error: writeRes.error };
  }
  return { ok: true, removed: true };
}

export function toggleShelfBook(book, obsDate = '') {
  const bid = String(book?.id || '').trim();
  if (!bid) return { ok: false, saved: false, error: '无效书号' };
  if (hasBook(bid)) {
    const res = removeBookFromShelf(bid);
    return { ...res, saved: !res.ok };
  }
  const res = saveBookToShelf(book, obsDate);
  return { ...res, saved: res.ok };
}

export function refreshShelfSnapshots(lookupFn, obsDate = '') {
  if (typeof lookupFn !== 'function') return;
  const current = loadShelf();
  const ids = Object.keys(current.items);
  if (!ids.length) return;
  let changed = false;
  const nextItems = { ...current.items };
  for (const bid of ids) {
    const live = lookupFn(bid);
    if (!live) continue;
    const prev = nextItems[bid];
    const nextSnap = buildSnapshot(live, obsDate, prev.snap);
    if (
      nextSnap.readers !== prev.snap?.readers ||
      nextSnap.words !== prev.snap?.words ||
      nextSnap.status !== prev.snap?.status ||
      nextSnap.score !== prev.snap?.score ||
      (obsDate && obsDate !== prev.snap?.obsDate)
    ) {
      nextItems[bid] = { ...prev, snap: nextSnap };
      changed = true;
    }
  }
  if (changed) {
    writeShelfState({ v: 1, updatedAt: new Date().toISOString(), items: nextItems });
  }
}
