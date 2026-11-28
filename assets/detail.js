import { fetchCached, mobilePlatform, appLink, ageDays, dayString } from './reader.js?v=28';
import { getTrend, shortDelta, deltaClass, formatPct, dayLabel, renderRankBadges, renderTrendPanel, windowMetric, calendarDayGap } from './daily.js?v=28';

const nf = new Intl.NumberFormat('zh-CN');
const wanNf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
const shardCache = new Map();
const BADGE_NAMES = { 2: '阅读榜', 1: '新书榜', 3: '巅峰榜', 4: '黑马榜', 5: '热搜榜', 6: '推荐榜' };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escAttr = (v) => esc(v);
const fmtReaders = (n) => (!Number.isFinite(n) ? '暂无' : n >= 10000 ? `${wanNf.format(n / 10000)} 万` : nf.format(n));
const fmtWords = (n) => (!Number.isFinite(n) ? '' : n >= 10000 ? `${wanNf.format(n / 10000)}万字` : `${nf.format(n)}字`);
const fmtScoreCnt = (n) => (!Number.isFinite(n) || n <= 0 ? '' : `${n >= 10000 ? `${wanNf.format(n / 10000)}万` : nf.format(n)}人评价`);

function shiftDateStr(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function fmtCompactWordDiff(diff) {
  if (!Number.isFinite(diff)) return '';
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '';
  const abs = Math.abs(diff);
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return `${sign}${nf.format(abs)}`;
}

export function bookBucketId(id) {
  const s = String(id ?? '').trim();
  if (/^\d+$/.test(s)) {
    const tail = s.length >= 2 ? s.slice(-2) : s;
    return String(Number(tail) % 100).padStart(2, '0');
  }
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 100;
  return String(h).padStart(2, '0');
}

export async function loadBookShard(id, ver = '', opts = {}) {
  const bucket = bookBucketId(id);
  const cacheKey = `${bucket}|${ver}`;
  if (!opts.forceNetwork && shardCache.has(cacheKey)) {
    return shardCache.get(cacheKey);
  }
  const path = `./data/books/b${bucket}.json.gz`;
  const res = await fetchCached(path, {
    gz: true,
    timeoutMs: opts.timeoutMs ?? 15000,
    stallMs: opts.stallMs ?? 15000,
    maxTotalMs: opts.maxTotalMs ?? 40000,
    retries: opts.retries ?? 2,
    ver,
    forceNetwork: Boolean(opts.forceNetwork),
  });
  shardCache.set(cacheKey, res.data);
  return res.data;
}

export function resolveReadAction(book) {
  const bid = String(book?.id || '').trim();
  const webUrl = `https://fanqienovel.com/page/${encodeURIComponent(bid)}`;
  const plat = mobilePlatform();
  const deepUrl = plat ? appLink(bid, plat) : '';
  if (deepUrl) {
    return {
      primary: { kind: 'app', label: '去番茄 App 读 ↗', href: deepUrl },
      secondary: { kind: 'web', label: '番茄网页版 ↗', href: webUrl },
    };
  }
  return {
    primary: { kind: 'web', label: '前往番茄网页版 ↗', href: webUrl },
    secondary: null,
  };
}

function fmtAge(start, at) {
  const d = ageDays(start, at);
  if (d === null) return '';
  if (d <= 100) return `开书 ${d} 天`;
  const ann = new Date(`${start}T00:00:00Z`);
  ann.setUTCFullYear(ann.getUTCFullYear() + 1);
  if (Date.parse(at) < ann.getTime()) return `开书 ${Math.min(11, Math.floor(d / 30))} 个月`;
  return `开书 ${Number((d / 365.2425).toFixed(1))} 年`;
}

function fmtLastUpdate(ts) {
  if (!Number.isFinite(ts) || ts <= 946684800) return '';
  const d = new Date(ts * 1000);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays <= 0) return '今日更新';
  if (diffDays === 1) return '昨日更新';
  if (diffDays <= 30) return `${diffDays} 天前更新`;
  return `${d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })} 更新`;
}

function fineTagsOf(book) {
  const primSet = new Set(Array.isArray(book?.primary) ? book.primary : []);
  const all = [
    ...(Array.isArray(book?.tags) ? book.tags : []),
    ...Object.values(book?.officialTags || {}).flat(),
  ];
  const out = [];
  const seen = new Set();
  for (const t of all) {
    if (typeof t !== 'string') continue;
    const s = t.trim();
    if (!s || s === '全部分类' || primSet.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function channelMatches(targetCh, candCh) {
  if (!targetCh || targetCh === '共用') return true;
  if (targetCh === '女频') return candCh === '女频';
  return candCh === targetCh || candCh === '共用';
}

export function findSameSignatureBooks(target, pool, limit = 8) {
  const author = String(target?.author || '').trim();
  if (!author || author === '佚名' || !Array.isArray(pool) || !pool.length) return [];
  const tid = String(target.id);
  const list = pool.filter((b) => String(b.id) !== tid && String(b.author || '').trim() === author);
  list.sort((a, b) => ((b.readers ?? 0) - (a.readers ?? 0)) || String(a.id).localeCompare(String(b.id)));
  return list.slice(0, limit);
}

let cachedPoolRef = null;
let cachedTagFreq = new Map();

function getTagFreq(pool) {
  if (pool === cachedPoolRef && cachedTagFreq.size) return cachedTagFreq;
  const freq = new Map();
  for (const b of pool) {
    for (const t of fineTagsOf(b)) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  cachedPoolRef = pool;
  cachedTagFreq = freq;
  return freq;
}

export function findSimilarBooks(target, pool, { relaxed = false, limit = 10 } = {}) {
  if (!target || !Array.isArray(pool) || !pool.length) {
    return { strict: [], relaxedList: [], canRelax: false, primaryName: '' };
  }
  const tid = String(target.id);
  const tgtPrims = Array.isArray(target.primary) ? target.primary : [];
  const tgtPrimSet = new Set(tgtPrims);
  const tgtFine = fineTagsOf(target);
  const tgtFineSet = new Set(tgtFine);
  const tagFreq = getTagFreq(pool);

  const strict = [];
  const relaxedList = [];

  for (const cand of pool) {
    const cid = String(cand.id);
    if (cid === tid) continue;
    if (!channelMatches(target.channel, cand.channel)) continue;

    const candPrims = Array.isArray(cand.primary) ? cand.primary : [];
    const sharedPrims = candPrims.filter((p) => tgtPrimSet.has(p));
    const sharedTags = [];
    let tagScore = 0;

    if (tgtFineSet.size) {
      for (const t of fineTagsOf(cand)) {
        if (!tgtFineSet.has(t)) continue;
        sharedTags.push(t);
        const f = tagFreq.get(t) || 50;
        tagScore += 1 / Math.sqrt(Math.max(3, f));
      }
    }

    if (sharedTags.length > 0) {
      sharedTags.sort((a, b) => (tagFreq.get(a) || 9999) - (tagFreq.get(b) || 9999));
      const topLabels = sharedTags.slice(0, 3);
      const reasonParts = [];
      if (sharedPrims.length) reasonParts.push(`同分类「${sharedPrims[0]}」`);
      reasonParts.push(`同为 ${topLabels.join(' + ')}`);
      const wordProx = Number.isFinite(target.words) && Number.isFinite(cand.words) && target.words > 0
        ? Math.max(0, 1 - Math.abs(Math.log10(Math.max(1, cand.words) / Math.max(1, target.words))) * 0.5)
        : 0;
      const totalScore =
        (sharedTags.length >= 2 ? 12 : 0) +
        tagScore * 18 +
        (sharedPrims.length ? 3.5 : 0) +
        (cand.status && cand.status === target.status ? 0.8 : 0) +
        wordProx +
        Math.min(1.5, Math.log10(Math.max(1000, cand.readers || 1000)) * 0.2);

      strict.push({
        book: cand,
        score: totalScore,
        reason: reasonParts.join(' · '),
        isRelaxed: false,
      });
    } else if (sharedPrims.length > 0) {
      const sameStatus = cand.status && cand.status === target.status;
      const reason = `同分类「${sharedPrims[0]}」${sameStatus ? ` · 同为${cand.status}` : ''}`;
      relaxedList.push({
        book: cand,
        score: (cand.readers || 0) + (cand.score || 0) * 5000 + (sameStatus ? 10000 : 0),
        reason,
        isRelaxed: true,
      });
    }
  }

  strict.sort((a, b) => (b.score - a.score) || ((b.book.readers ?? 0) - (a.book.readers ?? 0)));
  relaxedList.sort((a, b) => (b.score - a.score) || ((b.book.readers ?? 0) - (a.book.readers ?? 0)));

  return {
    strict: strict.slice(0, limit),
    relaxedList: relaxed ? relaxedList.slice(0, limit) : relaxedList.slice(0, Math.max(4, limit - Math.min(limit, strict.length))),
    canRelax: relaxedList.length > 0,
    primaryName: tgtPrims[0] || '',
  };
}

function renderMiniBookItem(entry, { showReason = true } = {}) {
  const b = entry.book || entry;
  const bid = String(b.id || '');
  const sc = Number.isFinite(b.score) && b.score > 0 ? `★ ${b.score.toFixed(1)}` : '';
  const metaParts = [fmtReaders(b.readers) + ' 在读', fmtWords(b.words), b.status, sc].filter(Boolean);
  return `<a class="dRelCard" href="?book=${encodeURIComponent(bid)}" data-open-book="${esc(bid)}">
    <div class="dRelTop"><b class="dRelTitle">${esc(b.title)}</b><span class="dRelArrow" aria-hidden="true">›</span></div>
    ${showReason && entry.reason ? `<div class="dRelReason">${esc(entry.reason)}</div>` : ''}
    <div class="dRelMeta">${metaParts.map(esc).join(' · ')}</div>
  </a>`;
}

export function renderWordBarPanel(wordSeries, dates = [], rangeDays = 7) {
  const validPts = Array.isArray(wordSeries) ? wordSeries.filter((p) => Array.isArray(p) && dates[p[0]] && Number.isFinite(p[1])) : [];
  if (validPts.length < 2) {
    return `<div class="wordBarEmpty">字数序列积累中（当前 ${validPts.length} 个实测日），满 2 个实测日自动绘制日更柱图。</div>`;
  }
  const effRange = rangeDays === 30 ? 30 : 7;
  const lastDate = dates[validPts[validPts.length - 1][0]];
  const cutoff = shiftDateStr(lastDate, -(effRange - 1));
  let winPts = validPts.filter((p) => dates[p[0]] >= cutoff);
  if (winPts.length < 2) {
    winPts = validPts.slice(-Math.min(validPts.length, effRange));
  }

  const startDate = dates[winPts[0][0]];
  const endDate = dates[winPts[winPts.length - 1][0]];
  const spanDays = Math.min(35, calendarDayGap(startDate, endDate, winPts[0][0], winPts[winPts.length - 1][0]) + 1);
  const obsByDate = new Map(winPts.map(([idx, w]) => [dates[idx], { idx, w }]));

  const cols = [];
  let prevObs = null;
  for (let dOff = 0; dOff < spanDays; dOff++) {
    const dStr = shiftDateStr(startDate, dOff);
    const cur = obsByDate.get(dStr);
    if (!cur) {
      cols.push({
        date: dStr,
        mmdd: dStr.slice(5),
        kind: 'gap',
        totalWords: null,
        delta: null,
        gapDays: 0,
        readout: `${dStr.slice(5)} · 字数缺测（保留空白，不做均摊）`,
      });
      continue;
    }
    if (!prevObs) {
      cols.push({
        date: dStr,
        mmdd: dStr.slice(5),
        kind: 'base',
        totalWords: cur.w,
        delta: null,
        gapDays: 0,
        readout: `${dStr.slice(5)} · 总字数 ${fmtWords(cur.w)} · 窗口基准日`,
      });
    } else {
      const gap = calendarDayGap(prevObs.date, dStr, prevObs.idx, cur.idx);
      const diff = cur.w - prevObs.w;
      if (gap === 1) {
        const diffDesc = diff > 0 ? `日更 +${nf.format(diff)} 字` : diff === 0 ? '当日未更（0 字）' : `修文 ${nf.format(diff)} 字`;
        cols.push({
          date: dStr,
          mmdd: dStr.slice(5),
          kind: 'daily',
          totalWords: cur.w,
          delta: diff,
          gapDays: 1,
          readout: `${dStr.slice(5)} · 总字数 ${fmtWords(cur.w)} · ${diffDesc}`,
        });
      } else {
        const diffDesc = diff >= 0 ? `跨 ${gap} 日净增 +${nf.format(diff)} 字` : `跨 ${gap} 日净变动 ${nf.format(diff)} 字`;
        cols.push({
          date: dStr,
          mmdd: dStr.slice(5),
          kind: 'interval',
          totalWords: cur.w,
          delta: diff,
          gapDays: gap,
          readout: `${dStr.slice(5)} · 总字数 ${fmtWords(cur.w)} · ${diffDesc}`,
        });
      }
    }
    prevObs = { date: dStr, idx: cur.idx, w: cur.w };
  }

  const dailyPos = cols.filter((c) => c.kind === 'daily' && c.delta > 0).map((c) => c.delta);
  const maxDaily = dailyPos.length ? Math.max(2000, ...dailyPos) : 4000;
  const lastObsIdx = cols.map((c, i) => (c.kind !== 'gap' ? i : -1)).filter((i) => i >= 0).pop() ?? (cols.length - 1);
  const hasInterval = cols.some((c) => c.kind === 'interval');
  const hasGap = cols.some((c) => c.kind === 'gap');

  const colsHtml = cols.map((c, i) => {
    const isAct = i === lastObsIdx;
    let body = '';
    if (c.kind === 'gap') {
      body = '<span class="wbGapSlot" title="当日缺测">缺测</span>';
    } else if (c.kind === 'base') {
      body = '<span class="wbBaseDot" title="窗口起始实测">起点</span>';
    } else if (c.kind === 'interval') {
      body = `<span class="wbIntervalPill" title="跨${c.gapDays}日实测区间净增（中间缺测不均摊）">跨${c.gapDays}日<br>${esc(fmtCompactWordDiff(c.delta))}</span>`;
    } else if (c.delta > 0) {
      const hPct = Math.max(14, Math.min(100, Math.round((c.delta / maxDaily) * 100)));
      body = `<span class="wbValTop">${esc(fmtCompactWordDiff(c.delta))}</span><span class="wbBar" style="height:${hPct}%"></span>`;
    } else if (c.delta === 0) {
      body = '<span class="wbZeroBar" title="未更新">0</span>';
    } else {
      body = '<span class="wbNegBar" title="总字数回调">修文</span>';
    }
    return `<button type="button" class="wbCol ${c.kind}${isAct ? ' active' : ''}" data-wb-idx="${i}" title="${escAttr(c.readout)}">
      <span class="wbTrack">${body}</span>
      <span class="wbLbl">${esc(c.mmdd.slice(3))}</span>
    </button>`;
  }).join('');

  return `<div class="wordBarPanel" data-wb-readouts="${escAttr(JSON.stringify(cols.map((c) => c.readout)))}">
    <div class="wbHead">
      <span class="wbTitle">日更字数柱</span>
      <span class="wbMeta">${hasInterval || hasGap ? '仅相邻实测日绘日更柱 · 跨日缺测留空并标区间净增' : `近 ${spanDays} 天相邻实测日更`}</span>
    </div>
    <div class="wbReadout" aria-live="polite">${esc(cols[lastObsIdx]?.readout || '')}</div>
    <div class="wbBars" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))">${colsHtml}</div>
  </div>`;
}

export function bindWordBarChart(container) {
  const panel = container?.querySelector?.('.wordBarPanel[data-wb-readouts]');
  if (!panel || panel.dataset.bound === '1') return;
  let readouts;
  try {
    readouts = JSON.parse(panel.dataset.wbReadouts || '[]');
  } catch {
    return;
  }
  panel.dataset.bound = '1';
  const readoutEl = panel.querySelector('.wbReadout');
  const cols = [...panel.querySelectorAll('.wbCol[data-wb-idx]')];
  const activate = (idx) => {
    const msg = readouts[idx];
    if (!msg) return;
    if (readoutEl) readoutEl.textContent = msg;
    for (const c of cols) c.classList.toggle('active', Number(c.dataset.wbIdx) === idx);
  };
  for (const c of cols) {
    c.addEventListener('click', () => activate(Number(c.dataset.wbIdx)));
    c.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') activate(Number(c.dataset.wbIdx)); });
  }
}

export function renderDailyDetailTable(series, wordSeries, dates = [], rangeDays = 7) {
  const rPts = Array.isArray(series) ? series.filter((p) => Array.isArray(p) && dates[p[0]] && Number.isFinite(p[1])) : [];
  const wPts = Array.isArray(wordSeries) ? wordSeries.filter((p) => Array.isArray(p) && dates[p[0]] && Number.isFinite(p[1])) : [];
  if (!rPts.length && !wPts.length) return '';

  const effRange = rangeDays === 30 ? 30 : 7;
  const allDatesInPts = [...rPts.map((p) => dates[p[0]]), ...wPts.map((p) => dates[p[0]])].sort();
  const endDate = allDatesInPts[allDatesInPts.length - 1];
  const cutoff = shiftDateStr(endDate, -(effRange - 1));
  const earliestObs = allDatesInPts[0];
  const startDate = earliestObs > cutoff ? earliestObs : cutoff;
  const spanDays = Math.min(35, calendarDayGap(startDate, endDate, 0, 1) + 1);

  const rMap = new Map(rPts.map(([idx, val]) => [dates[idx], { idx, val }]));
  const wMap = new Map(wPts.map(([idx, val]) => [dates[idx], { idx, val }]));

  const rows = [];
  let prevR = null;
  let prevW = null;
  let gapCount = 0;

  // Initialize prevR / prevW right before startDate if earlier points exist
  for (const [idx, val] of rPts) {
    if (dates[idx] < startDate) prevR = { date: dates[idx], idx, val };
  }
  for (const [idx, val] of wPts) {
    if (dates[idx] < startDate) prevW = { date: dates[idx], idx, val };
  }

  for (let dOff = 0; dOff < spanDays; dOff++) {
    const dStr = shiftDateStr(startDate, dOff);
    const rCur = rMap.get(dStr);
    const wCur = wMap.get(dStr);
    if (!rCur && !wCur) {
      gapCount++;
      rows.push({
        date: dStr,
        isGap: true,
        readersTxt: '缺测',
        rDeltaTxt: '—',
        rDeltaCls: 'flat',
        wordsTxt: '缺测',
        wDeltaTxt: '—',
      });
      continue;
    }

    let rDeltaTxt = '首次';
    let rDeltaCls = 'flat';
    if (rCur) {
      if (prevR) {
        const rg = calendarDayGap(prevR.date, dStr, prevR.idx, rCur.idx);
        const rd = rCur.val - prevR.val;
        rDeltaCls = deltaClass(rd);
        const sign = rd > 0 ? '+' : rd < 0 ? '-' : '';
        const num = rd === 0 ? '0' : `${sign}${nf.format(Math.abs(rd))}`;
        rDeltaTxt = rg > 1 ? `跨${rg}日 ${num}` : num;
      }
      prevR = { date: dStr, idx: rCur.idx, val: rCur.val };
    } else {
      gapCount++;
      rDeltaTxt = '缺测';
    }

    let wDeltaTxt = '—';
    if (wCur) {
      if (prevW) {
        const wg = calendarDayGap(prevW.date, dStr, prevW.idx, wCur.idx);
        const wd = wCur.val - prevW.val;
        if (wg > 1) {
          wDeltaTxt = `跨${wg}日净增 ${fmtCompactWordDiff(wd)}`;
        } else if (wd > 0) {
          wDeltaTxt = `+${nf.format(wd)}`;
        } else if (wd === 0) {
          wDeltaTxt = '未更';
        } else {
          wDeltaTxt = nf.format(wd);
        }
      }
      prevW = { date: dStr, idx: wCur.idx, val: wCur.val };
    }

    rows.push({
      date: dStr,
      isGap: !rCur,
      readersTxt: rCur ? fmtReaders(rCur.val) : '缺测',
      rDeltaTxt,
      rDeltaCls,
      wordsTxt: wCur ? fmtWords(wCur.val) : '—',
      wDeltaTxt,
    });
  }

  const descRows = rows.reverse();
  const tbody = descRows.map((r) => `<tr class="${r.isGap ? 'isGapRow' : ''}">
    <td>${esc(r.date.slice(5))}</td>
    <td>${esc(r.readersTxt)}</td>
    <td class="ddDelta ${esc(r.rDeltaCls)}">${esc(r.rDeltaTxt)}</td>
    <td>${esc(r.wordsTxt)}</td>
    <td>${esc(r.wDeltaTxt)}</td>
  </tr>`).join('');

  return `<details class="dDailyDetails">
    <summary>逐日实测明细（共 ${descRows.length} 天${gapCount ? ` · 含 ${gapCount} 天缺测` : ''}）</summary>
    <div class="dDailyWrap">
      <table class="dDailyTable">
        <thead><tr><th>日期</th><th>在读</th><th>较前变化</th><th>总字数</th><th>日更/区间</th></tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  </details>`;
}

function renderMilestonesTimeline(milestones) {
  if (!Array.isArray(milestones) || !milestones.length) return '';
  const rows = milestones.map(([dateStr, kind, grp, val, isBaseline]) => {
    const grpName = BADGE_NAMES[grp] || `榜单${grp}`;
    let text = '';
    if (kind === 'enter') text = `首入 ${grpName} · 第 ${val} 名`;
    else if (kind === 'peak') text = `${grpName} 冲至最高第 ${val} 名`;
    else if (kind === 'drop') text = `暂别 ${grpName}（本轮累计在榜 ${val} 天）`;
    else if (kind === 'cross10k') text = `实测在读突破 1 万（前日 ${fmtReaders(val)}）`;
    else if (kind === 'obs') text = `开始追踪每日实测（在读 ${fmtReaders(val)}）`;
    else text = `${grpName} 记录`;

    const baseBadge = isBaseline ? '<span class="dMsBaseTag">本站首次记录</span>' : '';
    return `<li class="dMsItem${isBaseline ? ' isBase' : ''}">
      <span class="dMsDate">${esc(String(dateStr || '').slice(5))}</span>
      <span class="dMsDot" aria-hidden="true"></span>
      <span class="dMsBody">${esc(text)}${baseBadge}</span>
    </li>`;
  }).join('');
  return `<ul class="dMilestoneList" id="detailMilestones" aria-label="上榜与收录里程碑">${rows}</ul>`;
}
export function renderDetailMarkup(ctx) {
  const {
    book,
    id,
    saved,
    shelfItem = null,
    fattenEval = null,
    isLostCatalog = false,
    blockMatch = null,
    isSingleBookBlocked = false,
    coverUrl,
    trendObj,
    trendsPayload,
    radarPayload,
    startDate,
    stackDepth = 0,
    hasInSitePrev = false,
    coreReady = false,
    coreFailed = false,
    shardLoading = false,
    shardFailed = false,
    pool = [],
    similarRelaxed = false,
    introExpanded = false,
    toastMsg = '',
    wordSeries = [],
    milestones = [],
    trendRange = 7,
  } = ctx;

  const backLabel = stackDepth > 0 ? '← 返回上一本' : hasInSitePrev ? '← 返回列表' : '← 去搜作品';
  const showSearchLink = stackDepth > 0 && !hasInSitePrev;

  if (!book) {
    return `<div class="dTopBar">
      <button type="button" class="dBackBtn" id="detailBackBtn">${esc(backLabel)}</button>
      <div class="dTopOps">
        ${!hasInSitePrev && stackDepth === 0 ? '' : '<button type="button" class="dGhostBtn" id="detailGoSearch">去搜作品</button>'}
      </div>
    </div>
    <div class="dStateBox">
      ${shardLoading
        ? `<div class="dStateTitle">正在读取《${esc(id)}》作品档案…</div><p class="dStateSub">冷启动直达仅加载目标单书分片，无需等待整库下载。</p>`
        : shardFailed
          ? `<div class="dStateTitle">作品档案加载失败</div><p class="dStateSub">可能由于网络超时或波动，未完整取得单书分片数据。</p><button type="button" class="dPrimaryBtn" id="detailShardRetry">重新加载档案</button>`
          : `<div class="dStateTitle">暂未在当前书库中找到该作品（${esc(id)}）</div><p class="dStateSub">可能已被下架隔离或未达收录门槛，仍可直接前往番茄官网核验。</p><div class="dStateBtns"><a class="dPrimaryBtn" target="_blank" rel="noopener" href="https://fanqienovel.com/page/${encodeURIComponent(id)}">前往番茄网页版查看 ↗</a></div>`}
    </div>`;
  }

  const readAct = resolveReadAction(book);
  const primList = Array.isArray(book.primary) ? book.primary : [];
  const tags = fineTagsOf(book);
  const atDate = trendsPayload?.latestDate || radarPayload?.latestRankDate || dayString();
  const ageStr = fmtAge(startDate, atDate);
  const updStr = fmtLastUpdate(book.lastUpdate);
  const wordFmt = fmtWords(book.words);
  const specs = [wordFmt, book.status, ageStr, updStr].filter(Boolean);
  const tone = Number(String(book.id).slice(-2)) % 4 || 0;
  const tqTitle = String(book.title || '').replace(/[：:·\s].*$/, '').slice(0, 5) || String(book.title || '').slice(0, 5);

  const readersVal = Number.isFinite(trendObj?.readers) ? trendObj.readers : book.readers;
  const scoreVal = Number.isFinite(book.score) && book.score > 0 ? book.score : null;
  const scoreCntStr = fmtScoreCnt(book.scoreCount);
  const m1 = trendObj ? windowMetric(trendObj, 1, trendsPayload?.dates) : { d: null };
  const m7 = trendObj ? windowMetric(trendObj, 7, trendsPayload?.dates) : { d: null };

  const introText = (book.intro || '').trim();
  const introParas = introText ? introText.split(/\n+/).map((s) => s.trim()).filter(Boolean) : [];
  const isLongIntro = introText.length > 150 || introParas.length > 3;

  const badgeHtml = renderRankBadges(radarPayload, book.id, book._badges || book.badges);
  const milestoneHtml = renderMilestonesTimeline(milestones);
  const trendDataObj = trendObj
    ? { latestDate: trendsPayload?.latestDate, dates: trendsPayload?.dates || [], books: { [String(book.id)]: [trendObj.readers, trendObj.d1, trendObj.p1, trendObj.d7, trendObj.p7, trendObj.d30, trendObj.p30, trendObj.dw1, trendObj.series] } }
    : null;
  const activeTrendRange = [1, 7, 30].includes(Number(trendRange)) ? Number(trendRange) : 7;
  const trendPanelHtml = trendDataObj
    ? renderTrendPanel(trendDataObj, book.id, activeTrendRange)
    : '<div class="trendEmpty">暂无足够历史在读序列，次日采集后将自动生成折线。</div>';
  const wordBarHtml = renderWordBarPanel(wordSeries, trendsPayload?.dates || [], activeTrendRange);
  const dailyDetailsHtml = renderDailyDetailTable(trendObj?.series || [], wordSeries, trendsPayload?.dates || [], activeTrendRange);

  const hasPool = Array.isArray(pool) && pool.length > 0;
  const sameAuthor = (coreReady || (!coreFailed && hasPool))
    ? findSameSignatureBooks(book, pool, coreReady ? 8 : 6)
    : [];
  const simResult = (coreReady || (!coreFailed && hasPool))
    ? findSimilarBooks(book, pool, { relaxed: similarRelaxed, limit: coreReady ? 10 : 6 })
    : { strict: [], relaxedList: [], canRelax: false, primaryName: primList[0] || '' };

  let similarBodyHtml = '';
  if (!coreReady) {
    if (coreFailed) {
      similarBodyHtml = '<div class="dRelHint">全库索引加载超时，暂时无法匹配相近作品。<button type="button" class="syncRetryBtn" data-retry-sync="1">重试全库</button></div>';
    } else if (simResult.strict.length > 0) {
      similarBodyHtml = `<div class="dRelHint dRelSyncing">全库索引同步中，先展示热门库初步匹配（完成后自动补齐全库 2.6 万本）…</div><div class="dRelList">${simResult.strict.map((e) => renderMiniBookItem(e)).join('')}</div>`;
    } else if (simResult.relaxedList.length > 0) {
      similarBodyHtml = `<div class="dRelHint dRelSyncing">全库索引同步中，先展示热门库同分类初步匹配（完成后自动补齐全库 2.6 万本）…</div><div class="dRelList">${simResult.relaxedList.map((e) => renderMiniBookItem(e)).join('')}</div>`;
    } else {
      similarBodyHtml = '<div class="dRelHint">正在同步全库索引（首次同步完成后将自动缓存至本机，秒开推荐）…</div>';
    }
  } else {
    const strictCards = simResult.strict.map((e) => renderMiniBookItem(e)).join('');
    const showRelaxNow = similarRelaxed || simResult.strict.length === 0;
    const relaxCards = showRelaxNow ? simResult.relaxedList.map((e) => renderMiniBookItem(e)).join('') : '';
    const relaxBtnHtml = !showRelaxNow && simResult.canRelax && simResult.strict.length < 6
      ? `<button type="button" class="dRelaxBtn" id="detailRelaxBtn">放宽条件：再看「${esc(simResult.primaryName || '同分类')}」更多作品 ▾</button>`
      : '';
    if (!strictCards && !relaxCards) {
      similarBodyHtml = '<div class="dRelHint">当前书库暂无高度匹配的相近作品，可直接点上方分类标签去搜作品探索。</div>';
    } else {
      similarBodyHtml = (strictCards ? `<div class="dRelList">${strictCards}</div>` : '<div class="dRelHint">未找到重叠细题材作品，已自动放宽至同主分类：</div>')
        + relaxBtnHtml
        + (relaxCards ? `<div class="dRelSubHead">同主分类拓展</div><div class="dRelList">${relaxCards}</div>` : '');
    }
  }

  let authorBodyHtml = '';
  if (!book.author || book.author === '佚名') {
    authorBodyHtml = '<div class="dRelHint">该作品暂无署名信息。</div>';
  } else if (!coreReady) {
    if (coreFailed) {
      authorBodyHtml = `<div class="dRelHint">全库加载失败，暂未查询「${esc(book.author)}」其他作品。<button type="button" class="syncRetryBtn" data-retry-sync="1">重试全库</button></div>`;
    } else if (sameAuthor.length > 0) {
      authorBodyHtml = `<div class="dRelHint dRelSyncing">全库同步中，先展示热门库已发现同署名作品…</div><div class="dRelList">${sameAuthor.map((b) => renderMiniBookItem({ book: b }, { showReason: false })).join('')}</div>`;
    } else {
      authorBodyHtml = `<div class="dRelHint">正在同步全库以查询「${esc(book.author)}」同署名作品…</div>`;
    }
  } else if (!sameAuthor.length) {
    authorBodyHtml = `<div class="dRelHint">当前库（≥8,000 在读）暂未收录「${esc(book.author)}」的其他作品。</div>`;
  } else {
    authorBodyHtml = `<div class="dRelList">${sameAuthor.map((b) => renderMiniBookItem({ book: b }, { showReason: false })).join('')}</div>`;
  }

  return `<div class="dTopBar">
    <button type="button" class="dBackBtn" id="detailBackBtn">${esc(backLabel)}</button>
    <div class="dTopOps">
      ${showSearchLink ? '<button type="button" class="dGhostBtn" id="detailGoSearch">回搜作品</button>' : ''}
      <button type="button" class="dGhostBtn" id="detailCopyLink">分享链接</button>
    </div>
  </div>

  <div class="dGrid">
    <div class="dMainCol">
      <section class="dCard dHeroCard" aria-label="作品档案">
        <div class="dHeroHead">
          <div class="dCoverBox">
            <span class="tiqian" data-tone="${tone}" aria-hidden="true"><em class="tqCat">${esc(primList[0] || '精选')}</em><b class="tqTitle">${esc(tqTitle)}</b></span>
            ${coverUrl ? `<img class="coverImg" src="${esc(coverUrl)}" referrerpolicy="no-referrer" alt="${esc(book.title)}封面">` : ''}
          </div>
          <div class="dHeroMeta">
            <h1 class="dTitle">${esc(book.title)}</h1>
            <div class="dAuthorRow">
              <span>作者：</span><a href="#detailAuthor" class="dAuthorJump" title="查看同署名作品">${esc(book.author || '未知')}</a>
              ${book.channel ? `<span class="dChTag">${esc(book.channel)}</span>` : ''}
            </div>
            <div class="dSpecs">${specs.map(esc).join(' · ')}</div>
            ${isLostCatalog ? '<div class="dLostPill">当前全库未收录 · 展示本机留存档案</div>' : ''}
            <div class="dCatsLine">
              ${primList.map((c) => `<a class="dCatChip" data-category="${esc(c)}" href="?category=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
              ${tags.slice(0, 8).map((t) => `<a class="dTagChip" data-tag="${esc(t)}" href="?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
            </div>
          </div>
        </div>
      </section>

      <section class="dCard dIntroCard" aria-label="作品简介与导读">
        <div class="dSecHead">
          <h2>作品简介</h2>
          <a href="#detailSimilar" class="dJumpSimBtn" id="detailJumpSimilar">找相似 ↓</a>
        </div>
        ${introParas.length
          ? `<div class="dIntroBody${isLongIntro && !introExpanded ? ' clamped' : ''}" id="detailIntroBody">${introParas.map((p, i) => `<p${i === 0 && (p.startsWith('【') || p.includes('｜') || p.includes('|')) ? ' class="blurbHook"' : ''}>${esc(p)}</p>`).join('')}</div>
             ${isLongIntro ? `<button type="button" class="dIntroToggle" id="detailIntroToggle" aria-expanded="${introExpanded}">${introExpanded ? '收起简介 ▴' : '展开全部简介 ▾'}</button>` : ''}`
          : '<p class="dIntroMissing">当前暂无简介（资料待补），可直接前往番茄官方查看最新章节与导读。</p>'}
      </section>

      <section class="dCard dActCard" aria-label="阅读与收藏操作">
        <div class="dActRow">
          <a class="dPrimaryBtn dReadPrimary" id="detailReadPrimary" data-kind="${readAct.primary.kind}" data-book-id="${esc(book.id)}" data-book-title="${esc(book.title)}" href="${esc(readAct.primary.href)}"${readAct.primary.kind === 'web' ? ' target="_blank" rel="noopener"' : ''}>${esc(readAct.primary.label)}</a>
          ${readAct.secondary ? `<a class="dSecBtn" href="${esc(readAct.secondary.href)}" target="_blank" rel="noopener">${esc(readAct.secondary.label)}</a>` : ''}
          <button type="button" class="dFavBtn${saved ? ' active' : ''}" id="detailFavBtn" aria-pressed="${saved}">${saved ? '★ 已加入书篓' : '☆ 加入书篓'}</button>
          <button type="button" class="dBlockBtn${isSingleBookBlocked ? ' active' : ''}" id="detailBlockBtn" aria-pressed="${isSingleBookBlocked}" title="仅屏蔽此单书，不影响同名作者其他作品">${isSingleBookBlocked ? '已屏蔽此书' : '屏蔽此书'}</button>
        </div>
        ${saved && shelfItem ? `<div class="dShelfControls">
          <div class="shelfStateSeg" role="group" aria-label="书篓阅读状态">
            ${[['want', '想看'], ['reading', '在读'], ['done', '已看']].map(([k, lbl]) =>
              `<button type="button" class="ssBtn${shelfItem.state === k ? ' active' : ''}" data-detail-state="${k}" aria-pressed="${shelfItem.state === k}">${lbl}</button>`
            ).join('')}
          </div>
          <button type="button" class="shelfFattenBtn${shelfItem.fatten ? ' active' : ''}" id="detailFattenBtn" aria-pressed="${Boolean(shelfItem.fatten)}">${shelfItem.fatten ? '🌱 养肥中' : '养肥'}</button>
          ${shelfItem.fatten && fattenEval?.alerts?.length ? fattenEval.alerts.map((a) => `<span class="fAlertPill ${esc(a.tone)}">${esc(a.label)}</span>`).join('') : ''}
        </div>` : ''}
        ${blockMatch?.blocked && !isSingleBookBlocked ? `<div class="dBlockNotice">当前作品命中你的屏蔽规则：<strong>${esc(blockMatch.label)}</strong></div>` : ''}
        <div class="dToast" id="detailToast" role="status"${toastMsg ? '' : ' hidden'}>${esc(toastMsg)}</div>
      </section>

      <section class="dCard dStatsCard" aria-label="在读表现与走势">
        <div class="dStatStrip">
          <div class="dStatItem">
            <small>当前在读 · 番茄实测</small>
            <b>${esc(fmtReaders(readersVal))}</b>
            <div class="dStatDeltas">
              ${Number.isFinite(m1.d) ? `<span class="deltaPill ${deltaClass(m1.d)}">${esc(dayLabel(trendsPayload?.latestDate))} ${esc(shortDelta(m1.d))}${Number.isFinite(m1.p) ? ' (' + esc(formatPct(m1.p)) + ')' : ''}</span>` : ''}
              ${Number.isFinite(m7.d) ? `<span class="deltaPill ${deltaClass(m7.d)}">近7天 ${esc(shortDelta(m7.d))}${Number.isFinite(m7.p) ? ' (' + esc(formatPct(m7.p)) + ')' : ''}</span>` : ''}
            </div>
          </div>
          <div class="dStatItem">
            <small>官方评分 · 番茄实测</small>
            <b>${scoreVal !== null ? `★ ${scoreVal.toFixed(1)}` : '暂无评分'}</b>
            <span class="dStatNote">${scoreCntStr ? esc(scoreCntStr) : '官方评分待补充'}</span>
          </div>
        </div>
        <div class="dTrendWrap" id="detailTrendWrap">${trendPanelHtml}</div>
        <div class="dWordBarWrap" id="detailWordBarWrap">${wordBarHtml}</div>
        ${dailyDetailsHtml}
      </section>
    </div>

    <aside class="dSideCol">
      ${(badgeHtml || milestoneHtml) ? `<section class="dCard dSideCard" aria-label="上榜履历与里程碑">
        <div class="dSecHead"><h2>上榜履历与里程碑</h2><span class="dSrcNote">本站观测期</span></div>
        ${badgeHtml}
        ${milestoneHtml}
      </section>` : ''}

      <section class="dCard dSideCard" id="detailSimilar" aria-label="相近作品推荐">
        <div class="dSecHead"><h2>相近作品</h2><span class="dSrcNote">基于标签与分类</span></div>
        ${similarBodyHtml}
      </section>

      <section class="dCard dSideCard" id="detailAuthor" aria-label="同署名作品">
        <div class="dSecHead"><h2>同署名作品</h2><span class="dSrcNote">可能含同名作者</span></div>
        ${authorBodyHtml}
      </section>
    </aside>
  </div>`;
}
