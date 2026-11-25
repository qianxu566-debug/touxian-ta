/**
 * Progressive concurrent backfill of book first-chapter publish dates (开书时长).
 * Each book's start date is permanent, so once fetched it is cached forever in data/book-dates.json.gz.
 *
 * Usage:
 *   node scripts/backfill-dates.mjs <catalog.gz> [limit=1500] [--concurrency=6]
 */
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { cnDay, readGzJson, writeGzJson, fetchJson, runPool } from './lib.mjs';

const catalogPath = process.argv[2] || 'catalog.gz';
const limit = Number(process.argv[3] || 1500);
const concArg = process.argv.find((a) => a.startsWith('--concurrency='));
const concurrency = concArg ? Number(concArg.split('=')[1]) : 6;

const metaFile = 'data/book-dates.json.gz';
const today = cnDay();
const catalog = readGzJson(catalogPath);
const meta = fs.existsSync(metaFile) ? readGzJson(metaFile) : {};

const queue = [...catalog.books]
  .sort((a, b) => (b.readers || 0) - (a.readers || 0))
  .map((b) => String(b.id))
  .filter((id) => !meta[id]?.start && !meta[id]?.na)
  .slice(0, limit);

console.log(`[dates] existing=${Object.keys(meta).length} queue=${queue.length}`);

let ok = 0;
let na = 0;
let errs = 0;
let consecutiveErrs = 0;
let rateLimited = '';
const startTime = Date.now();

await runPool(
  queue,
  concurrency,
  async (id) => {
    if (rateLimited) return;
    await sleep(100);
    try {
      const { data } = await fetchJson(
        `https://fanqienovel.com/api/reader/directory/detail?bookId=${id}`,
        { timeoutMs: 14000, retries: 1 }
      );
      if (data.code === -1) {
        meta[id] = { na: true, checked: today };
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
        meta[id] = { na: true, checked: today };
        na++;
      } else {
        meta[id] = { start: cnDay(Number(first.firstPassTime) * 1000), checked: today };
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
        if (consecutiveErrs >= 15) rateLimited = `连续失败: ${e.message}`;
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
    totalWithStart: withStart,
    catalogSize: catalog.books.length,
    rateLimited: rateLimited || null,
    elapsedSec: Math.round((Date.now() - startTime) / 1000),
  })
);
