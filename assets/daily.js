import { compressed, dayString } from './reader.js';

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
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2).replace(/\.?0+$/, '')} 万`;
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
  const [debutDate, kind, label, dayNum, periodGain, dailyAvg, bestPos] = row;

  if (opts.kind && opts.kind !== 'all' && kind !== opts.kind) return null;
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
    kind,
    label,
    dayNum,
    periodGain,
    dailyAvg,
    bestPos,
  };
}

function buildSparkline(series, dates) {
  if (!Array.isArray(series) || series.length < 2) {
    return '<div class="trendEmpty">已记录 ' + (series?.length || 0) + ' 天数据，满 2 天自动绘制走势折线图。</div>';
  }
  const w = 280;
  const h = 56;
  const padX = 4;
  const padY = 6;
  const vals = series.map((p) => p[1]);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const spanV = maxV - minV || 1;
  const minX = series[0][0];
  const maxX = series[series.length - 1][0];
  const spanX = maxX - minX || 1;

  const coords = series.map(([idx, val]) => {
    const x = padX + ((idx - minX) / spanX) * (w - 2 * padX);
    const y = h - padY - ((val - minV) / spanV) * (h - 2 * padY);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const firstDate = dates[minX]?.slice(5) || '';
  const lastDate = dates[maxX]?.slice(5) || '';
  const fmt = (v) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : nf.format(v));
  const area = `${coords[0].split(',')[0]},${h - padY} ${coords.join(' ')} ${coords[coords.length - 1].split(',')[0]},${h - padY}`;

  return (
    `<div class="trendChart">` +
    `<div class="chartHead"><span>在读走势（${series.length} 天实测）</span><span>${fmt(minV)} ～ ${fmt(maxV)}</span></div>` +
    `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="在读人数走势折线图">` +
    `<line x1="0" y1="${padY}" x2="${w}" y2="${padY}" stroke="#2f444c" stroke-dasharray="2 4"/>` +
    `<line x1="0" y1="${h - padY}" x2="${w}" y2="${h - padY}" stroke="#2f444c" stroke-dasharray="2 4"/>` +
    `<polygon points="${area}" fill="rgba(151,232,214,0.12)"/>` +
    `<polyline points="${coords.join(' ')}" fill="none" stroke="#97e8d6" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
    `</svg>` +
    `<div class="chartAxis"><span>${firstDate}</span><span>${lastDate}</span></div>` +
    `</div>`
  );
}

export function renderTrendPanel(trends, id) {
  const t = getTrend(trends, id);
  if (!t) {
    return '<div class="trendEmpty">正在积累该书的每日实测数据，次日采集完成后即可查看变化趋势。</div>';
  }
  const cols = [
    { label: dayLabel(trends.latestDate), d: t.d1, p: t.p1 },
    { label: '近 7 天', d: t.d7, p: t.p7 },
    { label: '近 30 天', d: t.d30, p: t.p30 },
  ];
  const cells = cols
    .map((c) => {
      if (!Number.isFinite(c.d)) {
        return `<div class="tmCell"><small>${c.label}</small><b class="flat">积累中</b><em>—</em></div>`;
      }
      const cls = deltaClass(c.d);
      return `<div class="tmCell"><small>${c.label}</small><b class="${cls}">${shortDelta(c.d)}</b><em class="${cls}">${formatPct(c.p) || '—'}</em></div>`;
    })
    .join('');

  return `<div class="trendMetrics">${cells}</div>${buildSparkline(t.series, trends.dates || [])}`;
}
