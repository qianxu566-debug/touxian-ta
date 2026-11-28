import { compressed, fetchCached, dayString } from './reader.js?v=26';

const nf = new Intl.NumberFormat('zh-CN');

export function loadTrends(opts = {}) {
  const fallback = {
    latestDate: null,
    prevDate: null,
    dates: [],
    stats: {},
    books: {},
  };
  const p = fetchCached('./data/trends.json.gz', {
    gz: true,
    timeoutMs: opts.timeoutMs ?? 15000,
    retries: opts.retries ?? 2,
    ver: opts.ver || '',
    forceNetwork: Boolean(opts.forceNetwork),
  }).then((r) => r.data);
  return opts.strict ? p : p.catch(() => fallback);
}

export function loadRadar(opts = {}) {
  const fallback = {
    rankDates: [],
    latestRankDate: null,
    top30BaseDate: '',
    top100BaseDate: '',
    catalogBaseDate: '',
    cats: [],
    sweep: {},
    debut: {},
    badges: {},
    extraBooks: {},
  };
  const p = fetchCached('./data/radar.json.gz', {
    gz: true,
    timeoutMs: opts.timeoutMs ?? 15000,
    retries: opts.retries ?? 2,
    ver: opts.ver || '',
    forceNetwork: Boolean(opts.forceNetwork),
  }).then((r) => r.data);
  return opts.strict ? p : p.catch(() => fallback);
}

export function getTrend(trends, id) {
  const row = trends?.books?.[String(id)];
  if (!Array.isArray(row)) return null;
  return {
    readers: row[0],
    d1: row[1],
    p1: row[2],
    d7: row[3],
    p7: row[4],
    d30: row[5],
    p30: row[6],
    dw1: row[7],
    series: Array.isArray(row[8]) ? row[8] : [],
  };
}

export function shortDelta(delta) {
  if (!Number.isFinite(delta)) return '';
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const abs = Math.abs(delta);
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
  return `${sign}${nf.format(abs)}`;
}

export function deltaClass(delta) {
  if (!Number.isFinite(delta) || delta === 0) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

export function formatPct(pct) {
  if (!Number.isFinite(pct)) return '';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(Math.abs(pct) >= 10 ? 1 : 2)}%`;
}

export function dayLabel(latestDate) {
  if (!latestDate) return '较昨日';
  return latestDate === dayString() ? '较昨日' : `${latestDate.slice(5)} 较前日`;
}

export function formatWordStatus(book, trend, nowSec = Math.floor(Date.now() / 1000)) {
  if (book?.status === '连载中' && Number.isFinite(book.lastUpdate)) {
    const idleDays = Math.floor((nowSec - book.lastUpdate) / 86400);
    if (idleDays > 7) {
      return `<span class="wordDiff stale" title="距离最新章节发布已超过 ${idleDays} 天">停更 ${idleDays} 天</span>`;
    }
  }
  if (trend && Number.isFinite(trend.dw1)) {
    if (trend.dw1 > 0) return `<span class="wordDiff">日更 +${nf.format(trend.dw1)} 字</span>`;
    if (trend.dw1 === 0 && book?.status === '连载中') return '<span class="wordDiff idle">昨日未更</span>';
  }
  return '';
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function popcount(n) {
  let c = 0;
  let x = n >>> 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

const TREND_LABELS = {
  rising: '一路在涨',
  rebound: '回升中',
  flat: '走平',
  falling: '回落中',
};

export function trendStateLabel(code) {
  return TREND_LABELS[code] || '';
}

export function classifyTrend(t) {
  const series = t?.series;
  if (!Array.isArray(series) || series.length < 2) return '';
  const pts = series.slice(-8).map((p) => p[1]);
  const net = pts[pts.length - 1] - pts[0];
  const lastStep = pts[pts.length - 1] - pts[pts.length - 2];
  const netPct = net / Math.max(pts[0], 1);
  const stepPct = lastStep / Math.max(pts[pts.length - 2], 1);
  if (Math.abs(netPct) < 0.01 && Math.abs(stepPct) < 0.008) return 'flat';
  let monotonicish = true;
  for (let k = 1; k < pts.length; k++) {
    if (pts[k] < pts[k - 1] * 0.993) {
      monotonicish = false;
      break;
    }
  }
  if (net > 0 && lastStep >= 0 && monotonicish) return 'rising';
  const minBeforeLast = Math.min(...pts.slice(0, -1));
  if (lastStep > 0 && (minBeforeLast < pts[0] * 0.992 || net <= 0)) return 'rebound';
  if (lastStep < 0 || net < 0) return 'falling';
  return 'rising';
}

export function evaluateSweepBook(radar, id, opts = {}) {
  const row = radar?.sweep?.[String(id)];
  const dates = radar?.rankDates || [];
  if (!Array.isArray(row) || !dates.length) return null;

  const [lanes, new30Date, new100Date, g1, g7, g30, trendState] = row;
  const winDays = Number(opts.winDays || 7);
  const depth = Number(opts.depth || 100);
  const scope = opts.scope || 'all';
  const rankKind = opts.rankKind || 'all';
  const channel = opts.channel || '';
  const category = opts.category || '';

  const latestRankDate = radar.latestRankDate || dates[dates.length - 1];
  const cutoff = shiftDate(latestRankDate, -(winDays - 1));
  let winMask = 0;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] >= cutoff) winMask |= 1 << i;
  }
  const latestBit = 1 << (dates.length - 1);

  const isNew = depth === 30
    ? Boolean(new30Date && new30Date >= cutoff)
    : Boolean(new100Date && new100Date >= cutoff);
  if (scope === 'new' && !isNew) return null;

  let unionMask = 0;
  let bestPos = 999;
  let primaryLane = null;

  for (const lane of lanes) {
    const [mold, cidx, mask30, mask100, best30, best100, latestPos] = lane;
    if (rankKind === 'reading' && mold !== 2) continue;
    if (rankKind === 'new' && mold !== 1) continue;
    if (rankKind === 'board' && mold < 3) continue;

    const cat = radar.cats?.[cidx] || ['', ''];
    const [gender, catName] = cat;
    if (channel && gender) {
      const catCh = gender === '1' ? '男频' : '女频';
      if (catCh !== channel) continue;
    }
    if (category && catName !== category) continue;

    const m = (depth === 30 ? mask30 : mask100) & winMask;
    if (!m) continue;

    unionMask |= m;
    const laneBest = winDays === 1
      ? latestPos
      : (depth === 30 ? best30 : best100);
    const effectiveBest = Number.isFinite(laneBest) && laneBest < 999 ? laneBest : best100;
    if (!primaryLane || effectiveBest < bestPos) {
      bestPos = effectiveBest;
      primaryLane = { mold, catName };
    }
  }

  if (!unionMask || !primaryLane) return null;

  const daysOnRank = popcount(unionMask);
  const onRankToday = (unionMask & latestBit) !== 0;
  const moldText = primaryLane.mold === 2 ? '阅读榜' : primaryLane.mold === 1 ? '新书榜' : '';
  const gain = winDays === 1 ? g1 : winDays === 30 ? (g30 ?? g7 ?? g1) : (g7 ?? g1);

  return {
    matched: true,
    daysOnRank,
    bestPos,
    onRankToday,
    isNew,
    laneLabel: `${primaryLane.catName}${moldText}`,
    gain,
    trendState: trendState || '',
  };
}

export function evaluateDebutBook(radar, id, opts = {}) {
  const row = radar?.debut?.[String(id)];
  if (!Array.isArray(row)) return null;
  const [debutDate, kindOrArr, label, dayNum, periodGain, dailyAvg, bestPos] = row;
  const kinds = Array.isArray(kindOrArr) ? kindOrArr : [kindOrArr];

  if (opts.kind && opts.kind !== 'all') {
    const targetKind = opts.kind === 'library' ? 'broke10k' : opts.kind;
    if (!kinds.includes(targetKind)) return null;
  }
  if (opts.day && debutDate !== opts.day) return null;

  const winDays = Number(opts.winDays || 7);
  const refDate = radar.latestRankDate || radar.rankDates?.[radar.rankDates.length - 1];
  if (!opts.day && refDate && winDays > 0) {
    const cutoff = shiftDate(refDate, -(winDays - 1));
    if (debutDate < cutoff) return null;
  }

  return {
    matched: true,
    debutDate,
    kinds,
    label,
    dayNum,
    periodGain,
    dailyAvg,
    bestPos,
  };
}

const BADGE_NAMES = {
  2: '阅读榜',
  1: '新书榜',
  3: '巅峰榜',
  4: '黑马榜',
  5: '热搜榜',
  6: '推荐榜',
};

export function renderRankBadges(radar, id, fallbackList = null) {
  const list = radar?.badges?.[String(id)] || fallbackList;
  if (!Array.isArray(list) || !list.length) return '';
  const items = list
    .map(([grp, totalDays, firstMMDD, exactStart, bestPos, top1Days, top10Days, onToday, dropMMDD]) => {
      const name = BADGE_NAMES[grp] || `榜单${grp}`;
      const pillCls = onToday ? (grp === 2 ? 'rhPill active read' : 'rhPill active') : 'rhPill dropped';
      const parts = [];
      if (exactStart && firstMMDD) parts.push(`${firstMMDD}上榜`);
      if (Number.isFinite(bestPos) && bestPos < 999) parts.push(`最高第${bestPos}名`);
      if (bestPos === 1 && top1Days > 0) parts.push(`榜首${top1Days}天`);
      else if (bestPos <= 10 && top10Days > 0) parts.push(`前10共${top10Days}天`);
      if (!onToday && dropMMDD) parts.push(`${dropMMDD}掉榜`);
      return `<span class="rhItem"><b class="${pillCls}">${name} ${totalDays}天</b><em>${parts.join(' · ')}</em></span>`;
    })
    .join('');
  return `<div class="rankHistory" aria-label="榜单履历">${items}</div>`;
}

function escAttr(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtReadersDetail(v) {
  if (!Number.isFinite(v)) return '暂无';
  if (v >= 10000) return `${(v / 10000).toFixed(2).replace(/\.?0+$/, '')} 万`;
  return `${nf.format(v)} 人`;
}

function fmtAxisVal(v, spanV) {
  if (!Number.isFinite(v)) return '';
  if (v >= 10000) {
    if (spanV < 1000) return nf.format(v);
    if (spanV < 20000) return `${(v / 10000).toFixed(2).replace(/\.?0+$/, '')}万`;
    return `${(v / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  }
  return nf.format(v);
}

function fmtDayDelta(delta, pctVal, hasPrev) {
  if (!hasPrev || !Number.isFinite(delta)) {
    return { text: '首次实测', cls: 'flat' };
  }
  const cls = deltaClass(delta);
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
  const numStr = delta === 0 ? '0' : `${sign}${nf.format(Math.abs(delta))}`;
  const pctStr = Number.isFinite(pctVal) ? ` (${formatPct(pctVal)})` : '';
  return { text: `较前日 ${numStr}${pctStr}`, cls };
}

function buildInteractiveChart(series, dates, rangeDays = 7, bookId = '') {
  if (!Array.isArray(series) || series.length < 2) {
    return '<div class="trendEmpty">已记录 ' + (series?.length || 0) + ' 天数据，满 2 天自动绘制交互走势图。</div>';
  }
  const lastIdx = series[series.length - 1][0];
  let pts;
  if (rangeDays === 1) {
    pts = series.slice(-2);
  } else if (rangeDays === 7) {
    if (dates[lastIdx]) {
      const cutoff = shiftDate(dates[lastIdx], -6);
      pts = series.filter((p) => dates[p[0]] && dates[p[0]] >= cutoff);
    } else {
      pts = series.filter((p) => p[0] >= lastIdx - 6);
    }
  } else {
    pts = series.slice(-30);
  }
  if (pts.length < 2) {
    return '<div class="trendEmpty">该时间窗暂仅 1 次实测记录，次日更新后即可绘制折线。</div>';
  }

  const startPos = series.indexOf(pts[0]);
  const vals = pts.map((p) => p[1]);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const spanV = maxV - minV;
  const minX = pts[0][0];
  const maxX = pts[pts.length - 1][0];
  const spanX = maxX - minX || 1;
  const padX = 2.6;

  const pointObjs = pts.map(([idx, val], i) => {
    const prevPt = i > 0 ? pts[i - 1] : (startPos > 0 ? series[startPos - 1] : null);
    const dPrev = prevPt ? val - prevPt[1] : null;
    const pPrev = prevPt && prevPt[1] > 0 ? (100 * dPrev) / prevPt[1] : null;
    const { text: deltaText, cls: deltaCls } = fmtDayDelta(dPrev, pPrev, Boolean(prevPt));
    const dateFull = dates[idx] || '';
    const date = dateFull ? dateFull.slice(5) : `#${i + 1}`;
    const xPct = pts.length === 1 ? 50 : padX + ((idx - minX) / spanX) * (100 - 2 * padX);
    const ySvg = spanV === 0 ? 100 : 182 - ((val - minV) / spanV) * 164;
    const yPct = (ySvg / 200) * 100;
    return {
      i,
      date,
      dateFull: dateFull || date,
      val,
      valText: fmtReadersDetail(val),
      hasPrev: Boolean(prevPt),
      deltaText,
      deltaCls,
      xPct: Number(xPct.toFixed(2)),
      yPct: Number(yPct.toFixed(2)),
      ySvg: Number(ySvg.toFixed(1)),
    };
  });

  const last = pointObjs[pointObjs.length - 1];
  const coords = pointObjs.map((p) => `${(p.xPct * 10).toFixed(1)},${p.ySvg}`);
  const area = `${(pointObjs[0].xPct * 10).toFixed(1)},196 ${coords.join(' ')} ${(last.xPct * 10).toFixed(1)},196`;
  const gradId = `tcg-${String(bookId || 'x').replace(/[^a-zA-Z0-9_-]/g, '')}-${rangeDays}`;

  const yTicks = spanV === 0
    ? ['', fmtAxisVal(maxV, 0), '']
    : [fmtAxisVal(maxV, spanV), fmtAxisVal(Math.round((maxV + minV) / 2), spanV), fmtAxisVal(minV, spanV)];

  const peakPt = pointObjs.find((p) => p.val === maxV);
  const troughPt = pointObjs.find((p) => p.val === minV);
  const showDotIdx = new Set();
  if (pointObjs.length <= 12) {
    pointObjs.forEach((p) => showDotIdx.add(p.i));
  } else {
    showDotIdx.add(0);
    showDotIdx.add(last.i);
    if (peakPt) showDotIdx.add(peakPt.i);
    if (troughPt) showDotIdx.add(troughPt.i);
  }

  const dotsHtml = pointObjs
    .filter((p) => showDotIdx.has(p.i))
    .map((p) => `<span class="tcDot${p.i === last.i ? ' active' : ''}" data-pt-idx="${p.i}" style="left:${p.xPct}%;top:${p.yPct}%"></span>`)
    .join('');

  let extremesHtml = '';
  if (pointObjs.length >= 3 && spanV > 0) {
    const edgeCls = (x) => (x < 14 ? ' edgeL' : x > 86 ? ' edgeR' : '');
    if (peakPt) {
      extremesHtml += `<span class="tcExtreme max${edgeCls(peakPt.xPct)}" data-pt-idx="${peakPt.i}" style="left:${peakPt.xPct}%;top:${peakPt.yPct}%"${peakPt.i === last.i ? ' hidden' : ''}>高 ${fmtAxisVal(peakPt.val, spanV)}</span>`;
    }
    if (troughPt && troughPt.i !== peakPt?.i) {
      extremesHtml += `<span class="tcExtreme min${edgeCls(troughPt.xPct)}" data-pt-idx="${troughPt.i}" style="left:${troughPt.xPct}%;top:${troughPt.yPct}%"${troughPt.i === last.i ? ' hidden' : ''}>低 ${fmtAxisVal(troughPt.val, spanV)}</span>`;
    }
  }

  const xIndices = pointObjs.length <= 7
    ? pointObjs.map((p) => p.i)
    : [...new Set([0, Math.round((pointObjs.length - 1) * 0.25), Math.round((pointObjs.length - 1) * 0.5), Math.round((pointObjs.length - 1) * 0.75), pointObjs.length - 1])];
  const xAxisHtml = xIndices
    .map((idx, pos) => {
      const p = pointObjs[idx];
      const edgeCls = pos === 0 ? ' edgeL' : pos === xIndices.length - 1 ? ' edgeR' : '';
      return `<span class="tcXTick${edgeCls}" style="left:${p.xPct}%">${p.date}</span>`;
    })
    .join('');

  const compactPts = pointObjs.map(({ i, date, valText, deltaText, deltaCls, xPct, yPct }) => ({
    i,
    date,
    valText,
    deltaText,
    deltaCls,
    xPct,
    yPct,
  }));

  const winLabel = rangeDays === 1 ? '单日对比' : `近 ${rangeDays} 天 · 实测 ${pointObjs.length} 天`;

  return (
    `<div class="trendChart" data-pts="${escAttr(JSON.stringify(compactPts))}">` +
    `<div class="tcReadout" aria-live="polite">` +
    `<div class="tcReadMain"><span class="tcDate">${last.date}</span><span class="tcSep">·</span><b class="tcVal">在读 ${last.valText}</b><span class="tcSep">·</span><span class="tcDelta ${last.deltaCls}">${last.deltaText}</span></div>` +
    `<div class="tcReadMeta"><span class="tcWinTag">${winLabel}</span><span class="tcHint">滑动/点击节点</span></div>` +
    `</div>` +
    `<div class="tcStage">` +
    `<div class="tcYAxis" aria-hidden="true"><span>${yTicks[0]}</span><span>${yTicks[1]}</span><span>${yTicks[2]}</span></div>` +
    `<div class="tcCanvas" tabindex="0" role="slider" aria-label="在读人数走势折线图，左右键或滑动切换日期" aria-valuemin="0" aria-valuemax="${last.i}" aria-valuenow="${last.i}" aria-valuetext="${escAttr(`${last.date} 在读 ${last.valText} ${last.deltaText}`)}">` +
    `<svg class="tcSvg" viewBox="0 0 1000 200" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--chart-line)" stop-opacity="0.30"/><stop offset="100%" stop-color="var(--chart-line)" stop-opacity="0.01"/></linearGradient></defs>` +
    `<line x1="0" y1="18" x2="1000" y2="18" stroke="var(--line-2)" stroke-dasharray="4 6" vector-effect="non-scaling-stroke"/>` +
    `<line x1="0" y1="100" x2="1000" y2="100" stroke="var(--line-1)" stroke-dasharray="4 6" vector-effect="non-scaling-stroke"/>` +
    `<line x1="0" y1="182" x2="1000" y2="182" stroke="var(--line-2)" stroke-dasharray="4 6" vector-effect="non-scaling-stroke"/>` +
    `<polygon points="${area}" fill="url(#${gradId})"/>` +
    `<polyline points="${coords.join(' ')}" fill="none" stroke="var(--chart-line)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `</svg>` +
    `<div class="tcOverlay" aria-hidden="true">` +
    `<div class="tcGuide" style="left:${last.xPct}%"></div>` +
    dotsHtml +
    extremesHtml +
    `<span class="tcActiveDot" style="left:${last.xPct}%;top:${last.yPct}%"></span>` +
    `</div>` +
    `</div>` +
    `</div>` +
    `<div class="tcXAxis" aria-hidden="true">${xAxisHtml}</div>` +
    `</div>`
  );
}

export function windowMetric(t, rangeDays, dates = null, { requireLatest = false } = {}) {
  if (!t) return { d: null, p: null, base: null, cur: null, spanDays: 0, note: '' };
  if (rangeDays === 1) {
    const cur = Number.isFinite(t.readers) ? t.readers : null;
    const base = cur !== null && Number.isFinite(t.d1) ? cur - t.d1 : null;
    return { d: t.d1, p: t.p1, base, cur, spanDays: 1, note: '' };
  }
  if (rangeDays === 7 && Number.isFinite(t.d7)) {
    const cur = Number.isFinite(t.readers) ? t.readers : null;
    const base = cur !== null ? cur - t.d7 : null;
    return { d: t.d7, p: t.p7, base, cur, spanDays: 7, note: '' };
  }
  if (rangeDays === 30 && Number.isFinite(t.d30)) {
    const cur = Number.isFinite(t.readers) ? t.readers : null;
    const base = cur !== null ? cur - t.d30 : null;
    return { d: t.d30, p: t.p30, base, cur, spanDays: 30, note: '' };
  }
  const s = t.series || [];
  if (s.length < 2) return { d: null, p: null, base: null, cur: null, spanDays: 0, note: '' };
  const lastPt = s[s.length - 1];
  const hasDates = Array.isArray(dates) && dates.length > 0;
  if (requireLatest && hasDates && lastPt[0] !== dates.length - 1) {
    return { d: null, p: null, base: null, cur: null, spanDays: 0, note: '' };
  }
  let sub;
  if (hasDates && dates[lastPt[0]]) {
    const cutoff = shiftDate(dates[lastPt[0]], -rangeDays);
    sub = s.filter((p) => dates[p[0]] && dates[p[0]] >= cutoff);
  } else {
    sub = s.filter((p) => p[0] >= lastPt[0] - rangeDays);
  }
  if (sub.length < 2) return { d: null, p: null, base: null, cur: null, spanDays: 0, note: '' };
  const base = sub[0][1];
  const cur = sub[sub.length - 1][1];
  const delta = cur - base;
  const pctVal = base > 0 ? (100 * delta) / base : null;
  let spanDays;
  if (hasDates && dates[sub[0][0]] && dates[sub[sub.length - 1][0]]) {
    spanDays = Math.max(
      1,
      Math.round(
        (Date.parse(`${dates[sub[sub.length - 1][0]]}T00:00:00Z`) -
          Date.parse(`${dates[sub[0][0]]}T00:00:00Z`)) /
          86400000
      )
    );
  } else {
    spanDays = Math.max(1, sub[sub.length - 1][0] - sub[0][0]);
  }
  return { d: delta, p: pctVal, base, cur, spanDays, note: spanDays < rangeDays ? `（近${spanDays}天）` : '' };
}

export function renderTrendPanel(trends, id, rangeDays = 7) {
  const t = getTrend(trends, id);
  if (!t) {
    return '<div class="trendEmpty">正在积累该书的每日实测数据，次日采集完成后即可查看变化趋势。</div>';
  }
  const activeRange = [1, 7, 30].includes(Number(rangeDays)) ? Number(rangeDays) : 7;
  const cols = [
    { range: 1, label: dayLabel(trends.latestDate), ...windowMetric(t, 1, trends.dates) },
    { range: 7, label: '近 7 天', ...windowMetric(t, 7, trends.dates) },
    { range: 30, label: '近 30 天', ...windowMetric(t, 30, trends.dates) },
  ];
  const cells = cols
    .map((c) => {
      const isAct = c.range === activeRange;
      const head = c.label;
      const tip = c.note ? `${c.label}${c.note}` : c.label;
      if (!Number.isFinite(c.d)) {
        return `<button type="button" class="tmCell${isAct ? ' active' : ''}" data-range="${c.range}" aria-pressed="${isAct}" title="${tip}"><small>${head}</small><b class="flat">积累中</b><em>点击切图</em></button>`;
      }
      const cls = deltaClass(c.d);
      return `<button type="button" class="tmCell${isAct ? ' active' : ''}" data-range="${c.range}" aria-pressed="${isAct}" title="${tip}"><small>${head}</small><b class="${cls}">${shortDelta(c.d)}</b><em class="${cls}">${formatPct(c.p) || '—'}</em></button>`;
    })
    .join('');

  return `<div class="trendMetrics" role="tablist" aria-label="切换走势时间范围">${cells}</div>${buildInteractiveChart(t.series, trends.dates || [], activeRange, id)}`;
}

export function bindTrendChart(container) {
  const root = container?.querySelector?.('.trendChart[data-pts]');
  if (!root || root.dataset.bound === '1') return;
  let pts;
  try {
    pts = JSON.parse(root.dataset.pts || '[]');
  } catch {
    return;
  }
  if (!Array.isArray(pts) || !pts.length) return;
  root.dataset.bound = '1';

  const canvas = root.querySelector('.tcCanvas');
  const dateEl = root.querySelector('.tcDate');
  const valEl = root.querySelector('.tcVal');
  const deltaEl = root.querySelector('.tcDelta');
  const guideEl = root.querySelector('.tcGuide');
  const activeDotEl = root.querySelector('.tcActiveDot');
  const dotEls = [...root.querySelectorAll('.tcDot[data-pt-idx]')];
  const extremeEls = [...root.querySelectorAll('.tcExtreme[data-pt-idx]')];

  let activeIdx = pts.length - 1;
  let pinned = false;
  let scrubbing = false;
  let downX = 0;
  let downY = 0;

  const setActive = (idx) => {
    const safeIdx = Math.max(0, Math.min(pts.length - 1, idx));
    const p = pts[safeIdx];
    if (!p) return;
    activeIdx = safeIdx;
    if (dateEl) dateEl.textContent = p.date;
    if (valEl) valEl.textContent = `在读 ${p.valText}`;
    if (deltaEl) {
      deltaEl.textContent = p.deltaText;
      deltaEl.className = `tcDelta ${p.deltaCls}`;
    }
    if (guideEl) guideEl.style.left = `${p.xPct}%`;
    if (activeDotEl) {
      activeDotEl.style.left = `${p.xPct}%`;
      activeDotEl.style.top = `${p.yPct}%`;
    }
    for (const d of dotEls) d.classList.toggle('active', Number(d.dataset.ptIdx) === safeIdx);
    for (const ex of extremeEls) ex.hidden = Number(ex.dataset.ptIdx) === safeIdx;
    if (canvas) {
      canvas.setAttribute('aria-valuenow', String(safeIdx));
      canvas.setAttribute('aria-valuetext', `${p.date} 在读 ${p.valText} ${p.deltaText}`);
    }
  };

  const pickByClientX = (clientX) => {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const relPct = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < pts.length; k++) {
      const dist = Math.abs(pts[k].xPct - relPct);
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    setActive(best);
  };

  if (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
      scrubbing = true;
      if (e.pointerType === 'mouse') pinned = true;
      pickByClientX(e.clientX);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') {
        pickByClientX(e.clientX);
        return;
      }
      if (!scrubbing) return;
      const dx = Math.abs(e.clientX - downX);
      const dy = Math.abs(e.clientY - downY);
      if (dx >= dy * 0.7 || dx > 6) {
        pickByClientX(e.clientX);
      }
    });
    const endScrub = () => { scrubbing = false; };
    canvas.addEventListener('pointerup', endScrub);
    canvas.addEventListener('pointercancel', endScrub);
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !pinned) setActive(pts.length - 1);
    });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        pinned = true;
        setActive(activeIdx - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        pinned = true;
        setActive(activeIdx + 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        pinned = true;
        setActive(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        pinned = true;
        setActive(pts.length - 1);
      }
    });
  }
}
