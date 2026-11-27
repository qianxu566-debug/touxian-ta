/**
 * Unified concurrent daily observer for touxian-ta.
 * Single /api/book/info pass updates:
 *   1. Daily snapshot data/days/YYYY-MM-DD.json.gz -> [unixSec, readCount, wordNumber]
 *   2. Fresh 24h domestic CDN cover URLs (freshCoverUrl) -> ~99% no-VPN direct covers
 *   3. Official tags, channel, primary category, status, total words in catalog.gz
 *
 * Usage:
 *   node scripts/observe.mjs <catalog.gz> [--covers-only] [--concurrency=8] [--max-minutes=40] [--limit=0]
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  MIN_READERS,
  UNAVAIL_HIDE_DAYS,
  UNAVAIL_PURGE_DAYS,
  cnDay,
  readGzJson,
  writeGzJson,
  bestCoverExpiryMs,
  applyDetailToBook,
  checkSdkVisibility,
  fetchJson,
  runPool,
} from './lib.mjs';
import { backfillScores } from './backfill-scores.mjs';

const catalogPath = process.argv[2] || 'catalog.gz';
const coversOnly = process.argv.includes('--covers-only');
const missingUpdate = process.argv.includes('--missing-update');
const argNum = (prefix, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const concurrency = argNum('--concurrency=', 8);
const maxMs = argNum('--max-minutes=', coversOnly ? 20 : 50) * 60 * 1000;
const limit = argNum('--limit=', 0);
const delayMs = argNum('--delay=', 80);

const startTime = Date.now();
const today = cnDay();
const daysDir = 'data/days';
const dayFile = path.join(daysDir, `${today}.json.gz`);

const catalog = readGzJson(catalogPath);
const books = new Map(catalog.books.map((b) => [String(b.id), b]));

// Gather today's rank IDs so newly ranked books are also observed
const extraRankIds = new Set();
const histFile = path.join('history', `${today}.json.gz`);
if (fs.existsSync(histFile)) {
  const snap = readGzJson(histFile);
  for (const s of snap.scopes || []) {
    for (const r of s.rows || []) extraRankIds.add(String(r.id));
  }
  for (const b of Object.values(snap.boards || {})) {
    for (const r of b.rows || []) extraRankIds.add(String(r.id));
  }
}

let state = null;
if (!coversOnly) {
  fs.mkdirSync(daysDir, { recursive: true });
  state = fs.existsSync(dayFile)
    ? readGzJson(dayFile)
    : {
        date: today,
        source: 'fanqienovel.com/api/book/info:v2',
        targetsCount: 0,
        rows: {},
        unavailable: [],
      };
  state.rows ??= {};
  state.unavailable ??= [];
}

const unavailableSet = new Set(state?.unavailable || []);
const now = Date.now();
const COVER_REFRESH_WINDOW_MS = 16 * 3600 * 1000;

let queue = [];
if (missingUpdate) {
  queue = [...books.values()]
    .filter((b) => !Number.isFinite(b.lastUpdate))
    .sort((a, b) => (extraRankIds.has(String(b.id)) ? 1 : 0) - (extraRankIds.has(String(a.id)) ? 1 : 0) || (b.readers ?? 0) - (a.readers ?? 0))
    .map((b) => String(b.id));
} else if (coversOnly) {
  // Only refresh books whose best direct cover expires within 16 hours (skip quarantined)
  queue = catalog.books
    .filter((b) => (b.unavailDays || 0) < UNAVAIL_HIDE_DAYS && bestCoverExpiryMs(b) - now < COVER_REFRESH_WINDOW_MS)
    .map((b) => String(b.id));
} else {
  const allTargets = [...new Set([...books.keys(), ...extraRankIds])];
  state.targetsCount = allTargets.length;
  queue = allTargets.filter((id) => !state.rows[id] && !unavailableSet.has(id));
}

if (limit > 0) queue = queue.slice(0, limit);

console.log(
  `[observe] mode=${coversOnly ? 'covers-only' : 'daily'} date=${today} queue=${queue.length} concurrency=${concurrency} delay=${delayMs}ms`
);

let done = 0;
let ok = 0;
let unavail = 0;
let transientErrs = 0;
let consecutiveErrs = 0;
let rateLimited = '';

function checkpoint() {
  if (!coversOnly && state) {
    state.unavailable = [...unavailableSet];
    writeGzJson(dayFile, state);
  }
}

async function markBookUnavailable(id) {
  const vis = await checkSdkVisibility(id);
  if (vis === 1) return false;
  unavailableSet.add(id);
  const book = books.get(id);
  if (book && book.unavailLastDate !== today) {
    book.unavailDays = (Number(book.unavailDays) || 0) + 1;
    if (!book.unavailSince) book.unavailSince = today;
    book.unavailLastDate = today;
  }
  return true;
}

await runPool(
  queue,
  concurrency,
  async (id) => {
    if (rateLimited || Date.now() - startTime > maxMs) return;
    if (delayMs > 0) await sleep(delayMs);
    try {
      const { data } = await fetchJson(
        `https://fanqienovel.com/api/book/info?bookId=${id}`,
        { timeoutMs: 14000, retries: 1 }
      );
      if (data.code === -1 || String(data.message || '').includes('查无此书')) {
        if (await markBookUnavailable(id)) unavail++;
        else transientErrs++;
        consecutiveErrs = 0;
        done++;
        return;
      }
      const d = data.data || {};
      if (data.code !== 0 || String(d.bookId) !== id) {
        throw new Error(`code=${data.code}`);
      }
      const rc = Number(d.readCount);
      const wn = Number(d.wordNumber);
      if (!Number.isSafeInteger(rc) || rc < 0) {
        throw new Error('missing readCount');
      }
      const ts = Math.floor(Date.now() / 1000);
      const iso = new Date(ts * 1000).toISOString();

      if (!coversOnly && state) {
        state.rows[id] = [ts, rc, Number.isSafeInteger(wn) && wn > 0 ? wn : null];
      }

      const book = books.get(id);
      if (book) {
        applyDetailToBook(book, d, iso, ts * 1000);
        delete book.unavailDays;
        delete book.unavailSince;
        delete book.unavailLastDate;
      }

      ok++;
      consecutiveErrs = 0;
      done++;
      if (done % 1000 === 0) {
        checkpoint();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const rate = (done / Math.max(1, elapsed)).toFixed(1);
        console.log(
          `[observe] progress=${done}/${queue.length} ok=${ok} unavail=${unavail} err=${transientErrs} rate=${rate}/s`
        );
      }
    } catch (e) {
      if (e.status === 404) {
        if (await markBookUnavailable(id)) unavail++;
        else transientErrs++;
        consecutiveErrs = 0;
      } else if (e.rateLimited) {
        rateLimited = e.message;
      } else {
        transientErrs++;
        consecutiveErrs++;
        if (consecutiveErrs >= 25) {
          rateLimited = `连续失败过多: ${e.message}`;
        }
      }
      done++;
    }
  },
  { shouldStop: () => Boolean(rateLimited) || Date.now() - startTime > maxMs }
);

checkpoint();

// Save updated catalog.gz (keeping >= MIN_READERS, purging unavailable >= UNAVAIL_PURGE_DAYS)
let purged = 0;
const updatedBooks = [...books.values()]
  .filter((b) => {
    if (!Number.isFinite(b.readers) || b.readers < MIN_READERS) return false;
    if ((b.unavailDays || 0) >= UNAVAIL_PURGE_DAYS) {
      purged++;
      return false;
    }
    return true;
  })
  .sort((a, b) => (b.readers ?? -1) - (a.readers ?? -1) || String(a.id).localeCompare(String(b.id)));
const quarantined = updatedBooks.filter((b) => (b.unavailDays || 0) >= UNAVAIL_HIDE_DAYS).length;
catalog.books = updatedBooks;
catalog.updated = new Date().toISOString();
writeGzJson(catalogPath, catalog);

const nowEnd = Date.now();
const validCovers = updatedBooks.filter((b) => bestCoverExpiryMs(b) > nowEnd).length;
const observedTotal = state ? Object.keys(state.rows).length : ok;
const targetTotal = state ? state.targetsCount : queue.length;

console.log(
  JSON.stringify({
    mode: coversOnly ? 'covers-only' : 'daily',
    date: today,
    done,
    ok,
    unavail,
    quarantined,
    purged,
    transientErrs,
    observedTotal,
    targetTotal,
    coveragePct: targetTotal ? Number(((100 * observedTotal) / targetTotal).toFixed(1)) : 100,
    catalogBooks: updatedBooks.length,
    validCovers,
    validCoverPct: updatedBooks.length
      ? Number(((100 * validCovers) / updatedBooks.length).toFixed(1))
      : 0,
    rateLimited: rateLimited || null,
    elapsedSec: Math.round((nowEnd - startTime) / 1000),
  })
);

if (!coversOnly && !missingUpdate) {
  const remMs = maxMs - (Date.now() - startTime) - 180_000;
  if (remMs > 60_000) {
    await backfillScores({ catalogPath, limit: 4000, concurrency: 10, delayMs: 45, maxMs: remMs });
  }
}
