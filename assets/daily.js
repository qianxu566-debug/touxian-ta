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
