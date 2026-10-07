"""Заявки на набор отливантов: клиент оставляет телефон, команда перезванивает.

Цены и объёмы берутся только с сервера из data/offers.json (собирает
growth-lab/pricing/build_offers.py: отливант 5 мл, нет 5 мл - 10 мл, нет и его - 1-3 мл,
цена = закупка у поставщика + 50%). Цене из браузера не доверяем.
Уведомление в Telegram отправляет фоновый опрос (deploy-photo/telegram_poll.py, cron
раз в минуту, проверка каждые 10 с): связь хостинга с Telegram нестабильна, и отправка
прямо в запросе задерживала ответ клиенту до 6 с.
"""
import json
import re
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

PER_SESSION_DAY = 3      # заявок с одной сессии за сутки
PER_SERVICE_DAY = 300    # всего заявок за сутки, защита от перебора

# Наборы: Стандарт на 3 пробника и Экстра на 5. Пробники идут в наборы по порядку добавления:
# первые 5 это первый набор, следующие 5 второй. Заявка уходит, только когда последний набор
# собран ровно на 3 или на 5, то есть 3, 5, 8, 10, 13 или 15 пробников.
STANDARD, EXTRA = 3, 5
MAX_KIT = 15
# За каждый собранный Экстра клиент получает 15% его суммы бонусами на следующий заказ.
# Бонус становится доступен, когда заявку отметили «Выполнен»; отменённая заявка бонус не даёт,
# а списанные в ней бонусы возвращаются.
BONUS_PERCENT = 15


def kit_ready(count):
    return count > 0 and count % EXTRA in (0, STANDARD)


def bonus_for(prices):
    """15% суммы каждого полного набора Экстра, в рублях с округлением вниз."""
    return sum(sum(prices[i:i + EXTRA]) * BONUS_PERCENT // 100
               for i in range(0, len(prices) - EXTRA + 1, EXTRA))


def bonus_balance(db, user):
    """available: можно списать сейчас; pending: начислено по заявкам, которые ещё не выполнены."""
    earned, spent, pending = db.execute(
        '''SELECT COALESCE(SUM(CASE WHEN status='done' THEN bonus_earned END),0),
                  COALESCE(SUM(CASE WHEN status!='cancelled' THEN bonus_spent END),0),
                  COALESCE(SUM(CASE WHEN status NOT IN ('done','cancelled') THEN bonus_earned END),0)
           FROM orders WHERE owner=?''', (user,)).fetchone()
    return {'available': max(earned - spent, 0), 'pending': pending, 'percent': BONUS_PERCENT}


def init_db(connect):
    with connect() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS orders(
          id TEXT PRIMARY KEY, number INTEGER UNIQUE NOT NULL,
          owner TEXT, phone TEXT NOT NULL, name TEXT, comment TEXT,
          total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new',
          created_at REAL NOT NULL, updated_at REAL NOT NULL,
          notified_at REAL, tg_chat_id INTEGER, tg_message_id INTEGER);
        CREATE INDEX IF NOT EXISTS orders_owner ON orders(owner);
        CREATE TABLE IF NOT EXISTS order_items(
          order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          pid TEXT NOT NULL, brand TEXT NOT NULL, name TEXT NOT NULL,
          volume_ml REAL NOT NULL, price INTEGER NOT NULL, group_name TEXT,
          PRIMARY KEY(order_id, pid));
        ''')
        add_bonus_columns(db)


def add_bonus_columns(db):
    """Бонусы появились позже таблицы заявок: старые базы получают колонки с нулями.
    Вызывают и сайт, и фоновый опрос Telegram, кто бы ни открыл базу первым."""
    columns = {row[1] for row in db.execute('PRAGMA table_info(orders)')}
    for column in ('bonus_earned', 'bonus_spent'):
        if columns and column not in columns:
            db.execute(f'ALTER TABLE orders ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0')


class Offers:
    """pid -> {'ml': 5, 'price': 1140}. Файл читается один раз за процесс."""

    def __init__(self, folder):
        self.path = Path(folder) / 'offers.json'
        self._data = None

    def all(self):
        if self._data is None:
            try:
                raw = json.loads(self.path.read_text(encoding='utf-8'))
                self._data = {str(pid): {'ml': float(o['ml']), 'price': int(o['price'])}
                              for pid, o in raw.items() if float(o['ml']) > 0 and int(o['price']) > 0}
            except (OSError, ValueError, KeyError, TypeError):
                self._data = {}
        return self._data

    def get(self, pid):
        return self.all().get(str(pid))


def public_offer(offer):
    # Объём клиент видит всегда: «5 мл», «10 мл», «3 мл».
    if not offer:
        return None
    return {'volume_ml': offer['ml'], 'volume': f"{offer['ml']:g} мл", 'price': offer['price']}


def normalize_phone(text):
    """Российский номер в виде +79991234567 или None."""
    digits = re.sub(r'\D', '', text or '')
    if len(digits) == 11 and digits[0] in '78':
        digits = digits[1:]
    if len(digits) != 10 or digits[0] not in '3489':
        return None
    return '+7' + digits


class OrderInput(BaseModel):
    phone: str = Field(min_length=5, max_length=30)
    name: str = Field(default='', max_length=60)
    comment: str = Field(default='', max_length=300)
    consent: bool = False


def create_router(owner, connect, get_catalog, offers):
    router = APIRouter(prefix='/v1')

    @router.post('/orders', status_code=201)
    def create_order(body: OrderInput, user=Depends(owner)):
        if not body.consent:
            raise HTTPException(422, 'Нужно согласие на обработку телефона')
        phone = normalize_phone(body.phone)
        if not phone:
            raise HTTPException(422, 'Проверьте номер телефона: нужен российский номер из 10 цифр после +7')
        now = time.time()
        cat = get_catalog()
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM orders WHERE owner=? AND created_at>?', (user, now - 86400)).fetchone()[0] >= PER_SESSION_DAY:
                raise HTTPException(429, 'Вы уже отправили несколько заявок сегодня. Мы свяжемся с вами')
            if db.execute('SELECT COUNT(*) FROM orders WHERE created_at>?', (now - 86400,)).fetchone()[0] >= PER_SERVICE_DAY:
                raise HTTPException(429, 'Сейчас много заявок. Попробуйте позже')
            rows = db.execute('''SELECT s.pid, g.name FROM sample_selection s LEFT JOIN scent_groups g ON s.group_id=g.id
                                 WHERE s.owner=? ORDER BY s.created_at''', (user,)).fetchall()
            items, missing = [], []
            for pid, group_name in rows:
                offer = offers.get(pid)
                if not offer or pid not in cat.index:
                    missing.append(pid)
                    continue
                card = cat.summary(cat.index[pid])
                items.append((pid, card.get('brand') or '', card.get('name') or '', offer['ml'], offer['price'], group_name))
            if not items:
                raise HTTPException(422, 'В наборе нет ароматов, которые сейчас можно заказать')
            if not kit_ready(len(items)):
                raise HTTPException(422, 'Заявка оформляется набором из 3 или 5 пробников')
            order_id = secrets.token_urlsafe(12)
            number = db.execute('SELECT COALESCE(MAX(number), 0) + 1 FROM orders').fetchone()[0]
            total = sum(i[4] for i in items)
            earned = bonus_for([i[4] for i in items])
            spent = min(bonus_balance(db, user)['available'], total)
            db.execute('INSERT INTO orders(id,number,owner,phone,name,comment,total,status,created_at,updated_at,bonus_earned,bonus_spent) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                       (order_id, number, user, phone, body.name.strip() or None, body.comment.strip() or None, total, 'new', now, now, earned, spent))
            db.executemany('INSERT INTO order_items VALUES (?,?,?,?,?,?,?)', [(order_id, *i) for i in items])
            # Заказанные ароматы уходят из набора, недоступные остаются.
            db.executemany('DELETE FROM sample_selection WHERE owner=? AND pid=?', [(user, i[0]) for i in items])
        return {'number': number, 'total': total, 'status': 'new', 'phone': phone,
                'bonus_spent': spent, 'bonus_earned': earned, 'to_pay': total - spent,
                'items': [{'pid': i[0], 'brand': i[1], 'name': i[2], 'volume': f'{i[3]:g} мл', 'price': i[4]} for i in items],
                'skipped': missing}

    @router.get('/orders')
    def my_orders(user=Depends(owner)):
        with connect() as db:
            rows = db.execute('SELECT id, number, total, status, created_at, bonus_earned, bonus_spent FROM orders WHERE owner=? ORDER BY created_at DESC LIMIT 20', (user,)).fetchall()
            result = []
            for oid, number, total, status, created, earned, spent in rows:
                items = db.execute('SELECT brand, name, volume_ml, price FROM order_items WHERE order_id=?', (oid,)).fetchall()
                result.append({'number': number, 'total': total, 'status': status, 'created_at': created,
                               'bonus_earned': earned, 'bonus_spent': spent, 'to_pay': total - spent,
                               'items': [{'brand': b, 'name': n, 'volume': f'{v:g} мл', 'price': p} for b, n, v, p in items]})
        return {'orders': result, 'bonus': bonus_balance(db, user)}

    return router
