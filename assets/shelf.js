import { isAndroidAppShell } from './reader.js?v=29';

const SHELF_KEY = 'touxian-shelf-v1';
const NATIVE_MIGRATED_KEY = 'touxian-shelf-native-migrated-v1';

export const DEFAULT_FATTEN_WORDS = 500000;
export const MIN_FATTEN_WORDS = 50000;
export const MAX_FATTEN_WORDS = 10000000;
export const MAX_HISTORY = 50;
export const MAX_BLOCKED_BOOKS = 500;
export const MAX_BLOCK_LIST = 300;
export const MAX_BACKUP_BYTES = 3900000;

let memoryCache = null;
let pendingMigrationNotice = null;
let activeIdentity = 'guest';

function cleanIdentity(id) {
  const s = String(id || '').trim();
  return s || 'guest';
}

export function getActiveIdentity() {
  return activeIdentity;
}

export function setActiveIdentity(id) {
  activeIdentity = cleanIdentity(id);
  return activeIdentity;
}

function emptyShelf() {
  return {
    v: 1,
    updatedAt: '',
    items: {},
    prefs: { defaultFattenWords: DEFAULT_FATTEN_WORDS },
    history: [],
    histories: { guest: [] },
    blocks: { books: {}, tags: [], keywords: [] },
  };
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

export function normalizeFattenWords(val, fallback = null) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(MIN_FATTEN_WORDS, Math.min(MAX_FATTEN_WORDS, Math.round(n)));
}

function normalizeFattenMode(mode) {
  return mode === 'completed' || mode === 'date' ? mode : 'words';
}

function normalizeFattenDate(d) {
  const s = String(d || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function utf8ByteLength(str) {
  try {
    return new TextEncoder().encode(String(str || '')).length;
  } catch {
    return String(str || '').length * 3;
  }
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

function cleanSnap(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return {};
  return { ...snap };
}

function normalizeStrList(raw, limit = MAX_BLOCK_LIST) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeHistoryList(histRaw) {
  if (!Array.isArray(histRaw)) return [];
  const histById = new Map();
  for (const h of histRaw) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    const bid = String(h.id || '').trim();
    if (!bid) continue;
    const viewedAt = String(h.viewedAt || '').trim() || new Date().toISOString();
    const prev = histById.get(bid);
    if (!prev || laterIso(prev.viewedAt, viewedAt) === viewedAt) {
      histById.set(bid, {
        id: bid,
        viewedAt,
        snap: cleanSnap(h.snap),
      });
    }
  }
  return [...histById.values()]
    .sort((a, b) => (parseMs(b.viewedAt) || 0) - (parseMs(a.viewedAt) || 0) || String(b.viewedAt).localeCompare(String(a.viewedAt)))
    .slice(0, MAX_HISTORY);
}

function mergeHistoryLists(baseList = [], incList = []) {
  const histMap = new Map();
  let added = 0;
  for (const h of baseList) histMap.set(h.id, h);
  for (const h of incList) {
    const prev = histMap.get(h.id);
    if (!prev) {
      histMap.set(h.id, h);
      added++;
    } else if (laterIso(prev.viewedAt, h.viewedAt) === h.viewedAt && h.viewedAt !== prev.viewedAt) {
      histMap.set(h.id, { id: h.id, viewedAt: h.viewedAt, snap: mergeSnap(prev.snap, h.snap) });
    }
  }
  const merged = [...histMap.values()]
    .sort((a, b) => (parseMs(b.viewedAt) || 0) - (parseMs(a.viewedAt) || 0) || String(b.viewedAt).localeCompare(String(a.viewedAt)))
    .slice(0, MAX_HISTORY);
  return { merged, added };
}

function normalizeShelf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyShelf();
  const srcItems = raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {};
  const cleanItems = {};
  for (const [k, item] of Object.entries(srcItems)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const bid = String(item.id || k || '').trim();
    if (!bid) continue;
    const customTarget = item.fattenTargetWords != null ? normalizeFattenWords(item.fattenTargetWords, null) : null;
    cleanItems[bid] = {
      id: bid,
      state: item.state === 'reading' || item.state === 'done' ? item.state : 'want',
      fatten: Boolean(item.fatten),
      fattenMode: normalizeFattenMode(item.fattenMode),
      fattenTargetWords: customTarget,
      fattenTargetDate: normalizeFattenDate(item.fattenTargetDate),
      fattenAckKey: String(item.fattenAckKey || '').trim(),
      addedAt: item.addedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || item.addedAt || new Date().toISOString(),
      snap: cleanSnap(item.snap),
    };
  }

  const defaultFattenWords = normalizeFattenWords(raw.prefs?.defaultFattenWords, DEFAULT_FATTEN_WORDS);

  const histories = {};
  if (raw.histories && typeof raw.histories === 'object' && !Array.isArray(raw.histories)) {
    for (const [ident, list] of Object.entries(raw.histories)) {
      const cid = cleanIdentity(ident);
      const normList = normalizeHistoryList(list);
      histories[cid] = histories[cid] ? mergeHistoryLists(histories[cid], normList).merged : normList;
    }
  }
  const legacyTopHistory = normalizeHistoryList(raw.history);
  if (legacyTopHistory.length) {
    histories.guest = histories.guest ? mergeHistoryLists(histories.guest, legacyTopHistory).merged : legacyTopHistory;
  }
  if (!histories.guest) histories.guest = [];

  const booksRaw = raw.blocks?.books && typeof raw.blocks.books === 'object' && !Array.isArray(raw.blocks.books) ? raw.blocks.books : {};
  const cleanBlockedBooks = {};
  const bookEntries = Object.entries(booksRaw);
  for (let i = 0; i < bookEntries.length && Object.keys(cleanBlockedBooks).length < MAX_BLOCKED_BOOKS; i++) {
    const [k, b] = bookEntries[i];
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    const bid = String(b.id || k || '').trim();
    if (!bid) continue;
    cleanBlockedBooks[bid] = {
      id: bid,
      title: String(b.title || '').trim(),
      author: String(b.author || '').trim(),
      addedAt: String(b.addedAt || '').trim() || new Date().toISOString(),
    };
  }

  return {
    v: 1,
    updatedAt: String(raw.updatedAt || ''),
    items: cleanItems,
    prefs: { defaultFattenWords },
    history: histories.guest,
    histories,
    blocks: {
      books: cleanBlockedBooks,
      tags: normalizeStrList(raw.blocks?.tags, MAX_BLOCK_LIST),
      keywords: normalizeStrList(raw.blocks?.keywords, MAX_BLOCK_LIST),
    },
  };
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

export function mergeShelfStates(nativeRaw, legacyRaw, { historyTargetIdentity = null } = {}) {
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
        fatten: leg.fatten,
        fattenMode: leg.fattenMode,
        fattenTargetWords: leg.fattenTargetWords ?? cur.fattenTargetWords ?? null,
        fattenTargetDate: leg.fattenTargetDate || cur.fattenTargetDate || '',
        fattenAckKey: leg.fattenAckKey || '',
        addedAt: nextAdded,
        updatedAt: leg.updatedAt,
        snap: mergeSnap(cur.snap, leg.snap),
      };
      updatedFromLocal++;
    } else {
      const mergedSnap = mergeSnap(leg.snap, cur.snap);
      const nextFatten = cur.fatten || (!cur.updatedAt && leg.fatten);
      const nextMode = cur.fatten ? cur.fattenMode : (leg.fattenMode || cur.fattenMode);
      const nextTarget = cur.fattenTargetWords ?? leg.fattenTargetWords ?? null;
      const nextDate = cur.fattenTargetDate || leg.fattenTargetDate || '';
      const nextAck = cur.fattenAckKey || leg.fattenAckKey || '';
      const snapEnriched = JSON.stringify(mergedSnap) !== JSON.stringify(cur.snap || {});
      const metaChanged =
        nextAdded !== cur.addedAt ||
        nextFatten !== cur.fatten ||
        nextMode !== cur.fattenMode ||
        nextTarget !== cur.fattenTargetWords ||
        nextDate !== cur.fattenTargetDate ||
        nextAck !== cur.fattenAckKey;
      if (snapEnriched || metaChanged) {
        items[bid] = {
          ...cur,
          fatten: nextFatten,
          fattenMode: nextMode,
          fattenTargetWords: nextTarget,
          fattenTargetDate: nextDate,
          fattenAckKey: nextAck,
          addedAt: nextAdded,
          snap: mergedSnap,
        };
        updatedFromLocal++;
      }
    }
  }

  // Merge histories
  const mergedHistories = {};
  for (const [k, v] of Object.entries(nat.histories || {})) {
    mergedHistories[k] = [...v];
  }
  let historyAdded = 0;

  if (historyTargetIdentity) {
    const tid = cleanIdentity(historyTargetIdentity);
    const incList = legState.histories?.[tid]?.length
      ? legState.histories[tid]
      : (legState.histories?.guest || legState.history || []);
    const res = mergeHistoryLists(mergedHistories[tid] || [], incList);
    mergedHistories[tid] = res.merged;
    historyAdded += res.added;
  } else {
    for (const [ident, incList] of Object.entries(legState.histories || {})) {
      const res = mergeHistoryLists(mergedHistories[ident] || [], incList);
      mergedHistories[ident] = res.merged;
      historyAdded += res.added;
    }
  }
  if (!mergedHistories.guest) mergedHistories.guest = [];

  // Merge blocks (union)
  const mergedBlockBooks = { ...nat.blocks.books };
  let blockBooksAdded = 0;
  for (const [bid, bk] of Object.entries(legState.blocks.books)) {
    if (!mergedBlockBooks[bid] && Object.keys(mergedBlockBooks).length < MAX_BLOCKED_BOOKS) {
      mergedBlockBooks[bid] = bk;
      blockBooksAdded++;
    }
  }
  const tagSet = new Set(nat.blocks.tags);
  let blockTagsAdded = 0;
  for (const t of legState.blocks.tags) {
    if (!tagSet.has(t) && tagSet.size < MAX_BLOCK_LIST) {
      tagSet.add(t);
      blockTagsAdded++;
    }
  }
  const kwSet = new Set(nat.blocks.keywords);
  let blockKeywordsAdded = 0;
  for (const kw of legState.blocks.keywords) {
    if (!kwSet.has(kw) && kwSet.size < MAX_BLOCK_LIST) {
      kwSet.add(kw);
      blockKeywordsAdded++;
    }
  }

  // Merge prefs
  let defaultFattenWords = nat.prefs.defaultFattenWords;
  let prefsChanged = false;
  if (defaultFattenWords === DEFAULT_FATTEN_WORDS && legState.prefs.defaultFattenWords !== DEFAULT_FATTEN_WORDS) {
    defaultFattenWords = legState.prefs.defaultFattenWords;
    prefsChanged = true;
  }

  const changed =
    addedFromLocal > 0 ||
    updatedFromLocal > 0 ||
    historyAdded > 0 ||
    blockBooksAdded > 0 ||
    blockTagsAdded > 0 ||
    blockKeywordsAdded > 0 ||
    prefsChanged;

  const updatedAt = changed ? (laterIso(nat.updatedAt, legState.updatedAt) || new Date().toISOString()) : nat.updatedAt;
  return {
    state: {
      v: 1,
      updatedAt,
      items,
      prefs: { defaultFattenWords },
      history: mergedHistories.guest,
      histories: mergedHistories,
      blocks: {
        books: mergedBlockBooks,
        tags: [...tagSet],
        keywords: [...kwSet],
      },
    },
    changed,
    addedFromLocal,
    updatedFromLocal,
    historyAdded,
    blockBooksAdded,
    blockTagsAdded,
    blockKeywordsAdded,
    prefsChanged,
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
    const hasLocalHist = Object.values(localState.histories || {}).some((l) => l.length > 0);
    const hasLocal =
      Object.keys(localState.items).length > 0 ||
      hasLocalHist ||
      Object.keys(localState.blocks.books).length > 0 ||
      localState.blocks.tags.length > 0 ||
      localState.blocks.keywords.length > 0;
    if (hasLocal) {
      const merged = mergeShelfStates(nativeState, localState);
      if (merged.changed) {
        const mergedJson = JSON.stringify(merged.state);
        if (utf8ByteLength(mergedJson) <= MAX_BACKUP_BYTES && writeNativeVerified(bridge, mergedJson)) {
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
  const normalized = normalizeShelf(nextState);
  const json = JSON.stringify(normalized);
  if (utf8ByteLength(json) > MAX_BACKUP_BYTES) {
    return { ok: false, error: '本机存储体积超出安全上限，未能写入（原数据已完整保留）' };
  }
  const bridge = nativeBridge();
  if (bridge) {
    if (!writeNativeVerified(bridge, json)) {
      return { ok: false, error: '应用本机存储写入失败，请重试（原数据已保留）' };
    }
    try {
      localStorage.setItem(SHELF_KEY, json);
    } catch {}
    markOriginMigrated();
    memoryCache = normalized;
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
  memoryCache = normalized;
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

export function getDefaultFattenWords() {
  return loadShelf().prefs?.defaultFattenWords || DEFAULT_FATTEN_WORDS;
}

export function setDefaultFattenWords(words) {
  const clean = normalizeFattenWords(words, null);
  if (!clean) return { ok: false, error: '目标字数须在 5 万～1000 万字之间' };
  const current = loadShelf({ forceReload: true });
  const nextState = {
    ...current,
    updatedAt: new Date().toISOString(),
    prefs: { ...current.prefs, defaultFattenWords: clean },
  };
  const writeRes = writeShelfState(nextState);
  return writeRes.ok ? { ok: true, words: clean } : writeRes;
}

function buildSnapshot(book, obsDate = '', prevSnap = {}) {
  const cleanCover = typeof book?.coverUrl === 'string' && book.coverUrl.startsWith('https://')
    ? book.coverUrl
    : (prevSnap.coverUrl || '');
  const cleanUpd = Number.isFinite(book?.lastUpdate) && book.lastUpdate > 946684800
    ? book.lastUpdate
    : (prevSnap.lastUpdate ?? null);
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
    lastUpdate: cleanUpd,
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
    fatten: Boolean(existing?.fatten),
    fattenMode: normalizeFattenMode(existing?.fattenMode),
    fattenTargetWords: existing?.fattenTargetWords ?? null,
    fattenTargetDate: existing?.fattenTargetDate || '',
    fattenAckKey: existing?.fattenAckKey || '',
    addedAt: existing?.addedAt || nowIso,
    updatedAt: nowIso,
    snap: buildSnapshot(book, obsDate, existing?.snap),
  };
  const nextState = {
    ...current,
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
    ...current,
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

export function setShelfItemState(id, nextStateVal) {
  const bid = String(id || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };
  const valid = nextStateVal === 'reading' || nextStateVal === 'done' ? nextStateVal : nextStateVal === 'want' ? 'want' : '';
  if (!valid) return { ok: false, error: '无效书篓状态' };
  const current = loadShelf({ forceReload: true });
  const existing = current.items[bid];
  if (!existing) return { ok: false, error: '该作品尚未加入书篓' };
  const nowIso = new Date().toISOString();
  const nextItem = {
    ...existing,
    state: valid,
    updatedAt: nowIso,
  };
  const writeRes = writeShelfState({
    ...current,
    updatedAt: nowIso,
    items: { ...current.items, [bid]: nextItem },
  });
  return writeRes.ok ? { ok: true, item: nextItem } : writeRes;
}

export function setShelfItemFatten(id, enabled, targetWords = undefined) {
  const bid = String(id || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };
  const current = loadShelf({ forceReload: true });
  const existing = current.items[bid];
  if (!existing) return { ok: false, error: '请先将作品加入书篓' };
  const nowIso = new Date().toISOString();
  let nextTarget = existing.fattenTargetWords ?? null;
  if (targetWords === null) {
    nextTarget = null;
  } else if (targetWords !== undefined) {
    const cleanT = normalizeFattenWords(targetWords, null);
    if (!cleanT) return { ok: false, error: '目标字数须在 5 万～1000 万字之间' };
    nextTarget = cleanT;
  }
  const nextItem = {
    ...existing,
    fatten: Boolean(enabled),
    fattenMode: existing.fattenMode || 'words',
    fattenTargetWords: nextTarget,
    fattenAckKey: enabled ? existing.fattenAckKey : '',
    updatedAt: nowIso,
  };
  const writeRes = writeShelfState({
    ...current,
    updatedAt: nowIso,
    items: { ...current.items, [bid]: nextItem },
  });
  return writeRes.ok ? { ok: true, item: nextItem } : writeRes;
}

export function configureBookFatten(bookOrId, opts = {}, obsDate = '') {
  const isObj = bookOrId && typeof bookOrId === 'object';
  const bid = String(isObj ? bookOrId.id : bookOrId || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };

  const current = loadShelf({ forceReload: true });
  const existing = current.items[bid];
  const fattenMode = normalizeFattenMode(opts.mode);

  let nextWords = existing?.fattenTargetWords ?? null;
  let nextDate = existing?.fattenTargetDate || '';

  if (fattenMode === 'words') {
    if (opts.targetWords === null) {
      nextWords = null;
    } else if (opts.targetWords !== undefined) {
      const cleanT = normalizeFattenWords(opts.targetWords, null);
      if (!cleanT) return { ok: false, error: '目标字数须在 5 万～1000 万字之间' };
      nextWords = cleanT;
    }
  } else if (fattenMode === 'date') {
    const cleanD = normalizeFattenDate(opts.targetDate);
    if (!cleanD) return { ok: false, error: '请选择有效的养肥到期日期' };
    nextDate = cleanD;
  }

  const nowIso = new Date().toISOString();
  const nextItem = {
    id: bid,
    state: existing?.state || 'want', // Preserve existing want/reading/done state cleanly
    fatten: true,
    fattenMode,
    fattenTargetWords: nextWords,
    fattenTargetDate: nextDate,
    fattenAckKey: '',
    addedAt: existing?.addedAt || nowIso,
    updatedAt: nowIso,
    snap: isObj ? buildSnapshot(bookOrId, obsDate, existing?.snap) : cleanSnap(existing?.snap),
  };

  let nextPrefs = current.prefs;
  if (fattenMode === 'words' && opts.rememberDefault && nextWords) {
    nextPrefs = { ...current.prefs, defaultFattenWords: nextWords };
  }

  const writeRes = writeShelfState({
    ...current,
    updatedAt: nowIso,
    prefs: nextPrefs,
    items: { ...current.items, [bid]: nextItem },
  });
  return writeRes.ok ? { ok: true, added: !existing, item: nextItem } : writeRes;
}

export function cancelBookFatten(id) {
  const bid = String(id || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };
  const current = loadShelf({ forceReload: true });
  const existing = current.items[bid];
  if (!existing) return { ok: true };
  const nowIso = new Date().toISOString();
  const nextItem = {
    ...existing,
    fatten: false,
    fattenAckKey: '',
    updatedAt: nowIso,
  };
  const writeRes = writeShelfState({
    ...current,
    updatedAt: nowIso,
    items: { ...current.items, [bid]: nextItem },
  });
  return writeRes.ok ? { ok: true, item: nextItem } : writeRes;
}

export function acknowledgeFattenReady(ackMap) {
  if (!ackMap || (typeof ackMap !== 'object' && !(ackMap instanceof Map))) return { ok: true, count: 0 };
  const entries = ackMap instanceof Map ? [...ackMap.entries()] : Object.entries(ackMap);
  if (!entries.length) return { ok: true, count: 0 };
  const current = loadShelf({ forceReload: true });
  let count = 0;
  const nextItems = { ...current.items };
  for (const [bid, evKey] of entries) {
    const it = nextItems[bid];
    if (!it || !evKey || it.fattenAckKey === evKey) continue;
    nextItems[bid] = { ...it, fattenAckKey: String(evKey) };
    count++;
  }
  if (!count) return { ok: true, count: 0 };
  const writeRes = writeShelfState({
    ...current,
    items: nextItems,
  });
  return writeRes.ok ? { ok: true, count } : writeRes;
}

function fmtWanWords(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 10000) {
    const w = n / 10000;
    return `${Number(w.toFixed(1))} 万字`;
  }
  return `${Math.round(n)} 字`;
}

export function evaluateFattenAlerts(
  item,
  liveBook = null,
  refNowSec = Math.floor(Date.now() / 1000),
  defaultTarget = getDefaultFattenWords(),
  todayStr = ''
) {
  if (!item?.fatten) {
    return {
      active: false,
      mode: 'words',
      isReady: false,
      isUnackedReady: false,
      eventKey: '',
      alerts: [],
      warnBadges: [],
      hasAlert: false,
      targetWords: defaultTarget || DEFAULT_FATTEN_WORDS,
      targetDate: '',
      targetDesc: '',
      currentWords: null,
      progressPct: 0,
    };
  }
  const snap = item.snap || {};
  const words = Number.isFinite(liveBook?.words) ? liveBook.words : (Number.isFinite(snap.words) ? snap.words : null);
  const status = liveBook?.status || snap.status || '';
  const lastUpdate = Number.isFinite(liveBook?.lastUpdate) && liveBook.lastUpdate > 946684800
    ? liveBook.lastUpdate
    : (Number.isFinite(snap.lastUpdate) && snap.lastUpdate > 946684800 ? snap.lastUpdate : null);

  const mode = normalizeFattenMode(item.fattenMode);
  const targetWords = item.fattenTargetWords || defaultTarget || DEFAULT_FATTEN_WORDS;
  const targetDate = normalizeFattenDate(item.fattenTargetDate);
  const progressPct = Number.isFinite(words) && targetWords > 0 ? Math.min(100, Math.round((words / targetWords) * 100)) : 0;

  const alerts = [];
  const warnBadges = [];
  let isReady = false;
  let eventKey = '';
  let targetDesc = '';

  if (mode === 'completed') {
    targetDesc = '等完结';
    if (status === '已完结') {
      isReady = true;
      eventKey = 'completed:done';
      alerts.push({ kind: 'completed', tone: 'accent', label: '已完结 · 可开宰' });
    }
  } else if (mode === 'date') {
    targetDesc = targetDate ? `养至 ${targetDate.slice(5)}` : '按日期养肥';
    if (targetDate && todayStr && todayStr >= targetDate) {
      isReady = true;
      eventKey = `date:${targetDate}`;
      alerts.push({ kind: 'date_ready', tone: 'up', label: `已到期（${targetDate.slice(5)}）` });
    } else if (status === '已完结') {
      // User confirmed: completed triggers ready alert even before target date
      isReady = true;
      eventKey = `date_done:${targetDate}`;
      alerts.push({ kind: 'completed', tone: 'accent', label: '已完结 · 可开宰' });
    }
  } else {
    targetDesc = `目标 ${fmtWanWords(targetWords)}`;
    if (Number.isFinite(words) && words >= targetWords) {
      isReady = true;
      eventKey = `words:${targetWords}`;
      alerts.push({ kind: 'words_ready', tone: 'up', label: `已达 ${fmtWanWords(words)}（目标 ${fmtWanWords(targetWords)}）` });
    } else if (status === '已完结') {
      // User confirmed: completed triggers ready alert even before target words
      isReady = true;
      eventKey = `words_done:${targetWords}`;
      alerts.push({ kind: 'completed', tone: 'accent', label: `已完结 · 可开宰（${fmtWanWords(words) || '完本'}）` });
    }
  }

  // Only mark stalled when known to be serializing and valid lastUpdate timestamp > 10d old; missing obs never triggers stall
  if (status === '连载中' && Number.isFinite(lastUpdate) && lastUpdate > 946684800) {
    const idleDays = Math.floor((refNowSec - lastUpdate) / 86400);
    if (idleDays > 10) {
      warnBadges.push({ kind: 'stalled', tone: 'warn', label: `停更 ${idleDays} 天` });
    }
  }

  const isUnackedReady = Boolean(isReady && eventKey && item.fattenAckKey !== eventKey);

  return {
    active: true,
    mode,
    isReady,
    isUnackedReady,
    eventKey,
    alerts,
    warnBadges,
    hasAlert: isReady,
    targetWords,
    targetDate,
    targetDesc,
    currentWords: words,
    progressPct,
  };
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
      nextSnap.lastUpdate !== prev.snap?.lastUpdate ||
      (obsDate && obsDate !== prev.snap?.obsDate)
    ) {
      nextItems[bid] = { ...prev, snap: nextSnap };
      changed = true;
    }
  }
  if (changed) {
    writeShelfState({ ...current, updatedAt: new Date().toISOString(), items: nextItems });
  }
}

// --- History (50-book Footprint partitioned by local identity) ---
export function listHistoryItems(identity = activeIdentity) {
  const cid = cleanIdentity(identity);
  const shelf = loadShelf();
  return [...(shelf.histories?.[cid] || [])];
}

export function getHistoryItem(id, identity = activeIdentity) {
  const bid = String(id || '').trim();
  if (!bid) return null;
  return listHistoryItems(identity).find((h) => h.id === bid) || null;
}

export function recordHistoryBook(book, obsDate = '', identity = activeIdentity) {
  const bid = String(book?.id || '').trim();
  if (!bid || !book?.title) return { ok: false };
  const cid = cleanIdentity(identity);
  const current = loadShelf({ forceReload: true });
  const hist = current.histories?.[cid] || [];
  const existing = hist.find((h) => h.id === bid);
  const nowMs = Date.now();
  if (hist[0]?.id === bid && (nowMs - (parseMs(hist[0].viewedAt) || 0)) < 5000 && hist[0].snap?.title === String(book.title || '').trim()) {
    return { ok: true, skipped: true };
  }
  const nowIso = new Date(nowMs).toISOString();
  const nextEntry = {
    id: bid,
    viewedAt: nowIso,
    snap: buildSnapshot(book, obsDate, existing?.snap),
  };
  const nextHist = [nextEntry, ...hist.filter((h) => h.id !== bid)].slice(0, MAX_HISTORY);
  const nextHistories = { ...(current.histories || {}), [cid]: nextHist };
  return writeShelfState({
    ...current,
    updatedAt: nowIso,
    history: nextHistories.guest || [],
    histories: nextHistories,
  });
}

export function removeHistoryBook(id, identity = activeIdentity) {
  const bid = String(id || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };
  const cid = cleanIdentity(identity);
  const current = loadShelf({ forceReload: true });
  const hist = current.histories?.[cid] || [];
  const nextHist = hist.filter((h) => h.id !== bid);
  if (nextHist.length === hist.length) return { ok: true };
  const nextHistories = { ...(current.histories || {}), [cid]: nextHist };
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    history: nextHistories.guest || [],
    histories: nextHistories,
  });
}

export function clearHistoryBooks(identity = activeIdentity) {
  const cid = cleanIdentity(identity);
  const current = loadShelf({ forceReload: true });
  const hist = current.histories?.[cid] || [];
  if (!hist.length) return { ok: true };
  const nextHistories = { ...(current.histories || {}), [cid]: [] };
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    history: nextHistories.guest || [],
    histories: nextHistories,
  });
}

// --- Blocklist (Single Book / Tag / Keyword; NO Author-Wide Blocking) ---
const normMatch = (v) => String(v || '').normalize('NFKC').toLowerCase();

export function getBlocks() {
  const b = loadShelf().blocks || { books: {}, tags: [], keywords: [] };
  const bookList = Object.values(b.books || {}).sort((x, y) => String(y.addedAt || '').localeCompare(String(x.addedAt || '')));
  return {
    books: bookList,
    bookMap: b.books || {},
    tags: [...(b.tags || [])],
    keywords: [...(b.keywords || [])],
  };
}

export function totalBlockCount() {
  const b = loadShelf().blocks || { books: {}, tags: [], keywords: [] };
  return Object.keys(b.books || {}).length + (b.tags?.length || 0) + (b.keywords?.length || 0);
}

export function isBookBlocked(id) {
  const bid = String(id || '').trim();
  if (!bid) return false;
  return Boolean(loadShelf().blocks?.books?.[bid]);
}

export function blockBook(book) {
  const bid = String(book?.id || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };
  const current = loadShelf({ forceReload: true });
  const curBooks = current.blocks?.books || {};
  if (!curBooks[bid] && Object.keys(curBooks).length >= MAX_BLOCKED_BOOKS) {
    return { ok: false, error: `单书屏蔽最多保留 ${MAX_BLOCKED_BOOKS} 本` };
  }
  const nowIso = new Date().toISOString();
  const nextBooks = {
    ...curBooks,
    [bid]: {
      id: bid,
      title: String(book?.title || `作品 ${bid}`).trim(),
      author: String(book?.author || '').trim(),
      addedAt: curBooks[bid]?.addedAt || nowIso,
    },
  };
  return writeShelfState({
    ...current,
    updatedAt: nowIso,
    blocks: { ...current.blocks, books: nextBooks },
  });
}

export function unblockBook(id) {
  const bid = String(id || '').trim();
  if (!bid) return { ok: false, error: '无效书号' };
  const current = loadShelf({ forceReload: true });
  if (!current.blocks?.books?.[bid]) return { ok: true };
  const nextBooks = { ...current.blocks.books };
  delete nextBooks[bid];
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { ...current.blocks, books: nextBooks },
  });
}

export function addBlockedTag(tag) {
  const clean = String(tag || '').trim();
  if (!clean) return { ok: false, error: '请输入要屏蔽的标签名称' };
  const current = loadShelf({ forceReload: true });
  const tags = current.blocks?.tags || [];
  if (tags.includes(clean)) return { ok: true, duplicate: true };
  if (tags.length >= MAX_BLOCK_LIST) return { ok: false, error: `最多屏蔽 ${MAX_BLOCK_LIST} 个标签` };
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { ...current.blocks, tags: [clean, ...tags] },
  });
}

export function setBlockedTagsBatch(tagsArray) {
  const cleanTags = normalizeStrList(tagsArray, MAX_BLOCK_LIST);
  if (Array.isArray(tagsArray) && tagsArray.length > MAX_BLOCK_LIST) {
    return { ok: false, error: `最多屏蔽 ${MAX_BLOCK_LIST} 个标签` };
  }
  const current = loadShelf({ forceReload: true });
  const writeRes = writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { ...current.blocks, tags: cleanTags },
  });
  return writeRes.ok ? { ok: true, tags: cleanTags } : writeRes;
}

export function removeBlockedTag(tag) {
  const clean = String(tag || '').trim();
  const current = loadShelf({ forceReload: true });
  const nextTags = (current.blocks?.tags || []).filter((t) => t !== clean);
  if (nextTags.length === (current.blocks?.tags || []).length) return { ok: true };
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { ...current.blocks, tags: nextTags },
  });
}

export function addBlockedKeyword(kw) {
  const clean = String(kw || '').trim();
  if (!clean) return { ok: false, error: '请输入要屏蔽的关键词' };
  const current = loadShelf({ forceReload: true });
  const keywords = current.blocks?.keywords || [];
  if (keywords.some((k) => normMatch(k) === normMatch(clean))) return { ok: true, duplicate: true };
  if (keywords.length >= MAX_BLOCK_LIST) return { ok: false, error: `最多屏蔽 ${MAX_BLOCK_LIST} 个关键词` };
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { ...current.blocks, keywords: [clean, ...keywords] },
  });
}

export function removeBlockedKeyword(kw) {
  const clean = String(kw || '').trim();
  const current = loadShelf({ forceReload: true });
  const nextKws = (current.blocks?.keywords || []).filter((k) => k !== clean);
  if (nextKws.length === (current.blocks?.keywords || []).length) return { ok: true };
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { ...current.blocks, keywords: nextKws },
  });
}

export function clearAllBlocks() {
  const current = loadShelf({ forceReload: true });
  return writeShelfState({
    ...current,
    updatedAt: new Date().toISOString(),
    blocks: { books: {}, tags: [], keywords: [] },
  });
}

export function matchBookBlock(book, tagsList = null) {
  if (!book) return { blocked: false };
  const bid = String(book.id || '').trim();
  const blocks = loadShelf().blocks;
  if (!blocks) return { blocked: false };
  if (bid && blocks.books?.[bid]) {
    return { blocked: true, kind: 'book', value: bid, label: '已屏蔽此书' };
  }
  const blockedTags = blocks.tags || [];
  const blockedKws = blocks.keywords || [];
  if (!blockedTags.length && !blockedKws.length) return { blocked: false };

  const allTags = Array.isArray(tagsList)
    ? tagsList
    : [
        ...(Array.isArray(book.primary) ? book.primary : []),
        ...(Array.isArray(book.tags) ? book.tags : []),
        ...Object.values(book.officialTags || {}).flat(),
      ];

  if (blockedTags.length && allTags.length) {
    const tagSet = new Set(allTags);
    for (const bt of blockedTags) {
      if (tagSet.has(bt)) {
        return { blocked: true, kind: 'tag', value: bt, label: `屏蔽标签：${bt}` };
      }
    }
  }

  if (blockedKws.length) {
    const hay = normMatch([book.title || '', book.intro || '', ...allTags].join('\n'));
    for (const kw of blockedKws) {
      const nkw = normMatch(kw);
      if (nkw && hay.includes(nkw)) {
        return { blocked: true, kind: 'keyword', value: kw, label: `屏蔽词：${kw}` };
      }
    }
  }

  return { blocked: false };
}

// --- Backup Export / Validation / Merge Preview / Restore ---
export function exportBackupPayload() {
  return {
    format: 'touxian-ta-backup',
    version: 3,
    exportedAt: new Date().toISOString(),
    identity: activeIdentity,
    data: loadShelf({ forceReload: true }),
  };
}

export function parseAndValidateBackup(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, error: '请先粘贴备份内容或选择备份文件' };
  }
  if (utf8ByteLength(rawText) > MAX_BACKUP_BYTES) {
    return { ok: false, error: '备份内容超过本机存储上限（约 3.7 MB），已拒绝写入以保护现有数据' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: '备份内容格式无法识别，请检查是否完整复制' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '备份内容格式不正确，未能识别有效书篓结构' };
  }

  let body = parsed;
  if (parsed.format === 'touxian-ta-backup') {
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
      return { ok: false, error: '备份内容缺少有效的数据正文，无法恢复' };
    }
    body = parsed.data;
  } else {
    const hasSection =
      (parsed.items && typeof parsed.items === 'object' && !Array.isArray(parsed.items)) ||
      Array.isArray(parsed.history) ||
      (parsed.histories && typeof parsed.histories === 'object' && !Array.isArray(parsed.histories)) ||
      (parsed.blocks && typeof parsed.blocks === 'object' && !Array.isArray(parsed.blocks));
    if (!hasSection) {
      return { ok: false, error: '未识别到偷闲獭书篓备份数据，请确认内容来源正确' };
    }
  }

  const rawItemCount = body.items && typeof body.items === 'object' && !Array.isArray(body.items) ? Object.keys(body.items).length : 0;
  const normalized = normalizeShelf(body);
  const validItemCount = Object.keys(normalized.items).length;
  const skippedItems = Math.max(0, rawItemCount - validItemCount);
  const warnings = [];
  if (skippedItems > 0) {
    warnings.push(`已跳过 ${skippedItems} 条格式异常的书篓记录`);
  }

  const incomingHist = normalized.histories?.[activeIdentity]?.length
    ? normalized.histories[activeIdentity]
    : (normalized.histories?.guest || normalized.history || []);

  return {
    ok: true,
    normalized,
    warnings,
    stats: {
      items: validItemCount,
      history: incomingHist.length,
      blockBooks: Object.keys(normalized.blocks.books).length,
      blockTags: normalized.blocks.tags.length,
      blockKeywords: normalized.blocks.keywords.length,
      defaultFattenWords: normalized.prefs.defaultFattenWords,
      exportedAt: String(parsed.exportedAt || body.updatedAt || ''),
    },
  };
}

export function buildBackupMergePreview(incomingNormalized) {
  const current = loadShelf({ forceReload: true });
  const merged = mergeShelfStates(current, incomingNormalized, { historyTargetIdentity: activeIdentity });
  const curItems = current.items || {};
  const incItems = incomingNormalized.items || {};
  let kept = 0;
  for (const bid of Object.keys(incItems)) {
    if (curItems[bid]) kept++;
  }
  const updated = merged.updatedFromLocal;
  kept = Math.max(0, kept - updated);

  return {
    items: {
      added: merged.addedFromLocal,
      updated,
      kept,
      incomingTotal: Object.keys(incItems).length,
      currentTotal: Object.keys(curItems).length,
      mergedTotal: Object.keys(merged.state.items).length,
    },
    history: {
      added: merged.historyAdded,
      mergedTotal: (merged.state.histories?.[activeIdentity] || []).length,
    },
    blocks: {
      booksAdded: merged.blockBooksAdded,
      tagsAdded: merged.blockTagsAdded,
      keywordsAdded: merged.blockKeywordsAdded,
      mergedTotal:
        Object.keys(merged.state.blocks.books).length +
        merged.state.blocks.tags.length +
        merged.state.blocks.keywords.length,
    },
    prefs: {
      currentFattenWords: current.prefs?.defaultFattenWords || DEFAULT_FATTEN_WORDS,
      incomingFattenWords: incomingNormalized.prefs?.defaultFattenWords || DEFAULT_FATTEN_WORDS,
      changed: merged.prefsChanged,
    },
    mergedState: merged.state,
    incomingState: incomingNormalized,
  };
}

export function applyBackupImport(incomingNormalized, { mode = 'merge' } = {}) {
  const current = loadShelf({ forceReload: true });
  let nextState;
  if (mode === 'replace') {
    const cleanInc = normalizeShelf(incomingNormalized);
    const incTargetHist = cleanInc.histories?.[activeIdentity]?.length
      ? cleanInc.histories[activeIdentity]
      : (cleanInc.histories?.guest || cleanInc.history || []);
    const nextHistories = { ...(current.histories || {}), [activeIdentity]: incTargetHist };
    nextState = {
      ...cleanInc,
      updatedAt: new Date().toISOString(),
      history: nextHistories.guest || [],
      histories: nextHistories,
    };
  } else {
    nextState = mergeShelfStates(current, incomingNormalized, { historyTargetIdentity: activeIdentity }).state;
  }
  const writeRes = writeShelfState(nextState);
  if (!writeRes.ok) return writeRes;
  return { ok: true, state: memoryCache };
}
