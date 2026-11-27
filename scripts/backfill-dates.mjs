/**
 * Progressive concurrent backfill of book first-chapter publish dates (开书时长).
 * Each book's start date is permanent, so once fetched it is cached forever in data/book-dates.json.gz.
 * Preserves existing score/sc/su metadata stored on the same entry.
 *
 * Usage:
 *   node scripts/backfill-dates.mjs <catalog.gz> [limit=1500] [--concurrency=4]
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cnDay, readGzJson, writeGzJson, fetchJson, runPool } from './lib.mjs';

const catalogPath = process.argv[2] || 'catalog.gz';
const limit = Number(process.argv[3] || 1500);
const concArg = process.argv.find((a) => a.startsWith('--concurrency='));
const requestedConcurrency = concArg ? Number(concArg.split('=')[1]) : 4;
const concurrency = Math.max(1, Math.min(Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4, 4));

const metaFile = 'data/book-dates.json.gz';
const today = cnDay();
const catalog = readGzJson(catalogPath);
const meta = fs.existsSync(metaFile) ? readGzJson(metaFile) : {};

// Prioritize today's ranked/board books first, then catalog books by readers desc
const priorityIds = [];
const seenIds = new Set();
const histFile = path.join('history', `${today}.json.gz`);
if (fs.existsSync(histFile)) {
  try {
    const snap = readGzJson(histFile);
    for (const targetMold of [1, 2]) {
      for (const s of snap.scopes || []) {
        if ((targetMold === 1 ? s.mold === 1 : s.mold !== 1)) {
          for (const r of s.rows || []) {
            const id = String(r.id || '');
            if (id && !seenIds.has(id)) {
              seenIds.add(id);
              priorityIds.push(id);
            }
          }
        }
      }
    }
    for (const b of Object.values(snap.boards || {})) {
      for (const r of b.rows || []) {
        const id = String(r.id || '');
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          priorityIds.push(id);
        }
      }
    }
  } catch {}
}

for (const b of [...catalog.books].sort((a, b) => (b.readers || 0) - (a.readers || 0))) {
  const id = String(b.id);
  if (id && !seenIds.has(id)) {
    seenIds.add(id);
    priorityIds.push(id);
  }
}

const queue = priorityIds
  .filter((id) => !meta[id]?.start && !meta[id]?.na)
  .slice(0, limit);

console.log(`[dates] existing=${Object.keys(meta).length} concurrency=${concurrency} queue=${queue.length}`);

let ok = 0;
let na = 0;
let errs = 0;
let consecutiveErrs = 0;
let cooldownUntil = 0;
let cooldownCount = 0;
let rateLimited = '';
const startTime = Date.now();

await runPool(
  queue,
  concurrency,
  async (id) => {
    while (Date.now() < cooldownUntil) {
      if (rateLimited) return;
      await sleep(500);
    }
    if (rateLimited) return;
    await sleep(220 + Math.floor(Math.random() * 120));
    try {
      const { data } = await fetchJson(
        `https://fanqienovel.com/api/reader/directory/detail?bookId=${id}`,
        { timeoutMs: 14000, retries: 1 }
      );
      if (data.code === -1) {
        meta[id] = { ...(meta[id] || {}), na: true, checked: today };
        na++;
        consecutiveErrs = 0;
        return;
      }
      if (data.code !== 0 || !Array.isArray(data.data?.chapterListWithVolume)) {
        throw new Error(`code=${data.code}`);
      }
      const chapters = data.data.chapterListWithVolume.flat();
      let first = chapters.find((c) => String(c.realChapterOrder) === '1' && Number(c.firstPassTime) > 0);
      if (!first) {
        const valid = chapters.filter((c) => Number(c.firstPassTime) > 0);
        valid.sort((a, b) => Number(a.firstPassTime) - Number(b.firstPassTime));
        first = valid[0];
      }
      if (!first) {
        meta[id] = { ...(meta[id] || {}), na: true, checked: today };
        na++;
      } else {
        meta[id] = { ...(meta[id] || {}), start: cnDay(Number(first.firstPassTime) * 1000), checked: today };
        ok++;
      }
      consecutiveErrs = 0;
      if ((ok + na) % 250 === 0) writeGzJson(metaFile, meta);
    } catch (e) {
      if (e.rateLimited) {
        rateLimited = e.message;
      } else {
        errs++;
        consecutiveErrs++;
        if (consecutiveErrs >= 8) {
          if (cooldownCount < 4) {
            cooldownCount++;
            consecutiveErrs = 0;
            cooldownUntil = Date.now() + 10000;
            console.log(`[dates] cooldown #${cooldownCount} for 10s after: ${e.message}`);
          } else {
            rateLimited = `连续失败: ${e.message}`;
          }
        }
      }
    }
  },
  { shouldStop: () => Boolean(rateLimited) }
);

writeGzJson(metaFile, meta);
const withStart = Object.values(meta).filter((v) => v && v.start).length;
console.log(
  JSON.stringify({
    added: ok,
    na,
    errs,
    cooldowns: cooldownCount,
    totalWithStart: withStart,
    catalogSize: catalog.books.length,
    rateLimited: rateLimited || null,
    elapsedSec: Math.round((Date.now() - startTime) / 1000),
  })
);
