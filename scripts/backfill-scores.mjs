/**
 * Dual-host concurrent backfill of official novel scores (小说评分) via fanqiesdk page/data API.
 * Persists { score, sc, su } alongside { start, checked } inside data/book-dates.json.gz
 * and optionally enriches catalog.gz in place.
 *
 * Usage:
 *   node scripts/backfill-scores.mjs [catalog.gz] [--limit=3500] [--concurrency=12] [--delay=40] [--max-minutes=15]
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { cnDay, readGzJson, writeGzJson, runPool } from './lib.mjs';

const HOSTS = ['https://api.fanqiesdk.com', 'https://api-lf.fanqiesdk.com'];
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function daysBetween(older, newer) {
  if (!older || !newer || !/^\d{4}-\d{2}-\d{2}$/.test(older) || !/^\d{4}-\d{2}-\d{2}$/.test(newer)) {
    return Infinity;
  }
  return Math.floor((Date.parse(`${newer}T00:00:00Z`) - Date.parse(`${older}T00:00:00Z`)) / 86400000);
}

function latestHistoryFile() {
  if (!fs.existsSync('history')) return null;
  const files = fs
    .readdirSync('history')
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
    .sort();
  return files.length ? path.join('history', files[files.length - 1]) : null;
}

export async function backfillScores({
  catalogPath = 'catalog.gz',
  metaFile = 'data/book-dates.json.gz',
  limit = 3500,
  concurrency = 12,
  delayMs = 40,
  maxMs = 15 * 60 * 1000,
} = {}) {
  const startTime = Date.now();
  const today = cnDay();
  const catalog = fs.existsSync(catalogPath) ? readGzJson(catalogPath) : null;
  const booksMap = new Map((catalog?.books || []).map((b) => [String(b.id), b]));
  const meta = fs.existsSync(metaFile) ? readGzJson(metaFile) : {};

  const orderedIds = [];
  const seen = new Set();
  const pushId = (raw) => {
    const id = String(raw || '');
    if (/^\d+$/.test(id) && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  };

  // Priority 1: data/hot.json (front page default order)
  if (fs.existsSync('data/hot.json')) {
    try {
      const hot = JSON.parse(fs.readFileSync('data/hot.json', 'utf8'));
      for (const id of hot.ids || []) pushId(id);
    } catch {}
  }

  // Priority 2: latest history rank scopes & special boards
  const histFile = latestHistoryFile();
  if (histFile) {
    try {
      const snap = readGzJson(histFile);
      for (const b of Object.values(snap.boards || {})) {
        for (const r of b.rows || []) pushId(r.id);
      }
      for (const s of snap.scopes || []) {
        for (const r of s.rows || []) pushId(r.id);
      }
    } catch {}
  }

  // Priority 3: remaining catalog books sorted by readers desc
  for (const b of [...booksMap.values()].sort((a, b) => (b.readers || 0) - (a.readers || 0))) {
    pushId(b.id);
  }

  const tier1 = []; // Never checked
  const tier2 = []; // Previously unrated, retry after >= 3 days
  const tier3 = []; // Previously rated, refresh after >= 14 days
  for (const id of orderedIds) {
    const entry = meta[id];
    if (!entry?.su) {
      tier1.push(id);
    } else if (entry.score == null) {
      if (daysBetween(entry.su, today) >= 3) tier2.push(id);
    } else if (daysBetween(entry.su, today) >= 14) {
      tier3.push(id);
    }
  }

  const queue = [...tier1, ...tier2, ...tier3].slice(0, limit);
  console.log(
    `[scores] meta=${Object.keys(meta).length} tier1=${tier1.length} tier2=${tier2.length} tier3=${tier3.length} queue=${queue.length}`
  );

  let checked = 0;
  let withScore = 0;
  let errs = 0;
  let consecutiveErrs = 0;
  let rateLimited = '';
  let catalogDirty = false;

  await runPool(
    queue,
    concurrency,
    async (id, idx) => {
      if (rateLimited || Date.now() - startTime > maxMs) return;
      if (delayMs > 0) await sleep(delayMs);

      let payload = null;
      let lastErr = null;
      let explicitRateLimit = false;

      for (let attempt = 0; attempt < 3; attempt++) {
        const host = HOSTS[(idx + attempt) % HOSTS.length];
        const url = `${host}/api/novel/book/page/data/v1/?device_platform=android&aid=13&book_id=${id}`;
        try {
          const res = await fetch(url, {
            signal: AbortSignal.timeout(9000),
            headers: {
              'User-Agent': MOBILE_UA,
              Accept: 'application/json, text/plain, */*',
            },
          });
          if ([401, 403, 429].includes(res.status)) {
            explicitRateLimit = true;
            throw new Error(`HTTP ${res.status}`);
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (!text.trim()) throw new Error('空响应');
          const json = JSON.parse(text);
          if (json.code !== 0) throw new Error(`code=${json.code}`);
          payload = json.data || {};
          explicitRateLimit = false;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await sleep(200 * (attempt + 1));
        }
      }

      if (!payload) {
        errs++;
        consecutiveErrs++;
        if (explicitRateLimit && consecutiveErrs >= 12) {
          rateLimited = lastErr?.message || 'HTTP rate limit';
        } else if (consecutiveErrs >= 25) {
          rateLimited = `连续失败: ${lastErr?.message || 'unknown'}`;
        }
        return;
      }

      consecutiveErrs = 0;
      const bs = payload.book_score || {};
      const avg = Number(bs.average_score);
      const score = Number.isFinite(avg) && avg > 0 && avg <= 10 ? Math.round(avg * 10) / 10 : null;
      const rawCnt = Number(bs.score_count);
      const sc = Number.isFinite(rawCnt) && rawCnt > 0 ? Math.trunc(rawCnt) : 0;

      meta[id] = { ...(meta[id] || {}), score, sc, su: today };
      checked++;
      if (score !== null) {
        withScore++;
        const book = booksMap.get(id);
        if (book) {
          book.score = score;
          book.scoreCount = sc;
          catalogDirty = true;
        }
      }

      if (checked % 400 === 0) {
        writeGzJson(metaFile, meta);
        console.log(`[scores] progress=${checked}/${queue.length} withScore=${withScore} errs=${errs}`);
      }
    },
    { shouldStop: () => Boolean(rateLimited) || Date.now() - startTime > maxMs }
  );

  writeGzJson(metaFile, meta);
  if (catalogDirty && catalog) {
    writeGzJson(catalogPath, catalog);
  }

  const totalScored = Object.values(meta).filter((v) => v && typeof v.score === 'number' && v.score > 0).length;
  const summary = {
    checked,
    withScore,
    errs,
    totalScored,
    rateLimited: rateLimited || null,
    elapsedSec: Math.round((Date.now() - startTime) / 1000),
  };
  console.log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const catalogPath = posArgs[0] || 'catalog.gz';
  const argNum = (prefix, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(prefix));
    return hit ? Number(hit.split('=')[1]) : fallback;
  };
  await backfillScores({
    catalogPath,
    limit: argNum('--limit=', 3500),
    concurrency: argNum('--concurrency=', 12),
    delayMs: argNum('--delay=', 40),
    maxMs: argNum('--max-minutes=', 15) * 60 * 1000,
  });
}
