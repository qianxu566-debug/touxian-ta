"""Build the static GitHub Pages output (_site) and compile compact trends.json.gz & radar.json.gz.

Inputs:
  - catalog.gz (passed as sys.argv[2] or ./catalog.gz)
  - data/days/YYYY-MM-DD.json.gz (daily detail observations: [ts, readers, words?])
  - data/book-dates.json.gz, data/hot.json
  - history/YYYY-MM-DD.json.gz (official ranks 1..100 & boards)
  - index.html, assets/*

Outputs in _site/:
  - index.html, assets/*, catalog.gz
  - data/trends.json.gz  (same-origin compact 1d/7d/30d trends + single-day word diff + 30d sparkline series)
  - data/radar.json.gz   (precompiled index for 「扫榜」 and 「首秀」)
  - data/book-dates.json.gz, data/hot.json
  - history/index.json, history/YYYY-MM-DD.json.gz (trimmed to pos <= 30 for fast 「排行榜」 tab)
"""
import gzip
import json
import shutil
import sys
import time
import urllib.parse as urlparse
from datetime import date, timedelta
from pathlib import Path

BOARD_NAMES = {3: '巅峰榜', 4: '黑马榜', 5: '热搜榜', 6: '推荐榜'}
CATALOG_BASE_DATE = '2026-11-26'

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

# 1. Load valid rank history files (up to 90 days) and write Top-30 trimmed copies for 排行榜
rank_files = sorted(Path('history').glob('????-??-??.json.gz'))[-90:]
rank_snaps = {}  # date_str -> parsed json
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
    day_str = s.get('date') or f.name[:10]
    s['date'] = day_str
    rank_snaps[day_str] = s

    trimmed_scopes = []
    for g in s.get('scopes', []):
        g_copy = dict(g)
        rows = g.get('rows') or []
        g_copy['rows'] = [r for r in rows if (r.get('pos') or 999) <= 30][:30]
        trimmed_scopes.append(g_copy)
    trimmed = {
        'date': day_str,
        'scopes': trimmed_scopes,
        'boards': s.get('boards') or {},
    }
    target = out / 'history' / f.name
    if target.resolve() != f.resolve():
        target.write_bytes(
            gzip.compress(
                json.dumps(trimmed, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
                compresslevel=6,
                mtime=0,
            )
        )

all_rank_dates = sorted(rank_snaps.keys())
rank_dates_desc = list(reversed(all_rank_dates))
(out / 'history' / 'index.json').write_text(json.dumps(rank_dates_desc), encoding='utf-8')

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

series_dates = [d for d in all_obs_dates if not latest_date or d <= latest_date][-30:]
date_to_idx = {d: i for i, d in enumerate(series_dates)}

catalog_map = {}
valid_covers = 0
total_books = 0
if catalog_src.exists():
    with gzip.open(catalog_src, 'rt', encoding='utf-8') as fh:
        cat = json.load(fh)
    now_s = time.time()
    for b in cat.get('books', []):
        total_books += 1
        bid = str(b['id'])
        catalog_map[bid] = b
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

catalog_ids = set(catalog_map.keys())


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
series_map = {}

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

    # Fallback wordNumber from d1_str rank snapshot (bridges 11-25 -> 11-26 immediately)
    rank_words_d1 = {}
    if d1_str in rank_snaps:
        for s in rank_snaps[d1_str].get('scopes', []):
            for r in s.get('rows', []):
                wn = r.get('words')
                if isinstance(wn, int) and wn > 0:
                    rank_words_d1[str(r['id'])] = wn

    for d_str in series_dates:
        idx = date_to_idx[d_str]
        for bid, (rc, _wn) in daily_obs[d_str].items():
            series_map.setdefault(bid, []).append([idx, rc])

    all_ids = set(obs_now.keys()) | set(series_map.keys())
    if catalog_ids:
        # Keep catalog books plus any ranked books seen in observations
        all_ids &= (catalog_ids | set(obs_now.keys()))

    for bid in all_ids:
        cur = obs_now.get(bid)
        cur_r = cur[0] if cur else None
        cur_w = cur[1] if cur else None

        if cur_r is None:
            pts = series_map.get(bid)
            if not pts or bid not in catalog_ids:
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
        prev_w = b1[1] if (b1 and b1[1] is not None) else rank_words_d1.get(bid)
        if cur_w is not None and prev_w is not None:
            diff_w = cur_w - prev_w
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

# 3. Compile data/radar.json.gz for 「扫榜」 and 「首秀」
book_dates = {}
bd_path = Path('data/book-dates.json.gz')
if bd_path.exists():
    try:
        with gzip.open(bd_path, 'rt', encoding='utf-8') as fh:
            book_dates = json.load(fh)
    except Exception:
        book_dates = {}

top30_base_date = all_rank_dates[0] if all_rank_dates else '9999-99-99'
top100_base_date = '9999-99-99'
for d_str in all_rank_dates:
    has_deep_rank = any(
        (r.get('pos') or 0) > 30
        for s in rank_snaps[d_str].get('scopes', [])
        if s.get('ok')
        for r in s.get('rows', [])
    )
    if has_deep_rank:
        top100_base_date = d_str
        break

win_dates = all_rank_dates[-30:]
win_date_to_idx = {d: i for i, d in enumerate(win_dates)}
latest_rank_date = all_rank_dates[-1] if all_rank_dates else latest_date

cats = []
cat_to_idx = {}


def get_cat_idx(gender_str, name):
    key = (str(gender_str or ''), str(name or ''))
    if key not in cat_to_idx:
        cat_to_idx[key] = len(cats)
        cats.append([key[0], key[1]])
    return cat_to_idx[key]


# Full-history tracking structures
first_any_30 = {}      # bid -> earliest date seen in pos<=30 or board
first_any_100 = {}     # bid -> earliest date seen in any rank/board
first_mold1_30 = {}    # bid -> (date, best_pos, cat_name)
first_mold1_100 = {}   # bid -> (date, best_pos, cat_name)
first_hot_30 = {}      # bid -> (date, best_pos, label)  (mold 2 or 4)
first_hot_100 = {}     # bid -> (date, best_pos, label)

# Window aggregation for sweep
sweep_lanes = {}       # bid -> {(mold, cat_idx): [mask30, mask100, best30, best100, latestPos]}
rank_meta = {}         # bid -> latest book metadata collected from ranks
rank_readers_by_day = {}  # (bid, date_str) -> readers

for d_str in all_rank_dates:
    snap = rank_snaps[d_str]
    win_idx = win_date_to_idx.get(d_str)
    bit = (1 << win_idx) if win_idx is not None else 0
    is_latest_rank = (d_str == latest_rank_date)

    # Category ranks (mold 1 = 新书榜, mold 2 = 阅读榜)
    for s in snap.get('scopes', []):
        if not s.get('ok'):
            continue
        mold = int(s.get('mold') or 0)
        gender = str(s.get('gender') or '')
        cat_name = str(s.get('category') or '')
        cidx = get_cat_idx(gender, cat_name)
        ch = '男频' if gender == '1' else ('女频' if gender == '0' else '')

        for r in s.get('rows', []):
            bid = str(r.get('id') or '')
            pos = r.get('pos')
            if not bid or not isinstance(pos, int) or pos <= 0 or pos > 100:
                continue

            rc = r.get('readers')
            if isinstance(rc, int) and rc >= 0:
                rank_readers_by_day[(bid, d_str)] = max(rank_readers_by_day.get((bid, d_str), -1), rc)

            if bid not in first_any_100:
                first_any_100[bid] = d_str
            if pos <= 30 and bid not in first_any_30:
                first_any_30[bid] = d_str

            if mold == 1:
                if bid not in first_mold1_100 or (d_str == first_mold1_100[bid][0] and pos < first_mold1_100[bid][1]):
                    if bid not in first_mold1_100 or d_str <= first_mold1_100[bid][0]:
                        first_mold1_100[bid] = (d_str, pos, cat_name)
                if pos <= 30 and (bid not in first_mold1_30 or (d_str == first_mold1_30[bid][0] and pos < first_mold1_30[bid][1])):
                    if bid not in first_mold1_30 or d_str <= first_mold1_30[bid][0]:
                        first_mold1_30[bid] = (d_str, pos, cat_name)
            elif mold == 2:
                lbl = f'{cat_name}阅读榜'
                if bid not in first_hot_100 or (d_str == first_hot_100[bid][0] and pos < first_hot_100[bid][1]):
                    if bid not in first_hot_100 or d_str <= first_hot_100[bid][0]:
                        first_hot_100[bid] = (d_str, pos, lbl)
                if pos <= 30 and (bid not in first_hot_30 or (d_str == first_hot_30[bid][0] and pos < first_hot_30[bid][1])):
                    if bid not in first_hot_30 or d_str <= first_hot_30[bid][0]:
                        first_hot_30[bid] = (d_str, pos, lbl)

            if win_idx is not None:
                lanes_map = sweep_lanes.setdefault(bid, {})
                lk = (mold, cidx)
                st = lanes_map.get(lk)
                if not st:
                    st = [0, 0, 999, 999, 999]
                    lanes_map[lk] = st
                if pos <= 30:
                    st[0] |= bit
                    if pos < st[2]:
                        st[2] = pos
                st[1] |= bit
                if pos < st[3]:
                    st[3] = pos
                if is_latest_rank and pos < st[4]:
                    st[4] = pos

            # Merge latest metadata for extraBooks hydration
            m = rank_meta.get(bid)
            if not m:
                m = {
                    'id': bid,
                    'title': r.get('title') or '',
                    'author': r.get('author') or '',
                    'intro': r.get('intro') or '',
                    'coverUrl': r.get('coverUrl') or '',
                    'readers': rc if isinstance(rc, int) else None,
                    'words': r.get('words') if isinstance(r.get('words'), int) else None,
                    'status': r.get('status') or '',
                    'channel': ch,
                    'primary': [cat_name] if cat_name else [],
                    'tags': [],
                }
                rank_meta[bid] = m
            else:
                if r.get('title'):
                    m['title'] = r['title']
                if r.get('author'):
                    m['author'] = r['author']
                if r.get('intro'):
                    m['intro'] = r['intro']
                if r.get('coverUrl'):
                    m['coverUrl'] = r['coverUrl']
                if isinstance(rc, int) and rc >= 0:
                    m['readers'] = rc
                if isinstance(r.get('words'), int) and r['words'] > 0:
                    m['words'] = r['words']
                if r.get('status'):
                    m['status'] = r['status']
                if cat_name and cat_name not in m['primary']:
                    m['primary'].append(cat_name)
                if ch and m['channel'] and m['channel'] != ch:
                    m['channel'] = '共用'
                elif ch and not m['channel']:
                    m['channel'] = ch

    # Special boards (mold 3..6)
    for mold_key, bdata in (snap.get('boards') or {}).items():
        mold = int(mold_key)
        bname = BOARD_NAMES.get(mold, f'榜单{mold}')
        cidx = get_cat_idx('', bname)
        for r in bdata.get('rows', []):
            bid = str(r.get('id') or '')
            pos = r.get('pos')
            if not bid or not isinstance(pos, int) or pos <= 0:
                continue
            rc = r.get('readers')
            if isinstance(rc, int) and rc >= 0:
                rank_readers_by_day[(bid, d_str)] = max(rank_readers_by_day.get((bid, d_str), -1), rc)
            if bid not in first_any_100:
                first_any_100[bid] = d_str
            if bid not in first_any_30:
                first_any_30[bid] = d_str
            if mold == 4:
                if bid not in first_hot_30 or (d_str == first_hot_30[bid][0] and pos < first_hot_30[bid][1]):
                    if bid not in first_hot_30 or d_str <= first_hot_30[bid][0]:
                        first_hot_30[bid] = (d_str, pos, '黑马榜')
                if bid not in first_hot_100 or (d_str == first_hot_100[bid][0] and pos < first_hot_100[bid][1]):
                    if bid not in first_hot_100 or d_str <= first_hot_100[bid][0]:
                        first_hot_100[bid] = (d_str, pos, '黑马榜')

            if win_idx is not None:
                lanes_map = sweep_lanes.setdefault(bid, {})
                lk = (mold, cidx)
                st = lanes_map.get(lk)
                if not st:
                    st = [0, 0, 999, 999, 999]
                    lanes_map[lk] = st
                if pos <= 30:
                    st[0] |= bit
                    if pos < st[2]:
                        st[2] = pos
                st[1] |= bit
                if pos < st[3]:
                    st[3] = pos
                if is_latest_rank and pos < st[4]:
                    st[4] = pos

            if bid not in rank_meta:
                rank_meta[bid] = {
                    'id': bid,
                    'title': r.get('title') or '',
                    'author': r.get('author') or '',
                    'intro': r.get('intro') or '',
                    'coverUrl': r.get('coverUrl') or '',
                    'readers': rc if isinstance(rc, int) else None,
                    'words': None,
                    'status': '',
                    'channel': '',
                    'primary': list(r.get('primary') or []),
                    'tags': list(r.get('tags') or []),
                }


def span_gain(bid, max_days):
    if not latest_date:
        return None
    obs_now_row = daily_obs.get(latest_date, {}).get(bid)
    if not obs_now_row:
        return None
    cur_r = obs_now_row[0]
    min_d = str(date.fromisoformat(latest_date) - timedelta(days=max_days))
    candidates = [d for d in all_obs_dates if min_d <= d < latest_date and bid in daily_obs[d]]
    if not candidates:
        return None
    base_d = candidates[0]
    return cur_r - daily_obs[base_d][bid][0]


def classify_trend_state(bid):
    pts = [rc for _, rc in series_map.get(bid, [])[-8:]]
    if len(pts) < 2:
        return ''
    net = pts[-1] - pts[0]
    last_step = pts[-1] - pts[-2]
    net_pct = net / max(pts[0], 1)
    step_pct = last_step / max(pts[-2], 1)
    if abs(net_pct) < 0.01 and abs(step_pct) < 0.008:
        return 'flat'
    if net > 0 and last_step >= 0 and all(pts[k] >= pts[k - 1] * 0.993 for k in range(1, len(pts))):
        return 'rising'
    if last_step > 0 and (min(pts[:-1]) < pts[0] * 0.992 or net <= 0):
        return 'rebound'
    if last_step < 0 or net < 0:
        return 'falling'
    return 'rising'


sweep_books = {}
for bid, lanes_map in sweep_lanes.items():
    f30 = first_any_30.get(bid)
    f100 = first_any_100.get(bid)
    new30 = f30 if (f30 and f30 > top30_base_date) else None
    if new30 and f100 == f30:
        new100 = new30
    elif f100 and f100 > top100_base_date:
        new100 = f100
    else:
        new100 = None

    lanes_list = [
        [lk[0], lk[1], st[0], st[1], st[2], st[3], st[4]]
        for lk, st in sorted(lanes_map.items(), key=lambda kv: (kv[1][3], kv[0][0], kv[0][1]))
    ]
    tr = trends_books.get(bid)
    g1 = tr[1] if tr else None
    g7 = span_gain(bid, 7)
    g30 = span_gain(bid, 30)
    t_state = classify_trend_state(bid)
    sweep_books[bid] = [lanes_list, new30, new100, g1, g7, g30, t_state]


def readers_on_day(bid, d_str):
    row = daily_obs.get(d_str, {}).get(bid)
    if row:
        return row[0]
    return rank_readers_by_day.get((bid, d_str))


# Build 「首秀」 entries: young ongoing works that genuinely broke out after baseline
first_obs_date = {}
for d_str in all_obs_dates:
    for bid in daily_obs[d_str]:
        if bid not in first_obs_date:
            first_obs_date[bid] = d_str

debut_books = {}
candidate_debut_ids = set(first_mold1_100.keys()) | set(first_hot_100.keys()) | set(catalog_ids)
obs_and_rank_dates = sorted(set(all_obs_dates) | set(all_rank_dates))
ref_today = latest_rank_date or latest_date or CATALOG_BASE_DATE

for bid in candidate_debut_ids:
    cat_b = catalog_map.get(bid)
    meta_b = rank_meta.get(bid)
    if not cat_b and not meta_b:
        continue

    status = (cat_b or {}).get('status') or (meta_b or {}).get('status') or ''
    if status == '已完结':
        continue
    words = (cat_b or {}).get('words') or (meta_b or {}).get('words')
    if isinstance(words, int) and words > 600000:
        continue

    # Book age check when chapter-1 start date is known
    start_str = (book_dates.get(bid) or {}).get('start')
    if start_str and ref_today:
        try:
            age_d = (date.fromisoformat(ref_today) - date.fromisoformat(start_str)).days
            if age_d > 120:
                continue
        except ValueError:
            pass

    # For reader satisfaction ("只看已起量新书"), keep catalog floor (>=8,000 readers if known) or Top-30 new book rank
    tr = trends_books.get(bid)
    cur_readers = (tr[0] if tr else None) or (cat_b or {}).get('readers') or (meta_b or {}).get('readers')

    debut_date = None
    kind = None
    label = None
    best_pos = 999

    # Source 1: 新书榜首秀
    m30 = first_mold1_30.get(bid)
    m100 = first_mold1_100.get(bid)
    if m30 and m30[0] > top30_base_date and first_any_30.get(bid, '9999') > top30_base_date:
        debut_date, best_pos, cname = m30
        kind = 'newrank'
        label = f'{cname}新书榜 · 最高第{best_pos}名'
    elif m100 and m100[0] > top100_base_date and first_any_100.get(bid, '9999') > top100_base_date:
        if cur_readers is None or cur_readers >= 8000:
            debut_date, best_pos, cname = m100
            kind = 'newrank'
            label = f'{cname}新书榜 · 最高第{best_pos}名'

    # Source 2: 阅读榜 / 黑马榜新晋 (<= 50万字)
    if not debut_date and (not isinstance(words, int) or words <= 500000):
        h30 = first_hot_30.get(bid)
        h100 = first_hot_100.get(bid)
        if h30 and h30[0] > top30_base_date and first_any_30.get(bid, '9999') > top30_base_date:
            debut_date, best_pos, hlbl = h30
            kind = 'hotrank'
            label = f'{hlbl} · 最高第{best_pos}名'
        elif h100 and h100[0] > top100_base_date and first_any_100.get(bid, '9999') > top100_base_date:
            if cur_readers is None or cur_readers >= 8000:
                debut_date, best_pos, hlbl = h100
                kind = 'hotrank'
                label = f'{hlbl} · 最高第{best_pos}名'

    # Source 3: 书库新晋破万 (entered catalog strictly after deep-crawl baseline)
    if not debut_date and (not isinstance(words, int) or words <= 500000) and (cur_readers or 0) >= 8000:
        fo = first_obs_date.get(bid)
        if fo and fo > CATALOG_BASE_DATE:
            debut_date = fo
            kind = 'library'
            label = '书库新晋破万'
            best_pos = None

    if not debut_date:
        continue

    # Respect main >=8000 floor unless already in catalog
    if bid not in catalog_ids and cur_readers is not None and cur_readers < 8000:
        continue

    d_debut = date.fromisoformat(debut_date)
    day_num = (date.fromisoformat(ref_today) - d_debut).days + 1 if ref_today else 1
    end_cap = str(min(date.fromisoformat(ref_today), d_debut + timedelta(days=13)))

    # 14-day debut cumulative & daily average gain
    start_win_end = str(d_debut + timedelta(days=3))
    r_start, d_start = None, None
    for d_s in obs_and_rank_dates:
        if debut_date <= d_s <= start_win_end:
            val = readers_on_day(bid, d_s)
            if val is not None:
                r_start, d_start = val, d_s
                break

    r_end, d_end = None, None
    for d_e in reversed(obs_and_rank_dates):
        if debut_date <= d_e <= end_cap:
            val = readers_on_day(bid, d_e)
            if val is not None:
                r_end, d_end = val, d_e
                break

    if d_start and d_end and d_end > d_start and r_start is not None and r_end is not None:
        period_gain = r_end - r_start
        span_days = max(1, (date.fromisoformat(d_end) - date.fromisoformat(d_start)).days)
        daily_avg = round(period_gain / span_days)
    elif tr and tr[1] is not None:
        period_gain = tr[1]
        daily_avg = tr[1]
    else:
        period_gain = None
        daily_avg = None

    debut_books[bid] = [debut_date, kind, label, day_num, period_gain, daily_avg, best_pos]

# Hydrate any ranked/debut book missing from catalog_ids (e.g., #31..#100 <8k readers)
extra_books = {}
for bid in (set(sweep_books.keys()) | set(debut_books.keys())) - catalog_ids:
    m = rank_meta.get(bid)
    if m and m.get('title'):
        extra_books[bid] = m

radar_payload = {
    'rankDates': win_dates,
    'latestRankDate': latest_rank_date,
    'top30BaseDate': top30_base_date,
    'top100BaseDate': top100_base_date,
    'catalogBaseDate': CATALOG_BASE_DATE,
    'cats': cats,
    'sweep': sweep_books,
    'debut': debut_books,
    'extraBooks': extra_books,
}

(out / 'data' / 'radar.json.gz').write_bytes(
    gzip.compress(
        json.dumps(radar_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
)

print(
    json.dumps(
        {
            'latestDate': latest_date,
            'latestRankDate': latest_rank_date,
            'seriesDays': len(series_dates),
            'rankDays': len(win_dates),
            'trendsBooks': len(trends_books),
            'sweepBooks': len(sweep_books),
            'debutBooks': len(debut_books),
            'extraBooks': len(extra_books),
            'stats': trends_payload['stats'],
            'trendsBytes': (out / 'data' / 'trends.json.gz').stat().st_size,
            'radarBytes': (out / 'data' / 'radar.json.gz').stat().st_size,
        },
        ensure_ascii=False,
    )
)
