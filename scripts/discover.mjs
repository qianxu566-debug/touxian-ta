/**
 * Unified discovery + ranks + 7-day cover sweep for touxian-ta.
 * Uses adaptive watermark crawling (stop when 2 consecutive pages fall below 8,000 readers)
 * across all official male/female primary categories x (all / ongoing / finished).
 *
 * Usage:
 *   node scripts/discover.mjs <catalog.gz> [--deep] [--ranks-only] [--max-minutes=25]
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  MIN_READERS,
  cnDay,
  readGzJson,
  writeGzJson,
  decodeLibrary,
  decodeRank,
  parseCount,
  sanitizeImageUrl,
  updateCoverUrl,
  bestCoverExpiryMs,
  fetchJson,
  runPool,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const catalogPath = process.argv[2] || 'catalog.gz';
const isDeep = process.argv.includes('--deep');
const ranksOnly = process.argv.includes('--ranks-only');
const maxMinArg = process.argv.find((a) => a.startsWith('--max-minutes='));
const maxMs = (maxMinArg ? Number(maxMinArg.split('=')[1]) : isDeep ? 35 : 15) * 60 * 1000;
const startTime = Date.now();
const today = cnDay();

const catalog = fs.existsSync(catalogPath)
  ? readGzJson(catalogPath)
  : { books: [], coverage: [], updated: new Date().toISOString() };
const books = new Map(catalog.books.map((b) => [String(b.id), b]));
const initialCount = books.size;

let rateLimited = '';
let consecutiveErrors = 0;

function absorbBook(row) {
  if (!row || !/^\d+$/.test(String(row.id)) || !row.title) return false;
  const id = String(row.id);
  const old = books.get(id);
  const isNew = !old;
  const next = old ? { ...old } : { id };

  // Preserve verified official-detail channel & tags
  const hasDetailChannel = old?.channelEvidence?.kind === 'official-detail';

  for (const k of ['title', 'author', 'intro', 'status']) {
    if (row[k] != null && row[k] !== '') next[k] = row[k];
  }
  if (Number.isFinite(row.words) && row.words > 0) {
    next.words = row.words;
    if (row.observed) next.wordsObserved = row.observed;
  }
  if (Number.isFinite(row.readers) && row.readers >= 0) {
    // Only overwrite readers if newer or missing
    if (!old?.observed || !row.observed || row.observed >= old.observed) {
      next.readers = row.readers;
      next.readersText = '';
      if (row.observed) next.observed = row.observed;
    }
  }
  if (row.primary?.length) {
    next.primary = [...new Set([...(old?.primary || []), ...row.primary])];
  }
  if (row.tags?.length) {
    next.tags = [...new Set([...(old?.tags || []), ...row.tags])];
  }
  if (!hasDetailChannel && row.channel) {
    if (!old?.channel) {
      next.channel = row.channel;
    } else if (old.channel !== row.channel && old.channel !== '共用') {
      next.channel = '共用';
    }
  }
  if (row.rankInfo) next.rankInfo = row.rankInfo;
  if (row.coverUrl) {
    const clean = sanitizeImageUrl(row.coverUrl);
    if (clean) {
      if (!next.coverUrl) next.coverUrl = clean;
      updateCoverUrl(next, clean);
    }
  }
  books.set(id, next);
  return isNew;
}

async function fetchTaxonomy() {
  const scopes = [];
  for (const g of ['1', '0']) {
    const { data, headers } = await fetchJson(
      `https://fanqienovel.com/api/author/book/category_list/v0/?gender=${g}`
    );
    if (data.code !== 0 || !Array.isArray(data.data)) {
      throw new Error(`分类列表异常 gender=${g} code=${data.code}`);
    }
    const font = headers.get('x-tt-zhal') || '';
    for (const item of data.data) {
      if (item.label === '主分类') {
        scopes.push({
          gender: g,
          channel: g === '1' ? '男频' : '女频',
          cid: String(item.category_id),
          name: decodeLibrary(item.name, font),
        });
      }
    }
  }
  return scopes;
}

async function fetchHotOrder() {
  const ids = new Set();
  let pages = 0;
  for (let pg = 0; pg < 30; pg++) {
    if (rateLimited) break;
    try {
      const q = new URLSearchParams({
        page_count: 18,
        page_index: pg,
        gender: -1,
        category_id: -1,
        creation_status: -1,
        word_count: -1,
        book_type: -1,
        sort: 0,
      });
      const { data } = await fetchJson(
        `https://fanqienovel.com/api/author/library/book_list/v0/?${q}`
      );
      const rows = data.data?.book_list;
      if (data.code !== 0 || !Array.isArray(rows) || !rows.length) break;
      const before = ids.size;
      for (const b of rows) {
        if (typeof b.book_id === 'string' && /^\d+$/.test(b.book_id)) ids.add(b.book_id);
      }
      pages++;
      if (!data.data.has_more || ids.size === before) break;
      await sleep(180);
    } catch (e) {
      if (e.rateLimited) rateLimited = e.message;
      break;
    }
  }
  if (ids.size) {
    fs.mkdirSync('data', { recursive: true });
    const tmp = 'data/hot.json.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ observed: new Date().toISOString(), pages, ids: [...ids] }));
    fs.renameSync(tmp, 'data/hot.json');
  }
  console.log(`[hot] pages=${pages} ids=${ids.size}`);
}

async function fetchRanksAndBoards() {
  const scopesList = JSON.parse(
    fs.readFileSync(path.join(HERE, 'scopes.json'), 'utf8').replace(/^\uFEFF/, '')
  );
  const histDir = 'history';
  fs.mkdirSync(histDir, { recursive: true });
  const histFile = path.join(histDir, `${today}.json.gz`);
  const snap = fs.existsSync(histFile)
    ? readGzJson(histFile)
    : { date: today, scopes: [], boards: {}, catalogObservations: [] };
  snap.boards ??= {};
  snap.scopes ??= [];

  const rankJobs = [];
  for (const [gender, cid, category] of scopesList) {
    for (const mold of [2, 1]) {
      rankJobs.push({ gender, cid, category, mold, key: `${gender}/${cid}/${mold}` });
    }
  }

  let rankOk = 0;
  let rankNewBooks = 0;
  await runPool(
    rankJobs,
    4,
    async (job) => {
      if (rateLimited) return;
      const existing = snap.scopes.find((s) => s.key === job.key && s.ok && (s.rows?.length || 0) > 30);
      if (existing && !ranksOnly) {
        // Still absorb covers/books from today's cached snapshot
        for (const r of existing.rows || []) {
          if (r.coverUrl) {
            const b = books.get(r.id);
            if (b) updateCoverUrl(b, r.coverUrl);
          }
        }
        rankOk++;
        return;
      }
      await sleep(180);
      const entry = {
        key: job.key,
        gender: job.gender,
        cid: job.cid,
        category: job.category,
        mold: job.mold,
        observed: new Date().toISOString(),
        ok: false,
      };
      try {
        const q = new URLSearchParams({
          app_id: 2503,
          rank_list_type: 3,
          offset: 0,
          limit: 100,
          category_id: job.cid,
          rank_version: '',
          gender: job.gender,
          rankMold: job.mold,
        });
        const { data, headers } = await fetchJson(
          `https://fanqienovel.com/api/rank/category/list?${q}`
        );
        if (data.code !== 0 || !Array.isArray(data.data?.book_list)) {
          throw new Error(`code=${data.code}`);
        }
        const font = headers.get('x-tt-zhal') || '';
        entry.version = String(data.data.rankVersion || '');
        const rows = [];
        for (const b of data.data.book_list) {
          const id = String(b.bookId);
          const pos = /^\d+$/.test(String(b.currentPos)) ? Number(b.currentPos) : null;
          if (!/^\d+$/.test(id) || !pos) continue;
          const readers = /^\d+$/.test(String(b.read_count)) ? Number(b.read_count) : null;
          const words = /^\d+$/.test(String(b.wordNumber)) ? Number(b.wordNumber) : null;
          const status = ({ '0': '已完结', '1': '连载中' })[String(b.creationStatus)] || '';
          const title = decodeRank(b.bookName, font);
          const author = decodeRank(b.author, font);
          const intro = decodeRank(b.abstract, font).trim();
          const coverUrl = sanitizeImageUrl(b.thumbUri);
          rows.push({ id, pos, readers, words, status, title, author, intro, coverUrl });

          if ((readers ?? 0) >= MIN_READERS || books.has(id)) {
            const added = absorbBook({
              id,
              title,
              author,
              intro,
              readers,
              words,
              status,
              primary: [job.category],
              channel: job.gender === '1' ? '男频' : '女频',
              coverUrl,
              rankInfo: pos <= 30 ? `${job.category}${job.mold === 2 ? '阅读榜' : '新书榜'} · 第${pos}名 · ${today}` : undefined,
              observed: entry.observed,
            });
            if (added) rankNewBooks++;
          }
        }
        entry.rows = rows;
        entry.ok = rows.length > 0;
        if (entry.ok) rankOk++;
      } catch (e) {
        if (e.rateLimited) rateLimited = e.message;
        entry.error = e.message;
      }
      snap.scopes = snap.scopes.filter((s) => s.key !== job.key);
      snap.scopes.push(entry);
    },
    { shouldStop: () => Boolean(rateLimited) }
  );

  // 4 special boards: 巅峰(3), 黑马(4), 热搜(5), 推荐(6)
  for (const [mold, side] of [
    [3, 0],
    [4, 13],
    [5, 12],
    [6, 10],
  ]) {
    if (rateLimited) break;
    try {
      await sleep(200);
      const url = side
        ? `https://api-lf.fanqiesdk.com/api/novel/channel/homepage/rank/rank_list/v2/?aid=13&limit=30&offset=0&side_type=${side}&type=1`
        : `https://fanqienovel.com/api/author/misc/top_book_list/v1/?limit=30&offset=0`;
      const { data } = await fetchJson(url);
      if (data.code !== 0) throw new Error(`code=${data.code}`);
      const list = side ? data.data?.result : data.book_list;
      if (!Array.isArray(list) || !list.length) throw new Error('空榜单');
      const observed = new Date().toISOString();
      const rows = list
        .filter((b) => typeof b.book_id === 'string' && /^\d+$/.test(b.book_id) && b.book_name)
        .map((b, i) => {
          const readers = /^\d+$/.test(String(b.read_count)) ? Number(b.read_count) : null;
          const coverUrl = sanitizeImageUrl(b.thumb_url);
          const primary = side ? [] : [b.category].filter(Boolean);
          const tags = side ? (Array.isArray(b.category_v2) ? b.category_v2 : []) : [];
          if ((readers ?? 0) >= MIN_READERS || books.has(b.book_id)) {
            absorbBook({
              id: b.book_id,
              title: b.book_name,
              author: b.author,
              intro: b.abstract,
              readers,
              coverUrl,
              primary,
              tags,
              observed,
            });
          }
          return {
            id: b.book_id,
            title: b.book_name,
            author: b.author,
            pos: i + 1,
            readers,
            coverUrl,
            intro: b.abstract,
            primary,
            tags,
          };
        });
      snap.boards[mold] = { observed, rows };
    } catch (e) {
      if (e.rateLimited) rateLimited = e.message;
      console.warn(`[board ${mold}] ${e.message}`);
    }
  }

  delete snap.catalogObservations;
  writeGzJson(histFile, snap);
  console.log(
    `[ranks] ok=${rankOk}/${rankJobs.length} boards=${Object.keys(snap.boards).length} newFromRanks=${rankNewBooks}`
  );
}

async function watermarkCrawl(taxonomy) {
  // Check which category names are exclusive to one gender
  const nameGenders = new Map();
  for (const s of taxonomy) {
    if (!nameGenders.has(s.name)) nameGenders.set(s.name, new Set());
    nameGenders.get(s.name).add(s.gender);
  }

  // Build slices: every official category x (ongoing=1, finished=0, all=-1)
  const slices = [];
  for (const s of taxonomy) {
    const exclusive = nameGenders.get(s.name).size === 1;
    for (const status of [1, 0, -1]) {
      slices.push({ ...s, status, exclusive });
    }
  }

  let totalPages = 0;
  let totalAdded = 0;
  let totalSeen = 0;
  let slicesDone = 0;
  const maxPagesPerSlice = isDeep ? 220 : 25;

  await runPool(
    slices,
    6,
    async (slice) => {
      if (rateLimited || Date.now() - startTime > maxMs) return;
      let belowStreak = 0;
      let noNewStreak = 0;
      let sliceErrors = 0;
      let lastSig = '';

      for (let pg = 0; pg < maxPagesPerSlice; pg++) {
        if (rateLimited || Date.now() - startTime > maxMs) break;
        await sleep(120);
        try {
          const q = new URLSearchParams({
            page_count: 18,
            page_index: pg,
            gender: slice.gender,
            category_id: slice.cid,
            creation_status: slice.status,
            word_count: -1,
            book_type: -1,
            sort: 0,
          });
          const { data, headers } = await fetchJson(
            `https://fanqienovel.com/api/author/library/book_list/v0/?${q}`
          );
          if (data.code === -100) break;
          if (data.code !== 0 || !Array.isArray(data.data?.book_list)) {
            throw new Error(`code=${data.code}`);
          }
          consecutiveErrors = 0;
          const rows = data.data.book_list;
          if (!rows.length) break;
          const sig = rows.map((r) => r.book_id).join(',');
          if (sig === lastSig) break;
          lastSig = sig;
          totalPages++;

          const font = headers.get('x-tt-zhal') || '';
          const observed = new Date().toISOString();
          let maxReadersOnPage = -1;
          let addedOnPage = 0;

          for (const b of rows) {
            const readsText = decodeLibrary(b.read_count, font);
            const reads = parseCount(readsText);
            if (reads !== null && reads > maxReadersOnPage) maxReadersOnPage = reads;
            totalSeen++;

            if (reads !== null && reads >= MIN_READERS) {
              const wordsText = decodeLibrary(b.word_count, font);
              const words = parseCount(wordsText);
              const added = absorbBook({
                id: String(b.book_id),
                title: decodeLibrary(b.book_name, font),
                author: decodeLibrary(b.author, font),
                intro: decodeLibrary(b.abstract, font).trim(),
                readers: reads,
                words,
                status: b.creation_status === 0 ? '已完结' : '连载中',
                primary: [slice.name],
                channel: slice.exclusive ? slice.channel : '',
                coverUrl: b.thumb_url || b.thumb_uri,
                observed,
              });
              if (added) {
                addedOnPage++;
                totalAdded++;
              }
            }
          }

          if (maxReadersOnPage >= 0 && maxReadersOnPage < MIN_READERS) {
            belowStreak++;
            if (belowStreak >= 2) break;
          } else {
            belowStreak = 0;
          }

          if (!isDeep) {
            if (addedOnPage === 0) noNewStreak++;
            else noNewStreak = 0;
            // In daily incremental mode, scan at least top 3 pages, then stop if 3 straight pages have 0 new books
            if (pg >= 2 && noNewStreak >= 3) break;
          }

          if (!data.data.has_more) break;
        } catch (e) {
          if (e.rateLimited) {
            rateLimited = e.message;
            break;
          }
          consecutiveErrors++;
          sliceErrors++;
          if (consecutiveErrors >= 40) {
            rateLimited = `连续错误过多: ${e.message}`;
            break;
          }
          if (sliceErrors >= 4) break;
        }
      }
      slicesDone++;
      if (slicesDone % 20 === 0 || slicesDone === slices.length) {
        console.log(
          `[crawl] slices=${slicesDone}/${slices.length} pages=${totalPages} added=${totalAdded} totalBooks=${books.size}`
        );
      }
    },
    { shouldStop: () => Boolean(rateLimited) || Date.now() - startTime > maxMs }
  );

  console.log(
    `[crawl done] mode=${isDeep ? 'deep' : 'daily'} pages=${totalPages} seen=${totalSeen} added=${totalAdded} stopped=${rateLimited || 'complete'}`
  );
}

async function sweepLongCovers() {
  const now = Date.now();
  const longCount = [...books.values()].filter(
    (b) => bestCoverExpiryMs(b) - now > 3 * 86400 * 1000
  ).length;
  if (!isDeep && longCount >= books.size * 0.6) {
    console.log(`[long-covers] skip (${longCount}/${books.size} already >3d)`);
    return;
  }
  const scopesList = JSON.parse(
    fs.readFileSync(path.join(HERE, 'scopes.json'), 'utf8').replace(/^\uFEFF/, '')
  );
  const lanes = scopesList.flatMap(([gender, cid]) =>
    [2, 1].map((mold) => ({ gender, cid, mold }))
  );
  let touched = 0;
  let reqs = 0;
  await runPool(
    lanes,
    5,
    async (lane) => {
      if (rateLimited || Date.now() - startTime > maxMs) return;
      let offset = 100;
      let version = '';
      let lastSig = '';
      let missStreak = 0;
      for (let round = 0; round < 5; round++) {
        if (rateLimited || Date.now() - startTime > maxMs) break;
        await sleep(160);
        try {
          reqs++;
          const q = new URLSearchParams({
            app_id: 2503,
            rank_list_type: 3,
            offset,
            limit: 100,
            category_id: lane.cid,
            gender: lane.gender,
            rankMold: lane.mold,
            rank_version: version,
          });
          const { data } = await fetchJson(`https://fanqienovel.com/api/rank/category/list?${q}`);
          if (data.code !== 0) break;
          const rows = data.data?.book_list || [];
          if (!rows.length) break;
          const sig = rows.map((r) => r.bookId).join(',');
          if (sig === lastSig) break;
          lastSig = sig;
          version = data.data.rankVersion || version;
          let matched = false;
          for (const r of rows) {
            const b = books.get(String(r.bookId));
            if (b) {
              matched = true;
              if (updateCoverUrl(b, r.thumbUri, now)) touched++;
            }
          }
          missStreak = matched ? 0 : missStreak + 1;
          offset += rows.length;
          if (rows.length < 100 || missStreak >= 2) break;
        } catch (e) {
          if (e.rateLimited) rateLimited = e.message;
          break;
        }
      }
    },
    { shouldStop: () => Boolean(rateLimited) || Date.now() - startTime > maxMs }
  );
  console.log(`[long-covers] reqs=${reqs} touched=${touched}`);
}

// Main execution
const taxonomy = await fetchTaxonomy();
console.log(`[taxonomy] ${taxonomy.length} official main categories`);

await fetchHotOrder();
await fetchRanksAndBoards();
if (!ranksOnly) {
  await watermarkCrawl(taxonomy);
  await sweepLongCovers();
}

// Save catalog sorted by readers desc, keeping >= MIN_READERS
const kept = [...books.values()]
  .filter((b) => Number.isFinite(b.readers) && b.readers >= MIN_READERS)
  .sort((a, b) => (b.readers ?? -1) - (a.readers ?? -1) || String(a.id).localeCompare(String(b.id)));

catalog.books = kept;
catalog.coverage = taxonomy.map((s) => ({
  category: s.name,
  channel: s.channel,
  kind: '主分类',
}));
catalog.updated = new Date().toISOString();
writeGzJson(catalogPath, catalog);

const ge10k = kept.filter((b) => b.readers >= 10000).length;
console.log(
  JSON.stringify({
    mode: ranksOnly ? 'ranks-only' : isDeep ? 'deep' : 'daily',
    before: initialCount,
    after: kept.length,
    ge10k,
    netAdded: kept.length - initialCount,
    rateLimited: rateLimited || null,
    elapsedSec: Math.round((Date.now() - startTime) / 1000),
  })
);
