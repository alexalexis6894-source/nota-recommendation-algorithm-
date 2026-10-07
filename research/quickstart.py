"""Быстрый запуск текущего подбора НОТЫ на полном каталоге.

    cd backend && python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt
    python ../research/quickstart.py "Eau Sauvage" Dior --mode close --limit 10

Каталог: backend/data/catalog.sqlite, таблица cards(i, pid, card), в card JSON:
pid, name, brand, rating, votes, accord_weights, note_weights (веса строкой «нота:0..100|…»).
"""
import argparse, json, sqlite3, sys, time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / 'backend'
sys.path.insert(0, str(BACKEND))
from app import groups  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('name'); ap.add_argument('brand')
ap.add_argument('--mode', default='close', choices=['close', 'new'])
ap.add_argument('--limit', type=int, default=10)
a = ap.parse_args()

t = time.time()
db = sqlite3.connect(f"file:{BACKEND / 'data/catalog.sqlite'}?mode=ro", uri=True)
records = [json.loads(card) for (card,) in db.execute('select card from cards')]
print(f'каталог: {len(records)} ароматов за {time.time() - t:.1f} с')

seeds = [r for r in records if r['name'].lower() == a.name.lower() and r['brand'].lower() == a.brand.lower()]
if not seeds:
    sys.exit('Не нашёл такой аромат в каталоге, проверь название и бренд')
t = time.time()
items = groups.recommend(records, seeds[:1], set(), limit=a.limit, mode=a.mode)
print(f'подбор ({a.mode}): {time.time() - t:.1f} с\n')
for it in items:
    print(f"{it.get('pid'):>7}  {it.get('name')} | {it.get('brand')}")
