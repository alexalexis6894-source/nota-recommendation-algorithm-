"""Согласование конкретной версии состава. Отдельные права и очередь поставщика."""
import hashlib
import json
import re
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path

SCHEMA = '''
CREATE TABLE IF NOT EXISTS supplier_checks(
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
 fingerprint TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL,
 decided_at REAL, actor_id INTEGER);
CREATE INDEX IF NOT EXISTS supplier_checks_order ON supplier_checks(order_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_checks_pending ON supplier_checks(order_id)
 WHERE state='pending';
CREATE TABLE IF NOT EXISTS supplier_messages(
 check_id TEXT NOT NULL REFERENCES supplier_checks(id), chat_id INTEGER NOT NULL,
 message_id INTEGER, last_try REAL NOT NULL DEFAULT 0,
 PRIMARY KEY(check_id,chat_id));
CREATE TABLE IF NOT EXISTS supplier_notices(
 check_id TEXT NOT NULL REFERENCES supplier_checks(id), chat_id INTEGER NOT NULL,
 message_id INTEGER, last_try REAL NOT NULL DEFAULT 0,
 PRIMARY KEY(check_id,chat_id));
'''
LABELS = {'pending': 'Ожидаем проверки состава', 'approved': 'Состав подтверждён — OK',
          'changes': 'Нужны изменения состава', 'superseded': 'Состав изменён, нужна новая проверка'}


def init_db(db):
    db.executescript(SCHEMA)


def current_check(db, order_id):
    row = db.execute('SELECT state FROM supplier_checks WHERE order_id=? '
                     'ORDER BY created_at DESC, rowid DESC LIMIT 1', (order_id,)).fetchone()
    return row[0] if row else None


def check_label(state):
    return LABELS.get(state, '')


def fingerprint(db, order_id):
    rows = db.execute('SELECT pid,brand,name,volume_ml,price FROM order_items '
                      'WHERE order_id=? ORDER BY rowid', (order_id,)).fetchall()
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()


def request_check(db, order):
    from . import telegram as tg
    cfg = tg.load_config('supplier')
    if not cfg or not tg._bound_chats(db, cfg):
        return 'Сначала подключите чат поставщика в боте НОТА АДМИН'
    db.execute('BEGIN IMMEDIATE')
    status = db.execute("SELECT CASE WHEN paid_at IS NOT NULL THEN 'paid' ELSE status END FROM orders WHERE id=?", (order['id'],)).fetchone()[0]
    if status in ('paid', 'done', 'cancelled'):
        db.rollback()
        return 'Проверка доступна до оплаты и закрытия заявки'
    stamp = fingerprint(db, order['id'])
    previous = db.execute('SELECT id,fingerprint,state FROM supplier_checks WHERE order_id=? '
                          'ORDER BY created_at DESC, rowid DESC LIMIT 1', (order['id'],)).fetchone()
    if previous and previous[1] == stamp and previous[2] in ('pending', 'approved'):
        db.rollback()
        return check_label(previous[2])
    db.execute("UPDATE supplier_checks SET state='superseded' WHERE order_id=? AND state!='superseded'",
               (order['id'],))
    cid = secrets.token_hex(8)
    db.execute('INSERT INTO supplier_checks(id,order_id,fingerprint,state,created_at) VALUES(?,?,?,?,?)',
               (cid, order['id'], stamp, 'pending', time.time()))
    db.executemany('INSERT INTO supplier_messages(check_id,chat_id) VALUES(?,?)',
                   [(cid, chat) for chat in tg._bound_chats(db, cfg)])
    db.commit()
    return 'Состав поставлен в очередь поставщику. Отметить оплату можно в любой момент'


def render_check(db, cid):
    from . import telegram as tg
    row = db.execute('SELECT order_id,state FROM supplier_checks WHERE id=?', (cid,)).fetchone()
    order = tg._load_order(db, order_id=row[0])
    # Поставщику передаём состав, без телефона, бонусов и розничных цен клиента.
    lines = [f'<b>Проверка состава заявки №{order["number"]}</b>']
    for i, item in enumerate(order['items'], 1):
        lines.append(f'{i}. {tg.esc(item["brand"])} — {tg.esc(item["name"])}, {tg._ml(item["volume_ml"])}')
    lines += ['', tg.esc(check_label(row[1])), 'Подтвердите наличие всех позиций и объёмов.']
    return {'text': '\n'.join(lines), 'parse_mode': 'HTML', 'reply_markup': {
        'inline_keyboard': [[{'text': 'OK, состав подтверждаю', 'callback_data': f'sp:{cid}:approved'}],
                            [{'text': 'Нужны изменения', 'callback_data': f'sp:{cid}:changes'}]]}}


def _queue_notices(db, cid):
    from . import telegram as tg
    cfg = tg.load_config()
    if cfg:
        db.executemany('INSERT OR IGNORE INTO supplier_notices(check_id,chat_id) VALUES(?,?)',
                       [(cid, chat) for chat in tg._bound_chats(db, cfg)])


def deliver_pending(db):
    """Отдельный outbox на каждый чат; сбой сети сохраняет отправку для повтора."""
    from . import telegram as tg
    for table, role in (('supplier_messages', 'supplier'), ('supplier_notices', 'manager')):
        cfg = tg.load_config(role)
        if not cfg:
            continue
        rows = db.execute(f'SELECT m.check_id,m.chat_id FROM {table} m '
                          'JOIN supplier_checks c ON c.id=m.check_id '
                          'WHERE m.message_id IS NULL AND m.last_try<? AND c.state '
                          + ("='pending' " if role == 'supplier' else "IN ('approved','changes') ")
                          + 'ORDER BY c.created_at LIMIT 3', (time.time() - tg.CLAIM_LEASE,)).fetchall()
        for cid, chat in rows:
            claimed = db.execute(f'UPDATE {table} SET last_try=? WHERE check_id=? AND chat_id=? '
                                  'AND message_id IS NULL AND last_try<?',
                                  (time.time(), cid, chat, time.time() - tg.CLAIM_LEASE)).rowcount
            db.commit()
            if not claimed:
                continue
            if role == 'supplier':
                response = tg._call(cfg, 'sendMessage', {'chat_id': chat, **render_check(db, cid)})
            else:
                oid = db.execute('SELECT order_id FROM supplier_checks WHERE id=?', (cid,)).fetchone()[0]
                response = tg._send_html(cfg, 'sendMessage', {'chat_id': chat}, tg._load_order(db, order_id=oid))
            if response.get('ok'):
                db.execute(f'UPDATE {table} SET message_id=? WHERE check_id=? AND chat_id=?',
                           ((response.get('result') or {}).get('message_id'), cid, chat))
                db.commit()


def handle_callback(db, cfg, query):
    from . import telegram as tg
    callback_id = query.get('id')
    match = re.fullmatch(r'sp:([a-f0-9]{16}):(approved|changes)', str(query.get('data') or ''))
    message = query.get('message') or {}
    chat_id = (message.get('chat') or {}).get('id')
    user_id = (query.get('from') or {}).get('id')
    if not callback_id:
        return
    if not match or not tg._may_change(db, cfg, user_id) or not tg._is_bound(db, cfg, chat_id):
        tg._answer(cfg, callback_id, 'Нет прав подтверждать состав', alert=True)
        return
    cid, state = match.groups()
    db.execute('BEGIN IMMEDIATE')
    row = db.execute('SELECT order_id,fingerprint,state FROM supplier_checks WHERE id=?', (cid,)).fetchone()
    delivered = db.execute('SELECT message_id FROM supplier_messages WHERE check_id=? AND chat_id=?',
                           (cid, chat_id)).fetchone()
    if not row or not delivered or delivered[0] != message.get('message_id'):
        db.rollback()
        tg._answer(cfg, callback_id, 'Проверка не найдена', alert=True)
        return
    status = db.execute("SELECT CASE WHEN paid_at IS NOT NULL THEN 'paid' ELSE status END FROM orders WHERE id=?", (row[0],)).fetchone()[0]
    if row[2] != 'pending' or status in ('paid', 'done', 'cancelled') or fingerprint(db, row[0]) != row[1]:
        if row[2] == 'pending':
            db.execute("UPDATE supplier_checks SET state='superseded' WHERE id=?", (cid,))
        db.commit()
        tg._answer(cfg, callback_id, 'Проверка уже закрыта или состав изменён', alert=True)
        return
    db.execute('UPDATE supplier_checks SET state=?,decided_at=?,actor_id=? WHERE id=?',
               (state, time.time(), user_id, cid))
    _queue_notices(db, cid)
    db.commit()
    tg._answer(cfg, callback_id, check_label(state))
    tg._call(cfg, 'editMessageText', {'chat_id': chat_id, 'message_id': message['message_id'],
                                    **render_check(db, cid), 'reply_markup': {'inline_keyboard': []}})


def list_checks(db, cfg, chat_id):
    from . import telegram as tg
    if not tg._is_bound(db, cfg, chat_id):
        tg._reply(cfg, chat_id, 'Чат не подключён. Отправьте /start и код подключения.')
        return
    rows = db.execute("SELECT c.id,o.number FROM supplier_checks c JOIN orders o ON o.id=c.order_id "
                      "WHERE c.state='pending' AND o.status NOT IN ('paid','done','cancelled') "
                      'ORDER BY c.created_at DESC LIMIT 10').fetchall()
    tg._reply(cfg, chat_id, '\n'.join(f'№{number}: ожидает проверки' for _, number in rows) or 'Проверок пока нет.')


def manager_command(db, cfg, user_id, chat_id, command, argument):
    from . import telegram as tg
    if not tg._is_bound(db, cfg, chat_id) or not tg._may_change(db, cfg, user_id):
        tg._reply(cfg, chat_id, 'Нет доступа к заявкам')
        return
    parts = argument.split()
    if not parts or not parts[0].isdigit():
        tg._reply(cfg, chat_id, 'Карточка: /order НОМЕР. Замена: /replace НОМЕР ПОЗИЦИЯ PID_АРОМАТА')
        return
    order = tg._load_order(db, number=int(parts[0]))
    if not order:
        tg._reply(cfg, chat_id, 'Заявка не найдена')
        return
    if command == 'replace':
        if len(parts) != 3 or not all(p.isdigit() for p in parts):
            tg._reply(cfg, chat_id, 'Замена: /replace НОМЕР ПОЗИЦИЯ PID_АРОМАТА')
            return
        try:
            replace_item(db, order['id'], int(parts[1]), parts[2])
        except (ValueError, sqlite3.IntegrityError) as error:
            db.rollback()
            tg._reply(cfg, chat_id, tg.esc(str(error)) if isinstance(error, ValueError) else 'Этот аромат уже в заказе')
            return
        order = tg._load_order(db, order_id=order['id'])
    tg._send_html(cfg, 'sendMessage', {'chat_id': chat_id}, order)


def replace_item(db, oid, position, pid, folder=None):
    """Цена из серверного каталога; замена сохраняет порядок и отменяет старое OK."""
    from .orders import Offers, bonus_for
    folder = Path(folder or Path(__file__).resolve().parents[1] / 'data')
    offer = Offers(folder).get(pid)
    if not offer:
        raise ValueError('Аромат недоступен для заказа')
    with closing(sqlite3.connect(f'file:{folder / "catalog.sqlite"}?mode=ro', uri=True)) as catalog:
        row = catalog.execute('SELECT card FROM cards WHERE pid=?', (pid,)).fetchone()
    if not row:
        raise ValueError('Аромат не найден в каталоге')
    card = json.loads(row[0])
    db.execute('BEGIN IMMEDIATE')
    status, spent = db.execute("SELECT CASE WHEN paid_at IS NOT NULL THEN 'paid' ELSE status END,bonus_spent FROM orders WHERE id=?", (oid,)).fetchone()
    if status in ('paid', 'done', 'cancelled'):
        db.rollback()
        raise ValueError('Состав оплаченной или закрытой заявки менять нельзя')
    items = db.execute('SELECT rowid,price FROM order_items WHERE order_id=? ORDER BY rowid', (oid,)).fetchall()
    if not 1 <= position <= len(items):
        db.rollback()
        raise ValueError('Нет такой позиции в заказе')
    db.execute('UPDATE order_items SET pid=?,brand=?,name=?,volume_ml=?,price=? WHERE rowid=?',
               (pid, card.get('brand') or '', card.get('name') or '', offer['ml'], offer['price'], items[position - 1][0]))
    prices = [p for _, p in items]
    prices[position - 1] = offer['price']
    db.execute('UPDATE orders SET total=?,bonus_spent=?,bonus_earned=?,updated_at=? WHERE id=?',
               (sum(prices), min(spent, sum(prices)), bonus_for(prices), time.time(), oid))
    db.execute("UPDATE supplier_checks SET state='superseded' WHERE order_id=? AND state!='superseded'", (oid,))
    db.commit()
