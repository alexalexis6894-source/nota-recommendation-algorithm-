"""Отчёт по воронке соцверсии НОТА из data/events.sqlite (события пишет deploy-photo/events.php).

Запуск на сервере:
  venv/bin/python -m app.funnel            последние 7 дней
  venv/bin/python -m app.funnel --days 30

Считаются уникальные браузеры (случайный id в localStorage), а не нажатия: один человек,
открывший подбор 5 раз, это один «открыл подбор».
Ворота к фазе 1: делятся от 8% создавших группу (shared / group_created) и на одну
публикацию приходится от 1,5 перехода (public_opened / group_published).
"""
import argparse
import sqlite3
import time
from pathlib import Path

# Порядок шагов воронки: от создания группы до заявки, затем петля через публичную ссылку.
STEPS = [
    ('group_created', 'Создали группу'),
    ('group_ranked', 'Расставили приоритет'),
    ('recs_opened', 'Открыли подбор'),
    ('recs_more', 'Нажали «Показать ещё»'),
    ('kit_added', 'Добавили в набор'),
    ('share_opened', 'Открыли «Поделиться»'),
    ('shared', 'Поделились'),
    ('group_published', 'Сделали группу публичной'),
    ('public_opened', 'Открыли публичную группу'),
    ('public_to_app', 'Перешли к себе в НОТА'),
    ('order_sent', 'Отправили заявку'),
]


def summary(path, days=7, now=None):
    """Уникальные браузеры и число событий по шагам за последние days суток."""
    now = time.time() if now is None else now
    since = now - days * 86400
    result = {name: {'label': label, 'visitors': 0, 'events': 0} for name, label in STEPS}
    if not Path(path).exists():
        return {'days': days, 'steps': result, 'share_rate': None, 'opens_per_publication': None}
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        rows = db.execute('SELECT name, COUNT(DISTINCT vid), COUNT(*) FROM events WHERE created_at>=? GROUP BY name',
                          (since,)).fetchall()
    for name, visitors, events in rows:
        if name in result:
            result[name]['visitors'], result[name]['events'] = visitors, events
    created = result['group_created']['visitors']
    published = result['group_published']['events']
    return {
        'days': days,
        'steps': result,
        # Доля создавших группу, кто поделился: ворота к фазе 1 от 8%.
        'share_rate': round(result['shared']['visitors'] / created, 3) if created else None,
        # Переходов по ссылке на одну публикацию: ворота от 1,5.
        'opens_per_publication': round(result['public_opened']['events'] / published, 2) if published else None,
    }


def main():
    parser = argparse.ArgumentParser(description='Воронка соцверсии НОТА')
    parser.add_argument('--days', type=int, default=7)
    parser.add_argument('--db', default=str(Path(__file__).resolve().parents[1] / 'data/events.sqlite'))
    args = parser.parse_args()
    data = summary(args.db, args.days)
    print(f'Воронка за {data["days"]} дн.')
    for name, step in data['steps'].items():
        print(f'{step["label"]:<28} {step["visitors"]:>6} браузеров  {step["events"]:>7} событий  ({name})')
    rate = data['share_rate']
    print('Делятся из создавших группу:', '-' if rate is None else f'{rate * 100:.1f}% (ворота 8%)')
    opens = data['opens_per_publication']
    print('Переходов на публикацию:', '-' if opens is None else f'{opens} (ворота 1,5)')


if __name__ == '__main__':
    main()
