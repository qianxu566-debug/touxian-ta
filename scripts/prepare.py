"""Build the static GitHub Pages output (_site) and compile compact trends.json.gz.

Inputs:
  - catalog.gz (passed as sys.argv[2] or ./catalog.gz)
  - data/days/YYYY-MM-DD.json.gz (daily detail observations: [ts, readers, words?])
  - data/book-dates.json.gz, data/hot.json
  - history/YYYY-MM-DD.json.gz (official ranks & boards)
  - index.html, assets/*

Outputs in _site/:
  - index.html, assets/*, catalog.gz
  - data/trends.json.gz  (same-origin compact 1d/7d/30d trends + single-day word diff + 30d sparkline series)
  - data/book-dates.json.gz, data/hot.json
  - history/index.json, history/YYYY-MM-DD.json.gz
"""
import gzip
import json
import shutil
import sys
import time
import urllib.parse as urlparse
from datetime import date, timedelta
from pathlib import Path

out = Path(sys.argv[1])
catalog_src = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('catalog.gz')

out.mkdir(parents=True, exist_ok=True)
(out / 'history').mkdir(exist_ok=True)
(out / 'data').mkdir(exist_ok=True)

cwd = Path.cwd().resolve()
if out.resolve() != cwd:
    shutil.copyfile('index.html', out / 'index.html')
    shutil.copytree('assets', out / 'assets', dirs_exist_ok=True)
    if catalog_src.exists():
        shutil.copyfile(catalog_src, out / 'catalog.gz')
    for rel in ['data/book-dates.json.gz', 'data/hot.json']:
        if Path(rel).exists():
            shutil.copyfile(rel, out / rel)

# 1. Copy valid rank history files (up to 90 days)
rank_files = sorted(Path('history').glob('????-??-??.json.gz'), reverse=True)[:90]
rank_dates = []
for f in rank_files:
    try:
        with gzip.open(f, 'rt', encoding='utf-8') as fh:
            s = json.load(fh)
    except Exception:
        continue
    if not any(g.get('ok') for g in s.get('scopes', [])) and not any(
        g.get('rows') for g in s.get('boards', {}).values()
    ):
        continue
    rank_dates.append(s['date'])
    target = out / 'history' / f.name
    if target.resolve() != f.resolve():
        shutil.copyfile(f, target)
(out / 'history' / 'index.json').write_text(json.dumps(rank_dates), encoding='utf-8')

# 2. Load daily detail observations from data/days/YYYY-MM-DD.json.gz (up to last 35 days)
day_files = sorted(Path('data/days').glob('????-??-??.json.gz'))[-35:]
daily_obs = {}  # date_str -> {id: (readers, words_or_None)}
daily_targets = {}
for f in day_files:
    try:
        with gzip.open(f, 'rt', encoding='utf-8') as fh:
            d = json.load(fh)
    except Exception:
        continue
    day_str = d.get('date') or f.name[:10]
    rows = d.get('rows') or {}
    if not rows:
        continue
    parsed = {}
    for bid, arr in rows.items():
        if not isinstance(arr, list) or len(arr) < 2:
            continue
        rc = arr[1]
        if not isinstance(rc, int) or rc < 0:
            continue
        # Backward compatible: old format had arr[2]=tags(list), new format has arr[2]=words(int|None)
        wn = arr[2] if len(arr) >= 3 and isinstance(arr[2], int) and arr[2] > 0 else None
        parsed[str(bid)] = (rc, wn)
    if parsed:
        daily_obs[day_str] = parsed
        daily_targets[day_str] = d.get('targetsCount') or len(d.get('targets') or []) or len(parsed)

all_obs_dates = sorted(daily_obs.keys())

# Choose latestDate: prefer newest day unless it's severely incomplete (<35% of previous day)
latest_date = None
if all_obs_dates:
    newest = all_obs_dates[-1]
    if len(all_obs_dates) >= 2:
        prev_day = all_obs_dates[-2]
        if len(daily_obs[newest]) < len(daily_obs[prev_day]) * 0.35:
            latest_date = prev_day
        else:
            latest_date = newest
    else:
        latest_date = newest

# Build exact calendar lookup relative to latest_date
series_dates = [d for d in all_obs_dates if not latest_date or d <= latest_date][-30:]
date_to_idx = {d: i for i, d in enumerate(series_dates)}

catalog_ids = set()
valid_covers = 0
total_books = 0
if catalog_src.exists():
    with gzip.open(catalog_src, 'rt', encoding='utf-8') as fh:
        cat = json.load(fh)
    now_s = time.time()
    for b in cat.get('books', []):
        total_books += 1
        bid = str(b['id'])
        catalog_ids.add(bid)
        best_exp = 0
        for k in ('longCoverUrl', 'freshCoverUrl', 'coverUrl'):
            u = b.get(k) or ''
            if u.startswith('https://'):
                qs = urlparse.parse_qs(urlparse.urlsplit(u).query)
                e = int(qs.get('x-expires', [str(int(now_s) + 86400)])[0])
                if e > best_exp:
                    best_exp = e
        if best_exp > now_s:
            valid_covers += 1

def pct(delta, base):
    if delta is None or not base:
        return None
    return round(100.0 * delta / base, 2)

trends_books = {}
paired1 = 0
paired7 = 0
paired30 = 0
words_paired1 = 0
prev_date_str = None

if latest_date:
    d_latest = date.fromisoformat(latest_date)
    d1_str = str(d_latest - timedelta(days=1))
    d7_str = str(d_latest - timedelta(days=7))
    d30_str = str(d_latest - timedelta(days=30))
    prev_date_str = d1_str if d1_str in daily_obs else None

    obs_now = daily_obs.get(latest_date, {})
    obs_1 = daily_obs.get(d1_str, {})
    obs_7 = daily_obs.get(d7_str, {})
    obs_30 = daily_obs.get(d30_str, {})

    # Pre-build series per book across series_dates
    series_map = {}
    for d_str in series_dates:
        idx = date_to_idx[d_str]
        for bid, (rc, _wn) in daily_obs[d_str].items():
            if catalog_ids and bid not in catalog_ids:
                continue
            series_map.setdefault(bid, []).append([idx, rc])

    all_ids = (set(obs_now.keys()) | set(series_map.keys()))
    if catalog_ids:
        all_ids &= catalog_ids

    for bid in all_ids:
        cur = obs_now.get(bid)
        cur_r = cur[0] if cur else None
        cur_w = cur[1] if cur else None

        # If missing on latest_date (e.g. partial day), fall back to latest point in series for readers display only
        if cur_r is None:
            pts = series_map.get(bid)
            if not pts:
                continue
            trends_books[bid] = [pts[-1][1], None, None, None, None, None, None, None, pts]
            continue

        b1 = obs_1.get(bid)
        b7 = obs_7.get(bid)
        b30 = obs_30.get(bid)

        d1 = (cur_r - b1[0]) if b1 else None
        p1 = pct(d1, b1[0]) if b1 else None
        d7 = (cur_r - b7[0]) if b7 else None
        p7 = pct(d7, b7[0]) if b7 else None
        d30 = (cur_r - b30[0]) if b30 else None
        p30 = pct(d30, b30[0]) if b30 else None

        dw1 = None
        if cur_w is not None and b1 and b1[1] is not None:
            diff_w = cur_w - b1[1]
            if 0 <= diff_w <= 200000:
                dw1 = diff_w
                words_paired1 += 1

        if d1 is not None:
            paired1 += 1
        if d7 is not None:
            paired7 += 1
        if d30 is not None:
            paired30 += 1

        trends_books[bid] = [cur_r, d1, p1, d7, p7, d30, p30, dw1, series_map.get(bid, [])]

trends_payload = {
    'latestDate': latest_date,
    'prevDate': prev_date_str,
    'dates': series_dates,
    'stats': {
        'targets': daily_targets.get(latest_date, total_books) if latest_date else total_books,
        'observed': len(daily_obs.get(latest_date, {})) if latest_date else 0,
        'paired1': paired1,
        'paired7': paired7,
        'paired30': paired30,
        'wordsPaired1': words_paired1,
        'validCovers': valid_covers,
        'totalBooks': total_books,
    },
    'books': trends_books,
}

(out / 'data' / 'trends.json.gz').write_bytes(
    gzip.compress(
        json.dumps(trends_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
)

print(
    json.dumps(
        {
            'latestDate': latest_date,
            'seriesDays': len(series_dates),
            'trendsBooks': len(trends_books),
            'stats': trends_payload['stats'],
            'trendsBytes': (out / 'data' / 'trends.json.gz').stat().st_size,
        },
        ensure_ascii=False,
    )
)
