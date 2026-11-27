import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const CN_OFFSET = 8 * 3600 * 1000;
export const MIN_READERS = 8000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function cnDay(ms = Date.now()) {
  return new Date(ms + CN_OFFSET).toISOString().slice(0, 10);
}

export function readGzJson(filePath) {
  return JSON.parse(gunzipSync(fs.readFileSync(filePath)).toString('utf8'));
}

export function writeGzJson(filePath, value, level = 6) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, gzipSync(JSON.stringify(value), { level, mtime: 0 }));
  fs.renameSync(tmp, filePath);
}

// Verified public library font glyph table (fKts9tCXDjS49UhH)
const LIBRARY_FONT_KEY = 'fKts9tCXDjS49UhH';
const LIBRARY_GLYPHS = [
  '体y十现快便话却月物水的放知爱万',
  ' 表风理O老也p常克平几最主她s',
  '将法情o光a我呢J员太每望受教w',
  '利军已U人如变得要少斯门电m男没',
  'AK国时中走么何口小向问轻Td神',
  '下间车fG度D又大面远就写j给通',
  '起实E 它去S到道数吃们加P是无',
  '把事西多界 发新外活解孩只作前Y',
  '尔经 u心告父等Q民全这9果安 ',
  'i母8r说任先和地C张战场g像c',
  'q你使 样总目x性处音头 应乐关',
  '能花l当名手4重字声力友然生代内',
  '里本回真入师象 0点R亲V种动英',
  '命ZhX做特边高有B为期自年马认',
  '出接至H正方感所明者稜F住学还分',
  '意更其n但比觉以由死家让失士L2',
  'I金叫身报听W再原山海白很见5直',
  '位第工个开岁好用都于可同3次四 ',
  '日信与女笑满并部件不从或机此 了',
  '记三e些bN夫会才儿眼两美被一公',
  '来立z长对己看k许因相色后往打结',
  '格过世气7子条在书之定v拉成进带',
  '着东上想天他妈1文而路那别德6M',
  't行候难            ',
].join('');

let _rankGlyphs = null;
function getRankGlyphs() {
  if (!_rankGlyphs) {
    _rankGlyphs = JSON.parse(
      fs.readFileSync(path.join(HERE, 'rank-font.json'), 'utf8').replace(/^\uFEFF/, '')
    );
  }
  return _rankGlyphs;
}

export function decodeLibrary(value, fontHeader = '') {
  return String(value ?? '').replace(/[\uE000-\uF8FF]/gu, (ch) => {
    const glyph = LIBRARY_GLYPHS[ch.codePointAt(0) - 0xe3e8];
    if (!fontHeader.includes(LIBRARY_FONT_KEY) || !glyph || glyph === ' ') {
      throw new Error('番茄书库显示字体已变化');
    }
    return glyph;
  });
}

export function decodeRank(value, fontHeader = '') {
  const glyphs = getRankGlyphs();
  return String(value ?? '').replace(/[\uE000-\uF8FF]/gu, (ch) => {
    const mapped = glyphs[ch.codePointAt(0)];
    if (!fontHeader.includes('DNMrHsV173Pd4pgy') || !mapped) {
      throw new Error('番茄榜单字体已变化');
    }
    return mapped;
  });
}

export function parseCount(text) {
  const m = /^([\d.]+)(万|亿)?/.exec(String(text || '').trim());
  if (!m) return null;
  const mult = m[2] === '万' ? 10000 : m[2] === '亿' ? 100000000 : 1;
  return Math.round(Number(m[1]) * mult);
}

const IMAGE_HOSTS = ['byteimg.com', 'fqnovelpic.com', 'bytecdn.cn', 'toutiaoimg.com'];

export function sanitizeImageUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const addr = raw.trim().replace(/^http:/i, 'https:');
  try {
    const u = new URL(addr);
    if (u.protocol !== 'https:') return '';
    if (!IMAGE_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) return '';
    return u.href;
  } catch {
    return '';
  }
}

export function urlExpiresMs(url) {
  if (!url) return 0;
  try {
    const u = new URL(url);
    const exp = u.searchParams.get('x-expires');
    if (!exp) return Number.MAX_SAFE_INTEGER;
    const n = Number(exp);
    return Number.isFinite(n) ? n * 1000 : 0;
  } catch {
    return 0;
  }
}

export function bestCoverExpiryMs(book) {
  return Math.max(
    urlExpiresMs(book.longCoverUrl),
    urlExpiresMs(book.freshCoverUrl),
    urlExpiresMs(book.coverUrl)
  );
}

export function updateCoverUrl(book, rawUrl, now = Date.now()) {
  const clean = sanitizeImageUrl(rawUrl);
  if (!clean) return false;
  const exp = urlExpiresMs(clean);
  if (exp <= now) return false;
  // Store >3d links in longCoverUrl; store 24h links in freshCoverUrl if longer than existing
  if (exp - now > 3 * 86400 * 1000) {
    if (exp > urlExpiresMs(book.longCoverUrl)) {
      book.longCoverUrl = clean;
      return true;
    }
  } else if (exp > urlExpiresMs(book.freshCoverUrl)) {
    book.freshCoverUrl = clean;
    return true;
  }
  return false;
}

export function parseCategoryV2(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const main = list.filter((c) => c && c.MainCategory === true);
  const primary = [...new Set(main.map((c) => c.Name).filter((x) => typeof x === 'string' && x.trim()))];
  const tags = [
    ...new Set(
      list
        .filter((c) => c && c.MainCategory === false && typeof c.Name === 'string' && c.Name.trim())
        .map((c) => c.Name.trim())
    ),
  ];
  const genders = new Set(main.map((c) => c.Gender).filter((g) => g === 0 || g === 1 || g === 2));
  let channel = '';
  if (genders.size) {
    if (genders.has(0) && !genders.has(1)) channel = '女频';
    else if (genders.has(1) && !genders.has(0)) channel = '男频';
    else {
      const subGenders = new Set(
        list.filter((c) => c && c.MainCategory === false).map((c) => c.Gender).filter((g) => g === 0 || g === 1)
      );
      if (subGenders.has(0) && !subGenders.has(1)) channel = '女频';
      else if (subGenders.has(1) && !subGenders.has(0)) channel = '男频';
      else channel = '共用';
    }
  }
  return {
    primary,
    tags,
    channel,
    mainEntries: main.map((c) => [c.ObjectId, c.Name, c.Gender]),
  };
}

export function applyDetailToBook(book, detail, observedIso, now = Date.now()) {
  if (!detail || String(detail.bookId) !== String(book.id)) return false;
  const rc = Number(detail.readCount);
  if (Number.isSafeInteger(rc) && rc >= 0) {
    book.readers = rc;
    book.readersText = '';
    book.observed = observedIso;
  }
  const wn = Number(detail.wordNumber);
  if (Number.isSafeInteger(wn) && wn > 0) {
    book.words = wn;
    book.wordsObserved = observedIso;
  }
  const lpt = Number(detail.lastPublishTime);
  if (Number.isSafeInteger(lpt) && lpt > 946684800) {
    book.lastUpdate = lpt;
  }
  if (detail.creationStatus === '0' || detail.creationStatus === 0) book.status = '已完结';
  else if (detail.creationStatus === '1' || detail.creationStatus === 1) book.status = '连载中';
  if (!book.title && detail.bookName) book.title = String(detail.bookName);
  if (!book.author && detail.author) book.author = String(detail.author);
  if (!book.intro && detail.abstract) book.intro = String(detail.abstract).trim();

  updateCoverUrl(book, detail.thumbUrl || detail.thumbUri, now);

  const cat = parseCategoryV2(detail.categoryV2);
  if (cat) {
    if (cat.primary.length) book.primary = cat.primary;
    if (cat.tags.length) book.tags = cat.tags;
    if (cat.channel) {
      const isSpecific = cat.channel === '男频' || cat.channel === '女频';
      if (isSpecific || !book.channel) {
        book.channel = cat.channel;
      }
      book.channelEvidence = {
        kind: isSpecific ? 'official-detail' : 'official-detail-shared',
        observed: observedIso,
        main: cat.mainEntries,
      };
    }
    book.channelChecked = observedIso;
  }
  return true;
}

export async function fetchJson(url, { timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
        },
      });
      if ([401, 403, 429].includes(res.status) || res.headers.has('retry-after')) {
        const err = new Error(`HTTP ${res.status}${res.headers.get('retry-after') ? ' Retry-After=' + res.headers.get('retry-after') : ''}`);
        err.rateLimited = true;
        err.status = res.status;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const text = await res.text();
      if (!text.trim()) throw new Error('空响应');
      return { data: JSON.parse(text), headers: res.headers };
    } catch (e) {
      lastErr = e;
      if (e.rateLimited || e.status === 404 || attempt === retries) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function runPool(items, concurrency, workerFn, { shouldStop = () => false } = {}) {
  let idx = 0;
  async function worker() {
    while (!shouldStop()) {
      const i = idx++;
      if (i >= items.length) return;
      await workerFn(items[i], i);
    }
  }
  const n = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}
