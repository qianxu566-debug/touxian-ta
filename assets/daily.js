import { compressed, dayString } from './reader.js?v=13';

const nf = new Intl.NumberFormat('zh-CN');

export function loadTrends() {
  return compressed('./data/trends.json.gz').catch(() => ({
    latestDate: null,
    prevDate: null,
    dates: [],
    stats: {},
    books: {},
  }));
}

export function loadRadar() {
  return compressed('./data/radar.json.gz').catch(() => ({
    rankDates: [],
    latestRankDate: null,
    top30BaseDate: '',
    top100BaseDate: '',
    catalogBaseDate: '',
    cats: [],
    sweep: {},
    debut: {},
    extraBooks: {},
  }));
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

function buildSparkline(series, dates, rangeDays = 1) {
  if (!Array.isArray(series) || series.length < 2) {
    return '<div class="trendEmpty">已记录 ' + (series?.length || 0) + ' 天数据，满 2 天自动绘制对比折线图。</div>';
  }
  const maxIdx = series[series.length - 1][0];
  let pts;
  if (rangeDays === 1) {
    pts = series.slice(-2);
  } else if (rangeDays === 7) {
    pts = series.filter((p) => p[0] >= maxIdx - 6);
  } else {
    pts = series.slice(-30);
  }
  if (pts.length < 2) {
    return '<div class="trendEmpty">该时间窗暂仅 1 次实测记录，次日更新后即可绘制折线。</div>';
  }

  const w = 280;
  const h = 62;
  const padX = 8;
  const padY = 8;
  const vals = pts.map((p) => p[1]);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const spanV = maxV - minV || 1;
  const minX = pts[0][0];
  const maxX = pts[pts.length - 1][0];
  const spanX = maxX - minX || 1;

  const xy = pts.map(([idx, val]) => [
    padX + ((idx - minX) / spanX) * (w - 2 * padX),
    h - padY - ((val - minV) / spanV) * (h - 2 * padY),
  ]);
  const coords = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`);

  const firstDate = dates[minX]?.slice(5) || '';
  const lastDate = dates[maxX]?.slice(5) || '';
  const fmt = (v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : nf.format(v));
  const netUp = vals[vals.length - 1] >= vals[0];
  const stroke = netUp ? '#88d6a3' : '#eb9a92';
  const fill = netUp ? 'rgba(136,214,163,0.14)' : 'rgba(235,154,146,0.14)';
  const area = `${xy[0][0].toFixed(1)},${h - padY} ${coords.join(' ')} ${xy[xy.length - 1][0].toFixed(1)},${h - padY}`;
  const dots = pts.length <= 10
    ? xy.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${stroke}"/>`).join('')
    : '';

  const headLeft = rangeDays === 1
    ? `单日变化（${firstDate} → ${lastDate}）`
    : `近 ${rangeDays} 天走势（实测 ${pts.length} 天）`;
  const headRight = rangeDays === 1
    ? `${fmt(vals[0])} → ${fmt(vals[vals.length - 1])}`
    : `${fmt(minV)} ～ ${fmt(maxV)}`;

  return (
    `<div class="trendChart">` +
    `<div class="chartHead"><span>${headLeft}</span><span>${headRight}</span></div>` +
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="在读人数走势折线图">` +
    `<line x1="0" y1="${padY}" x2="${w}" y2="${padY}" stroke="rgba(195,228,232,0.12)" stroke-dasharray="2 4"/>` +
    `<line x1="0" y1="${h - padY}" x2="${w}" y2="${h - padY}" stroke="rgba(195,228,232,0.12)" stroke-dasharray="2 4"/>` +
    `<polygon points="${area}" fill="${fill}"/>` +
    `<polyline points="${coords.join(' ')}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    dots +
    `</svg>` +
    `<div class="chartAxis"><span>${firstDate}</span><span>${lastDate}</span></div>` +
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

export function renderTrendPanel(trends, id, rangeDays = 1) {
  const t = getTrend(trends, id);
  if (!t) {
    return '<div class="trendEmpty">正在积累该书的每日实测数据，次日采集完成后即可查看变化趋势。</div>';
  }
  const activeRange = [1, 7, 30].includes(Number(rangeDays)) ? Number(rangeDays) : 1;
  const cols = [
    { range: 1, label: dayLabel(trends.latestDate), ...windowMetric(t, 1, trends.dates) },
    { range: 7, label: '近 7 天', ...windowMetric(t, 7, trends.dates) },
    { range: 30, label: '近 30 天', ...windowMetric(t, 30, trends.dates) },
  ];
  const cells = cols
    .map((c) => {
      const isAct = c.range === activeRange;
      const head = `${c.label}${c.note}`;
      if (!Number.isFinite(c.d)) {
        return `<button type="button" class="tmCell${isAct ? ' active' : ''}" data-range="${c.range}" aria-pressed="${isAct}"><small>${head}</small><b class="flat">积累中</b><em>点击切图</em></button>`;
      }
      const cls = deltaClass(c.d);
      return `<button type="button" class="tmCell${isAct ? ' active' : ''}" data-range="${c.range}" aria-pressed="${isAct}"><small>${head}</small><b class="${cls}">${shortDelta(c.d)}</b><em class="${cls}">${formatPct(c.p) || '—'}</em></button>`;
    })
    .join('');

  return `<div class="trendMetrics" role="tablist" aria-label="切换走势时间范围">${cells}</div>${buildSparkline(t.series, trends.dates || [], activeRange)}`;
}
