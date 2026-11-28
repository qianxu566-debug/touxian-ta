import { isAndroidAppShell } from './reader.js?v=26';

const SHELF_KEY = 'touxian-shelf-v1';
const NATIVE_MIGRATED_KEY = 'touxian-shelf-native-migrated-v1';

let memoryCache = null;
let pendingMigrationNotice = null;

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

export function getNativeAppVersion() {
  const b = nativeBridge();
  if (!b || typeof b.getVersion !== 'function') return '';
  try {
    return String(b.getVersion() || '').trim();
  } catch {
    return '';
  }
}

export function shouldShowOldAppTip() {
  return isAndroidAppShell() && !hasNativeShelfBridge();
}

export function consumeShelfMigrationNotice() {
  const notice = pendingMigrationNotice;
  pendingMigrationNotice = null;
  return notice;
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

function parseMs(s) {
  const ms = Date.parse(s || '');
  return Number.isFinite(ms) ? ms : NaN;
}

function earlierIso(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const ma = parseMs(a);
  const mb = parseMs(b);
  if (Number.isFinite(ma) && Number.isFinite(mb)) return ma <= mb ? a : b;
  return String(a) <= String(b) ? a : b;
}

function laterIso(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const ma = parseMs(a);
  const mb = parseMs(b);
  if (Number.isFinite(ma) && Number.isFinite(mb)) return ma >= mb ? a : b;
  return String(a) >= String(b) ? a : b;
}

function mergeSnap(olderSnap = {}, newerSnap = {}) {
  const out = {};
  const keys = new Set([...Object.keys(olderSnap || {}), ...Object.keys(newerSnap || {})]);
  for (const k of keys) {
    const nv = newerSnap?.[k];
    const ov = olderSnap?.[k];
    const nHas = Array.isArray(nv) ? nv.length > 0 : (nv !== null && nv !== undefined && nv !== '');
    out[k] = nHas ? (Array.isArray(nv) ? [...nv] : nv) : (Array.isArray(ov) ? [...ov] : ov);
  }
  return out;
}

export function mergeShelfStates(nativeRaw, legacyRaw) {
  const nat = normalizeShelf(nativeRaw);
  const legState = normalizeShelf(legacyRaw);
  const items = { ...nat.items };
  let addedFromLocal = 0;
  let updatedFromLocal = 0;

  for (const [bid, leg] of Object.entries(legState.items)) {
    const cur = items[bid];
    if (!cur) {
      items[bid] = leg;
      addedFromLocal++;
      continue;
    }
    const legMs = parseMs(leg.updatedAt);
    const curMs = parseMs(cur.updatedAt);
    const legNewer = Number.isFinite(legMs) && (!Number.isFinite(curMs) || legMs > curMs);
    const nextAdded = earlierIso(cur.addedAt, leg.addedAt);
    if (legNewer) {
      items[bid] = {
        id: bid,
        state: leg.state,
        addedAt: nextAdded,
        updatedAt: leg.updatedAt,
        snap: mergeSnap(cur.snap, leg.snap),
      };
      updatedFromLocal++;
    } else {
      const mergedSnap = mergeSnap(leg.snap, cur.snap);
      const snapEnriched = JSON.stringify(mergedSnap) !== JSON.stringify(cur.snap || {});
      const addedChanged = nextAdded !== cur.addedAt;
      if (snapEnriched || addedChanged) {
        items[bid] = {
          ...cur,
          addedAt: nextAdded,
          snap: mergedSnap,
        };
        updatedFromLocal++;
      }
    }
  }

  const changed = addedFromLocal > 0 || updatedFromLocal > 0;
  const updatedAt = changed ? (laterIso(nat.updatedAt, legState.updatedAt) || new Date().toISOString()) : nat.updatedAt;
  return {
    state: { v: 1, updatedAt, items },
    changed,
    addedFromLocal,
    updatedFromLocal,
  };
}

function readNativeJson(bridge) {
  try {
    const nativeStr = bridge.getAll();
    if (!nativeStr) return { ok: true, data: null };
    if (typeof nativeStr !== 'string') return { ok: false, data: null };
    return { ok: true, data: JSON.parse(nativeStr) };
  } catch {
    return { ok: false, data: null };
  }
}

function readLocalJson() {
  try {
    const localStr = localStorage.getItem(SHELF_KEY);
    if (localStr) return JSON.parse(localStr);
  } catch {}
  return null;
}

function isOriginMigrated() {
  try {
    return localStorage.getItem(NATIVE_MIGRATED_KEY) === '1';
  } catch {
    return false;
  }
}

function markOriginMigrated() {
  try {
    localStorage.setItem(NATIVE_MIGRATED_KEY, '1');
  } catch {}
}

function writeNativeVerified(bridge, json) {
  try {
    const res = bridge.save(json);
    if (res === false) return false;
    const check = bridge.getAll();
    return check === json;
  } catch {
    return false;
  }
}

function readAndHydrateShelf() {
  const bridge = nativeBridge();
  if (!bridge) {
    return normalizeShelf(readLocalJson());
  }

  const natRes = readNativeJson(bridge);
  if (!natRes.ok) {
    return normalizeShelf(readLocalJson());
  }

  const nativeState = normalizeShelf(natRes.data);
  if (!isOriginMigrated()) {
    const localState = normalizeShelf(readLocalJson());
    if (Object.keys(localState.items).length > 0) {
      const merged = mergeShelfStates(nativeState, localState);
      if (merged.changed) {
        const mergedJson = JSON.stringify(merged.state);
        if (writeNativeVerified(bridge, mergedJson)) {
          try {
            localStorage.setItem(SHELF_KEY, mergedJson);
          } catch {}
          markOriginMigrated();
          if (merged.addedFromLocal > 0) {
            pendingMigrationNotice = {
              addedFromLocal: merged.addedFromLocal,
              total: Object.keys(merged.state.items).length,
            };
          }
        }
        return merged.state;
      }
      try {
        localStorage.setItem(SHELF_KEY, JSON.stringify(nativeState));
      } catch {}
      markOriginMigrated();
      return nativeState;
    }

    try {
      if (Object.keys(nativeState.items).length > 0 || localStorage.getItem(SHELF_KEY)) {
        localStorage.setItem(SHELF_KEY, JSON.stringify(nativeState));
      }
    } catch {}
    markOriginMigrated();
    return nativeState;
  }

  try {
    localStorage.setItem(SHELF_KEY, JSON.stringify(nativeState));
  } catch {}
  return nativeState;
}

function writeShelfState(nextState) {
  const json = JSON.stringify(nextState);
  const bridge = nativeBridge();
  if (bridge) {
    if (!writeNativeVerified(bridge, json)) {
      return { ok: false, error: '应用本机存储写入失败，请重试' };
    }
    try {
      localStorage.setItem(SHELF_KEY, json);
    } catch {}
    markOriginMigrated();
    memoryCache = nextState;
    return { ok: true };
  }

  try {
    localStorage.setItem(SHELF_KEY, json);
    const verify = localStorage.getItem(SHELF_KEY);
    if (!verify || verify !== json) {
      throw Error('STORAGE_VERIFY_MISMATCH');
    }
  } catch (err) {
    return { ok: false, error: err?.message || '浏览器存储写入失败，请检查隐私模式或磁盘空间' };
  }
  memoryCache = nextState;
  return { ok: true };
}

export function loadShelf({ forceReload = false } = {}) {
  if (!memoryCache || forceReload) {
    memoryCache = readAndHydrateShelf();
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
