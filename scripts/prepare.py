"""Prepare the public date index and exact-date comparisons from measured observations."""
import gzip
import json
import shutil
import sys
from datetime import date, timedelta
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / 'history').mkdir(exist_ok=True)
(out / 'data').mkdir(exist_ok=True)
if out.resolve() != Path.cwd():
    shutil.copytree('assets', out/'assets', dirs_exist_ok=True)
    if Path('data/book-dates.json.gz').exists():
        shutil.copyfile('data/book-dates.json.gz', out/'data/book-dates.json.gz')
if out.resolve() != Path.cwd() and Path('data/hot.json').exists():
    shutil.copyfile('data/hot.json', out/'data/hot.json')
files = sorted(Path('history').glob('????-??-??.json.gz'), reverse=True)[:90]
measures = {}
dates = []
for file in files:
    with gzip.open(file) as f:
        s = json.load(f)
    if not any(g['ok'] for g in s['scopes']) and not any(g.get('rows') for g in s.get('boards', {}).values()):
        continue
    day = s['date']
    dates.append(day)
    target = out/'history'/file.name
    if target.resolve() != file.resolve():
        shutil.copyfile(file, target)
    rows = {}
    def record(b, observed):
        if isinstance(b.get('readers'), int) and observed >= rows.get(b['id'], ('', 0))[0]:
            rows[b['id']] = (observed, b['readers'])
    for b in s['catalogObservations']:
        record(b, b['observed'])
    for group in [*s['scopes'], *s.get('boards', {}).values()]:
        for b in group.get('rows', []):
            record(b, group['observed'])
    measures[day] = rows
(out/'history/index.json').write_text(json.dumps(dates))
for day in dates:
    past = [measures.get(str(date.fromisoformat(day)-timedelta(days=n)), {}) for n in (1,7,30)]
    comparisons = {key:[p[key][1] if key in p else None for p in past]
                   for key in measures[day] if any(key in p for p in past)}
    with gzip.open(out/'history'/(day+'.comparisons.gz'), 'wb') as f:
        f.write(json.dumps(comparisons,separators=(',',':')).encode())


if dates:
    latest = measures[dates[0]]
    yesterday = measures.get(str(date.fromisoformat(dates[0])-timedelta(days=1)), {})
    with gzip.open(out/'history/latest-readers.gz','wb') as f:
        f.write(json.dumps({key:[at,count,yesterday.get(key,('',None))[1]]
                            for key,(at,count) in latest.items()},separators=(',',':')).encode())
