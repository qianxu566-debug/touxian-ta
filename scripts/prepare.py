"""Build the static GitHub Pages output (_site) and compile compact trends.json.gz & radar.json.gz.

Inputs:
  - catalog.gz (passed as sys.argv[2] or ./catalog.gz)
  - data/days/YYYY-MM-DD.json.gz (daily detail observations: [ts, readers, words?])
  - data/book-dates.json.gz, data/hot.json
  - history/YYYY-MM-DD.json.gz (official ranks 1..100 & boards across all 40 main categories)
  - index.html, assets/*

Outputs in _site/:
  - index.html, assets/*, catalog.gz
  - data/trends.json.gz  (same-origin compact 1d/7d/30d trends + single-day word diff + 30d sparkline series)
  - data/radar.json.gz   (precompiled index for 「扫榜」, 「首秀」, and全站名片榜单履历)
  - data/book-dates.json.gz, data/hot.json
  - history/index.json, history/YYYY-MM-DD.json.gz (full Top-100 compact snapshots for 「排行榜」)
"""
import gzip
import hashlib
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
    if Path('manifest.json').exists():
        shutil.copyfile('manifest.json', out / 'manifest.json')
    shutil.copytree('assets', out / 'assets', dirs_exist_ok=True)
    if Path('data/hot.json').exists():
        shutil.copyfile('data/hot.json', out / 'data/hot.json')

# 0. Load catalog_map early so compact history snapshots can omit redundant strings
def best_cover_url(book_obj, now_s):
    best_u = ''
    best_exp = 0
    for k in ('longCoverUrl', 'freshCoverUrl', 'coverUrl'):
        u = book_obj.get(k) or ''
        if u.startswith('https://'):
            qs = urlparse.parse_qs(urlparse.urlsplit(u).query)
            e = int(qs.get('x-expires', [str(int(now_s) + 86400)])[0])
            if e > now_s and e > best_exp:
                best_exp = e
                best_u = u
    return best_u, best_exp


cat = {}
catalog_map = {}
valid_covers = 0
total_books = 0
now_s = time.time()
if catalog_src.exists():
    with gzip.open(catalog_src, 'rt', encoding='utf-8') as fh:
        cat = json.load(fh)
    for b in cat.get('books', []):
        total_books += 1
        bid = str(b['id'])
        catalog_map[bid] = b
        _, best_exp = best_cover_url(b, now_s)
        if best_exp > now_s:
            valid_covers += 1

catalog_ids = set(catalog_map.keys())

book_dates = {}
bd_path = Path('data/book-dates.json.gz')
if bd_path.exists():
    try:
        with gzip.open(bd_path, 'rt', encoding='utf-8') as fh:
            book_dates = json.load(fh)
    except Exception:
        book_dates = {}

slim_book_dates = {
    str(bid): {'start': v['start']}
    for bid, v in book_dates.items()
    if isinstance(v, dict) and v.get('start')
}
(out / 'data' / 'book-dates.json.gz').write_bytes(
    gzip.compress(
        json.dumps(slim_book_dates, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
)


def resolve_score(bid, b_obj=None):
    bd_entry = book_dates.get(bid)
    if isinstance(bd_entry, dict):
        sv = bd_entry.get('score')
        if isinstance(sv, (int, float)) and 0 < sv <= 10:
            sc_cnt = bd_entry.get('sc')
            return round(float(sv), 1), (int(sc_cnt) if isinstance(sc_cnt, int) and sc_cnt > 0 else 0)
    if isinstance(b_obj, dict):
        sv = b_obj.get('score')
        if isinstance(sv, (int, float)) and 0 < sv <= 10:
            sc_cnt = b_obj.get('scoreCount')
            return round(float(sv), 1), (int(sc_cnt) if isinstance(sc_cnt, int) and sc_cnt > 0 else 0)
    return None, 0

# 1. Load ALL valid rank history files (no 90-day cutoff for lifetime badge tenure!)
rank_files = sorted(Path('history').glob('????-??-??.json.gz'))
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

all_rank_dates = sorted(rank_snaps.keys())
# Permanent weekly rank archive: keep 1 snapshot per ISO (year, week) using the latest day in that week.
# Current week naturally serves today's latest snapshot; past weeks freeze permanently without a 90-day cutoff.
week_latest = {}
for d_str in all_rank_dates:
    iso_y, iso_w, _ = date.fromisoformat(d_str).isocalendar()
    week_latest[(iso_y, iso_w)] = d_str
kept_rank_dates = sorted(week_latest.values())
rank_dates_desc = list(reversed(kept_rank_dates))
(out / 'history' / 'index.json').write_text(json.dumps(rank_dates_desc), encoding='utf-8')

# Write full Top-100 compact snapshots for last 90 rank dates (deduplicating rows already in catalog.gz)
for day_str in kept_rank_dates:
    s = rank_snaps[day_str]
    compact_scopes = []
    for g in s.get('scopes', []):
        g_copy = {
            'key': g.get('key'),
            'gender': g.get('gender'),
            'cid': g.get('cid'),
            'category': g.get('category'),
            'mold': g.get('mold'),
            'observed': g.get('observed'),
            'ok': g.get('ok'),
        }
        compact_rows = []
        for r in g.get('rows') or []:
            pos = r.get('pos')
            if not isinstance(pos, int) or pos <= 0 or pos > 100:
                continue
            bid = str(r.get('id') or '')
            if bid in catalog_ids and catalog_map[bid].get('title'):
                c_row = {
                    'id': bid,
                    'pos': pos,
                    'readers': r.get('readers'),
                    'words': r.get('words'),
                    'status': r.get('status') or '',
                }
                if isinstance(r.get('lastUpdate'), int) and r['lastUpdate'] > 946684800:
                    c_row['lastUpdate'] = r['lastUpdate']
                compact_rows.append(c_row)
            else:
                sc_val, sc_cnt = resolve_score(bid, r)
                c_row = {
                    'id': bid,
                    'pos': pos,
                    'readers': r.get('readers'),
                    'words': r.get('words'),
                    'status': r.get('status') or '',
                    'title': r.get('title') or '',
                    'author': r.get('author') or '',
                    'intro': r.get('intro') or '',
                    'coverUrl': r.get('coverUrl') or '',
                }
                if isinstance(r.get('lastUpdate'), int) and r['lastUpdate'] > 946684800:
                    c_row['lastUpdate'] = r['lastUpdate']
                if sc_val is not None:
                    c_row['score'] = sc_val
                    if sc_cnt > 0:
                        c_row['scoreCount'] = sc_cnt
                compact_rows.append(c_row)
        g_copy['rows'] = compact_rows
        compact_scopes.append(g_copy)

    compact_boards = {}
    for mk, bdata in (s.get('boards') or {}).items():
        b_rows = []
        for r in bdata.get('rows') or []:
            bid = str(r.get('id') or '')
            if bid in catalog_ids and catalog_map[bid].get('title'):
                b_row = {
                    'id': bid,
                    'pos': r.get('pos'),
                    'readers': r.get('readers'),
                }
                if r.get('ch'):
                    b_row['ch'] = r['ch']
                b_rows.append(b_row)
            else:
                sc_val, sc_cnt = resolve_score(bid, r)
                b_copy = dict(r)
                if sc_val is not None:
                    b_copy['score'] = sc_val
                    if sc_cnt > 0:
                        b_copy['scoreCount'] = sc_cnt
                b_rows.append(b_copy)
        compact_boards[mk] = {'observed': bdata.get('observed'), 'rows': b_rows}

    trimmed = {'date': day_str, 'scopes': compact_scopes, 'boards': compact_boards}
    target = out / 'history' / f'{day_str}.json.gz'
    if target.resolve() != (Path('history') / f'{day_str}.json.gz').resolve():
        target.write_bytes(
            gzip.compress(
                json.dumps(trimmed, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
                compresslevel=6,
                mtime=0,
            )
        )

# 2. Load daily detail observations from data/days/YYYY-MM-DD.json.gz (up to last 35 days)
day_files = sorted(Path('data/days').glob('????-??-??.json.gz'))[-35:]
daily_obs = {}  # date_str -> {id: (readers, words_or_None)}
daily_unavail = {}  # date_str -> set(id)
daily_targets = {}
for f in day_files:
    try:
        with gzip.open(f, 'rt', encoding='utf-8') as fh:
            d = json.load(fh)
    except Exception:
        continue
    day_str = d.get('date') or f.name[:10]
    rows = d.get('rows') or {}
    unavail_ids = {str(x) for x in (d.get('unavailable') or []) if x is not None}
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
        daily_unavail[day_str] = unavail_ids
        daily_targets[day_str] = d.get('targetsCount') or len(d.get('targets') or []) or len(parsed)

all_obs_dates = sorted(daily_obs.keys())
consec_unavail = {}
if all_obs_dates:
    newest_obs_day = all_obs_dates[-1]
    for bid in daily_unavail.get(newest_obs_day, ()):
        if bid in daily_obs.get(newest_obs_day, {}):
            continue
        streak = 0
        for d_str in reversed(all_obs_dates):
            if bid in daily_unavail.get(d_str, ()) and bid not in daily_obs.get(d_str, {}):
                streak += 1
            else:
                break
        if streak > 0:
            consec_unavail[bid] = streak

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

quarantined_ids = set()
latest_obs_map = daily_obs.get(latest_date, {}) if latest_date else {}
for bid in catalog_ids | set(consec_unavail.keys()):
    if latest_date and bid in latest_obs_map:
        eff_u = 0
    else:
        eff_u = max(
            consec_unavail.get(bid, 0),
            int((catalog_map.get(bid) or {}).get('unavailDays') or 0),
        )
    if eff_u >= 2:
        quarantined_ids.add(bid)

series_dates = [d for d in all_obs_dates if not latest_date or d <= latest_date][-30:]
date_to_idx = {d: i for i, d in enumerate(series_dates)}


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
        'datedBooks': len(slim_book_dates),
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

# 3. Compile data/radar.json.gz for 「扫榜」, 「首秀」, and lifetime rank badges

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


first_any_30 = {}
first_any_100 = {}
first_mold1_30 = {}
first_mold1_100 = {}
first_hot_30 = {}
first_hot_100 = {}

# Lifetime badge tracking: bid -> {grp -> {date_str: min_pos}}
badge_days = {}
sweep_lanes = {}
rank_meta = {}
rank_readers_by_day = {}
rank_genders = {}

for d_str in all_rank_dates:
    snap = rank_snaps[d_str]
    win_idx = win_date_to_idx.get(d_str)
    bit = (1 << win_idx) if win_idx is not None else 0
    is_latest_rank = (d_str == latest_rank_date)

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
            if gender in ('0', '1'):
                rank_genders.setdefault(bid, set()).add(gender)

            b_grp = badge_days.setdefault(bid, {}).setdefault(mold, {})
            if d_str not in b_grp or pos < b_grp[d_str]:
                b_grp[d_str] = pos

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
                    'lastUpdate': r.get('lastUpdate') if isinstance(r.get('lastUpdate'), int) and r['lastUpdate'] > 946684800 else None,
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
                if isinstance(r.get('lastUpdate'), int) and r['lastUpdate'] > 946684800:
                    m['lastUpdate'] = max(m.get('lastUpdate') or 0, r['lastUpdate'])
                if r.get('status'):
                    m['status'] = r['status']
                if cat_name and cat_name not in m['primary']:
                    m['primary'].append(cat_name)
                if ch and m['channel'] and m['channel'] != ch:
                    m['channel'] = '共用'
                elif ch and not m['channel']:
                    m['channel'] = ch

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
            r_ch = r.get('ch')
            if r_ch == '男频':
                rank_genders.setdefault(bid, set()).add('1')
            elif r_ch == '女频':
                rank_genders.setdefault(bid, set()).add('0')

            b_grp = badge_days.setdefault(bid, {}).setdefault(mold, {})
            if d_str not in b_grp or pos < b_grp[d_str]:
                b_grp[d_str] = pos

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
    if bid in quarantined_ids:
        continue
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

# Build compact lifetime rank history badges: radar['badges'][bid]
badges = {}
grp_priority = {2: 0, 1: 1, 4: 2, 3: 3, 5: 4, 6: 5}
for bid, grp_map in badge_days.items():
    items = []
    for grp, dpos in grp_map.items():
        sdates = sorted(dpos.keys())
        total_days = len(sdates)
        first_date = sdates[0]
        first_pos = dpos[first_date]
        last_date = sdates[-1]
        if grp in (1, 2):
            exact_start = 0 if (first_date == top30_base_date or (first_date == top100_base_date and first_pos > 30)) else 1
        else:
            exact_start = 0 if first_date == top30_base_date else 1
        on_today = 1 if (latest_rank_date and last_date == latest_rank_date) else 0
        drop_mmdd = '' if on_today else str(date.fromisoformat(last_date) + timedelta(days=1))[5:]
        best_pos = min(dpos.values())
        top1_days = sum(1 for p in dpos.values() if p == 1)
        top10_days = sum(1 for p in dpos.values() if p <= 10)
        items.append((
            (grp_priority.get(grp, 9), -total_days, best_pos),
            [grp, total_days, first_date[5:], exact_start, best_pos, top1_days, top10_days, on_today, drop_mmdd],
        ))
    items.sort(key=lambda x: x[0])
    badges[bid] = [x[1] for x in items[:3]]


def readers_on_day(bid, d_str):
    row = daily_obs.get(d_str, {}).get(bid)
    if row:
        return row[0]
    return rank_readers_by_day.get((bid, d_str))


# Precompute first_obs_date & verified 10k-crossing dates across daily_obs
first_obs_date = {}
cross10k = {}  # bid -> (cross_date, before_readers)
min_obs_seen = {}  # bid -> min_readers_seen_before
for d_str in all_obs_dates:
    for bid, (rc, _wn) in daily_obs[d_str].items():
        if bid not in first_obs_date:
            first_obs_date[bid] = d_str
        prev_min = min_obs_seen.get(bid)
        if prev_min is None:
            min_obs_seen[bid] = rc
        else:
            if bid not in cross10k and prev_min < 10000 and rc >= 10000:
                cross10k[bid] = (d_str, prev_min)
            if rc < prev_min:
                min_obs_seen[bid] = rc

debut_books = {}
candidate_debut_ids = set(first_mold1_100.keys()) | set(first_hot_100.keys()) | set(cross10k.keys()) | set(catalog_ids)
obs_and_rank_dates = sorted(set(all_obs_dates) | set(all_rank_dates))
ref_today = latest_rank_date or latest_date or CATALOG_BASE_DATE

for bid in candidate_debut_ids:
    if bid in quarantined_ids:
        continue
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
    lpt = (cat_b or {}).get('lastUpdate') or (meta_b or {}).get('lastUpdate')
    if isinstance(lpt, int) and lpt > 946684800 and ref_today:
        ref_end = int(time.mktime(date.fromisoformat(ref_today).timetuple())) + 86400
        if (ref_end - lpt) > 14 * 86400:
            continue

    start_str = (book_dates.get(bid) or {}).get('start')
    if start_str and ref_today:
        try:
            age_d = (date.fromisoformat(ref_today) - date.fromisoformat(start_str)).days
            if age_d > 120:
                continue
        except ValueError:
            pass

    tr = trends_books.get(bid)
    cur_readers = (tr[0] if tr else None) or (cat_b or {}).get('readers') or (meta_b or {}).get('readers')

    sources = []
    dates_matched = []
    primary_label = None
    best_pos = None

    # Signal 1: 新书榜首秀
    m30 = first_mold1_30.get(bid)
    m100 = first_mold1_100.get(bid)
    if m30 and m30[0] > top30_base_date and first_any_30.get(bid, '9999') > top30_base_date:
        sources.append('newrank')
        dates_matched.append(m30[0])
        best_pos = m30[1]
        primary_label = f'{m30[2]}新书榜 · 最高第{best_pos}名'
    elif m100 and m100[0] > top100_base_date and first_any_100.get(bid, '9999') > top100_base_date:
        if cur_readers is None or cur_readers >= 8000:
            sources.append('newrank')
            dates_matched.append(m100[0])
            best_pos = m100[1]
            primary_label = f'{m100[2]}新书榜 · 最高第{best_pos}名'

    # Signal 2: 阅读榜 / 黑马榜新晋 (<= 50万字)
    if not isinstance(words, int) or words <= 500000:
        h30 = first_hot_30.get(bid)
        h100 = first_hot_100.get(bid)
        if h30 and h30[0] > top30_base_date and first_any_30.get(bid, '9999') > top30_base_date:
            sources.append('hotrank')
            dates_matched.append(h30[0])
            if not primary_label:
                best_pos = h30[1]
                primary_label = f'{h30[2]} · 最高第{best_pos}名'
        elif h100 and h100[0] > top100_base_date and first_any_100.get(bid, '9999') > top100_base_date:
            if cur_readers is None or cur_readers >= 8000:
                sources.append('hotrank')
                dates_matched.append(h100[0])
                if not primary_label:
                    best_pos = h100[1]
                    primary_label = f'{h100[2]} · 最高第{best_pos}名'

    # Signal 3: 破万新苗 (real observed <10k -> >=10k crossing, or post-baseline >=10k entry)
    if (cur_readers or 0) >= 10000:
        cr = cross10k.get(bid)
        fo = first_obs_date.get(bid)
        if cr:
            sources.append('broke10k')
            dates_matched.append(cr[0])
            if not primary_label:
                primary_label = f'在读突破 1 万（此前 {cr[1]} 人）'
        elif fo and fo > CATALOG_BASE_DATE and (not isinstance(words, int) or words <= 500000):
            sources.append('broke10k')
            dates_matched.append(fo)
            if not primary_label:
                primary_label = '书库新晋破万'

    if not sources:
        continue

    if bid not in catalog_ids and cur_readers is not None and cur_readers < 8000:
        continue

    debut_date = min(dates_matched)
    d_debut = date.fromisoformat(debut_date)
    day_num = (date.fromisoformat(ref_today) - d_debut).days + 1 if ref_today else 1
    if day_num > 30:
        continue
    end_cap = str(min(date.fromisoformat(ref_today), d_debut + timedelta(days=13)))

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

    debut_books[bid] = [debut_date, sources, primary_label, day_num, period_gain, daily_avg, best_pos]

extra_books = {}
for bid in (set(sweep_books.keys()) | set(debut_books.keys()) | set(badges.keys())) - catalog_ids - quarantined_ids:
    m = rank_meta.get(bid)
    if m and m.get('title'):
        sc_val, sc_cnt = resolve_score(bid, m)
        if sc_val is not None:
            m = dict(m)
            m['score'] = sc_val
            if sc_cnt > 0:
                m['scoreCount'] = sc_cnt
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
    'badges': badges,
    'extraBooks': extra_books,
}

(out / 'data' / 'radar.json.gz').write_bytes(
    gzip.compress(
        json.dumps(radar_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
)

# 4. Write slimmed frontend catalog.gz & instant boot payload (data/boot.json.gz)
m_tag_cnt = {}
f_tag_cnt = {}
for b in cat.get('books', []):
    ch0 = b.get('channel') or ''
    if ch0 == '男频':
        for t in (b.get('tags') or []):
            m_tag_cnt[t] = m_tag_cnt.get(t, 0) + 1
    elif ch0 == '女频':
        for t in (b.get('tags') or []):
            f_tag_cnt[t] = f_tag_cnt.get(t, 0) + 1

fem_strong_tags = {
    t for t, c in f_tag_cnt.items()
    if c >= 15 and c / (c + m_tag_cnt.get(t, 0)) >= 0.85
}
male_strong_tags = {
    t for t, c in m_tag_cnt.items()
    if c >= 15 and c / (c + f_tag_cnt.get(t, 0)) >= 0.85
}


def resolve_effective_channel(b, bid):
    ch0 = b.get('channel') or ''
    if ch0 in ('男频', '女频'):
        return ch0
    gset = set(rank_genders.get(bid, ()))
    for ol in (b.get('officialListings') or []):
        if isinstance(ol, dict):
            g = str(ol.get('gender', ''))
            if g in ('0', '1'):
                gset.add(g)
    if gset == {'0'}:
        return '女频'
    if gset == {'1'}:
        return '男频'
    if gset == {'0', '1'}:
        return '共用'
    ts = set(b.get('tags') or [])
    fh = bool(ts & fem_strong_tags)
    mh = bool(ts & male_strong_tags)
    if fh and not mh:
        return '女频'
    if mh and not fh:
        return '男频'
    return ch0 or '共用'


slim_books = []
seen_slim = set()
for b in cat.get('books', []):
    bid = str(b.get('id') or '')
    if not bid or bid in seen_slim or bid in quarantined_ids:
        continue
    seen_slim.add(bid)
    cover_u, _ = best_cover_url(b, now_s)
    eff_ch = resolve_effective_channel(b, bid)
    item = {
        'id': bid,
        'title': b.get('title') or '',
        'author': b.get('author') or '',
        'intro': (b.get('intro') or '').strip(),
        'status': b.get('status') or '',
        'words': b.get('words'),
        'readers': b.get('readers'),
        'tags': b.get('tags') or [],
        'primary': b.get('primary') or [],
        'channel': eff_ch,
        'coverUrl': cover_u,
    }
    if b.get('readersText'):
        item['readersText'] = b['readersText']
    if b.get('officialTags'):
        item['officialTags'] = b['officialTags']
    if b.get('lastUpdate'):
        item['lastUpdate'] = b['lastUpdate']
    if b.get('events'):
        item['events'] = b['events']
    if eff_ch == '共用' and (b.get('channelEvidence') or {}).get('kind') == 'official-detail':
        item['sharedOfficial'] = 1
    sc_val, sc_cnt = resolve_score(bid, b)
    if sc_val is not None:
        item['score'] = sc_val
        if sc_cnt > 0:
            item['scoreCount'] = sc_cnt
    slim_books.append(item)

slim_cat_bytes = 0
if out.resolve() != cwd and catalog_src.exists():
    slim_payload = {
        'updated': cat.get('updated'),
        'coverage': cat.get('coverage'),
        'refresh': cat.get('refresh'),
        'books': slim_books,
    }
    slim_gz = gzip.compress(
        json.dumps(slim_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
    (out / 'catalog.gz').write_bytes(slim_gz)
    slim_cat_bytes = len(slim_gz)
elif (out / 'catalog.gz').exists():
    slim_cat_bytes = (out / 'catalog.gz').stat().st_size

hot_ids = []
hot_path = Path('data/hot.json')
if hot_path.exists():
    try:
        hot_ids = json.loads(hot_path.read_text(encoding='utf-8')).get('ids') or []
    except Exception:
        hot_ids = []
hot_idx = {str(bid): idx for idx, bid in enumerate(hot_ids)}


def eff_readers(book_item):
    tr = trends_books.get(book_item['id'])
    if tr and isinstance(tr[0], (int, float)):
        return tr[0]
    return book_item.get('readers')


INTRO_CHUNKS = 4
BOOK_BUCKETS = 100
ver_sig = f"{cat.get('updated') or ''}|{latest_date or ''}|{latest_rank_date or ''}|{len(slim_books)}|{valid_covers}|{len(trends_books)}|{len(sweep_books)}"
data_ver = f"{(latest_date or latest_rank_date or '0')}_{hashlib.sha1(ver_sig.encode('utf-8')).hexdigest()[:8]}"

ordered_slim = sorted(
    slim_books,
    key=lambda b: (hot_idx.get(b['id'], 10**9), -(eff_readers(b) or 0), b['id']),
)
core_books = [{k: v for k, v in b.items() if k != 'intro'} for b in ordered_slim]
core_payload = {
    'dataVer': data_ver,
    'introChunks': INTRO_CHUNKS,
    'bookBuckets': BOOK_BUCKETS,
    'updated': cat.get('updated'),
    'coverage': cat.get('coverage'),
    'refresh': cat.get('refresh'),
    'books': core_books,
}
core_gz = gzip.compress(
    json.dumps(core_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
    compresslevel=6,
    mtime=0,
)
(out / 'data' / 'catalog-core.json.gz').write_bytes(core_gz)

intro_pairs = [(b['id'], b['intro']) for b in ordered_slim if b.get('intro')]
chunk_size = max(1, (len(intro_pairs) + INTRO_CHUNKS - 1) // INTRO_CHUNKS)
intro_bytes = []
for chunk_i in range(INTRO_CHUNKS):
    part = dict(intro_pairs[chunk_i * chunk_size : (chunk_i + 1) * chunk_size])
    part_gz = gzip.compress(
        json.dumps(part, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
    (out / 'data' / f'intros-{chunk_i}.json.gz').write_bytes(part_gz)
    intro_bytes.append(len(part_gz))


def book_bucket_id(bid: str) -> str:
    s = str(bid or '').strip()
    if s.isdigit():
        return f'{int(s) % BOOK_BUCKETS:02d}'
    return f'{int(hashlib.sha1(s.encode("utf-8")).hexdigest()[:8], 16) % BOOK_BUCKETS:02d}'


def build_shard_book(item):
    bid = str(item['id'])
    entry = {
        'id': bid,
        'title': item.get('title') or '',
        'author': item.get('author') or '',
        'intro': (item.get('intro') or '').strip(),
        'status': item.get('status') or '',
        'words': item.get('words'),
        'readers': eff_readers(item),
        'tags': item.get('tags') or [],
        'primary': item.get('primary') or [],
        'channel': item.get('channel') or '',
        'coverUrl': item.get('coverUrl') or '',
    }
    for opt_k in ('readersText', 'officialTags', 'lastUpdate', 'sharedOfficial', 'score', 'scoreCount'):
        val = item.get(opt_k)
        if val is not None and val != '' and val != {}:
            entry[opt_k] = val
    st = (book_dates.get(bid) or {}).get('start')
    if st:
        entry['start'] = st
    tr = trends_books.get(bid)
    if tr:
        entry['t'] = tr
    bg = badges.get(bid)
    if bg:
        entry['badges'] = bg
    return entry


books_dir = out / 'data' / 'books'
if books_dir.exists():
    shutil.rmtree(books_dir)
books_dir.mkdir(parents=True, exist_ok=True)

bucket_maps = {f'{i:02d}': {} for i in range(BOOK_BUCKETS)}
sharded_ids = set()
for b in ordered_slim:
    bid = str(b['id'])
    sharded_ids.add(bid)
    bucket_maps[book_bucket_id(bid)][bid] = build_shard_book(b)

for bid, m in extra_books.items():
    bid_s = str(bid)
    if bid_s in sharded_ids:
        continue
    sharded_ids.add(bid_s)
    ex_item = dict(m)
    ex_item['id'] = bid_s
    bucket_maps[book_bucket_id(bid_s)][bid_s] = build_shard_book(ex_item)

bucket_bytes_total = 0
bucket_max_bytes = 0
shard_ref_date = latest_date or latest_rank_date
for bkey, bmap in bucket_maps.items():
    b_payload = {
        'v': data_ver,
        'd': shard_ref_date,
        'dates': series_dates,
        'books': bmap,
    }
    b_gz = gzip.compress(
        json.dumps(b_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
    (books_dir / f'b{bkey}.json.gz').write_bytes(b_gz)
    bucket_bytes_total += len(b_gz)
    if len(b_gz) > bucket_max_bytes:
        bucket_max_bytes = len(b_gz)


ge8k_books = [
    b for b in slim_books
    if isinstance(eff_readers(b), (int, float)) and eff_readers(b) >= 8000
]
ge8k_books.sort(
    key=lambda b: (hot_idx.get(b['id'], 10**9), -(eff_readers(b) or 0), b['id'])
)

boot_books = []
for b in ge8k_books[:240]:
    item = dict(b)
    bid = item['id']
    st = (book_dates.get(bid) or {}).get('start')
    if st:
        item['start'] = st
    tr = trends_books.get(bid)
    if tr:
        item['_tRaw'] = tr
    bg = badges.get(bid)
    if bg:
        item['_badges'] = bg
    boot_books.append(item)

category_channels = {}
main_names = set()
for r in cat.get('coverage') or []:
    cname = r.get('category')
    if not cname:
        continue
    category_channels.setdefault(cname, set()).add(r.get('channel'))
    if r.get('kind') == '主分类':
        main_names.add(cname)


def matches_channel(b, ch):
    if not ch:
        return True
    bch = b.get('channel') or ''
    if ch == '女频':
        return bch == '女频'
    return bch == ch or bch == '共用'


def primary_for(b):
    if b.get('primary'):
        return b['primary']
    return [t for t in (b.get('tags') or []) if t in main_names]


def tags_for(b, ch=''):
    names = set()
    for t in list(b.get('tags') or []) + list(primary_for(b)):
        routes = category_channels.get(t)
        if t != '全部分类' and (not ch or not routes or ch in routes):
            names.add(t)
    for c, lst in (b.get('officialTags') or {}).items():
        if not ch or not c or c == ch:
            for t in lst:
                names.add(t)
    return names


cat_counts = {}
tag_counts = {}
for ch_key, ch_val in (('all', ''), ('男频', '男频'), ('女频', '女频')):
    cm = {}
    tm = {}
    for b in ge8k_books:
        if not matches_channel(b, ch_val):
            continue
        for cname in primary_for(b):
            cm[cname] = cm.get(cname, 0) + 1
        for tname in tags_for(b, ch_val):
            tm[tname] = tm.get(tname, 0) + 1
    cat_counts[ch_key] = [[k, v] for k, v in sorted(cm.items(), key=lambda kv: (-kv[1], kv[0]))]
    tag_counts[ch_key] = [[k, v] for k, v in sorted(tm.items(), key=lambda kv: (-kv[1], kv[0]))[:150]]

ge10k_count = sum(1 for b in ge8k_books if (eff_readers(b) or 0) >= 10000)
intro_total_count = sum(1 for b in ge8k_books if b.get('intro'))
scored_count = sum(1 for b in ge8k_books if isinstance(b.get('score'), (int, float)) and b['score'] > 0)
updated_count = sum(1 for b in ge8k_books if isinstance(b.get('lastUpdate'), int) and b['lastUpdate'] > 946684800)
trends_payload['stats']['scoredBooks'] = scored_count
trends_payload['stats']['updatedBooks'] = updated_count
(out / 'data' / 'trends.json.gz').write_bytes(
    gzip.compress(
        json.dumps(trends_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        compresslevel=6,
        mtime=0,
    )
)
boot_payload = {
    'dataVer': data_ver,
    'introChunks': INTRO_CHUNKS,
    'bookBuckets': BOOK_BUCKETS,
    'updated': cat.get('updated'),
    'coverage': cat.get('coverage'),
    'latestDate': latest_date,
    'prevDate': prev_date_str,
    'dates': series_dates,
    'latestRankDate': latest_rank_date,
    'stats': {
        'totalBooks': len(ge8k_books),
        'ge10k': ge10k_count,
        'introTotal': intro_total_count,
        'validCovers': valid_covers,
        'observed': trends_payload['stats']['observed'],
        'paired1': paired1,
        'paired7': paired7,
        'paired30': paired30,
        'wordsPaired1': words_paired1,
        'rankDays': len(win_dates),
        'sweepCount': len(sweep_books),
        'debutCount': len(debut_books),
        'datedBooks': len(slim_book_dates),
        'scoredBooks': scored_count,
        'updatedBooks': updated_count,
    },
    'catCounts': cat_counts,
    'tagCounts': tag_counts,
    'books': boot_books,
}

(out / 'data' / 'boot.json.gz').write_bytes(
    gzip.compress(
        json.dumps(boot_payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
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
            'rankDays': len(all_rank_dates),
            'rankArchiveWeeks': len(kept_rank_dates),
            'trendsBooks': len(trends_books),
            'sweepBooks': len(sweep_books),
            'debutBooks': len(debut_books),
            'badgesBooks': len(badges),
            'extraBooks': len(extra_books),
            'quarantinedCount': len(quarantined_ids),
            'stats': trends_payload['stats'],
            'dataVer': data_ver,
            'trendsBytes': (out / 'data' / 'trends.json.gz').stat().st_size,
            'radarBytes': (out / 'data' / 'radar.json.gz').stat().st_size,
            'bootBytes': (out / 'data' / 'boot.json.gz').stat().st_size,
            'coreBytes': len(core_gz),
            'introBytes': intro_bytes,
            'bookBucketBytesTotal': bucket_bytes_total,
            'bookBucketMaxBytes': bucket_max_bytes,
            'slimCatalogBytes': slim_cat_bytes,
        },
        ensure_ascii=False,
    )
)
