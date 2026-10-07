"""Telegram-бот заявок НОТА: уведомления о новых заявках и смена статуса кнопками.

Как подключить за 3 шага:
1. В @BotFather создать бота (/newbot) и скопировать токен.
2. На Mac выполнить `.venv/bin/python scripts/telegram_setup.py`: скрипт спросит токен
   (один раз, сохранит в ~/.secrets/nota-telegram.json), выложит конфиг на сервер
   с правами 600 и зарегистрирует вебхук. Сервер находит конфиг по переменной
   окружения NOTA_TELEGRAM_CONFIG.
3. Написать боту `/start <код>` (код печатает скрипт) в личке или в рабочей группе.
   После этого новые заявки приходят в этот чат, а `/orders` показывает последние 10.

Устройство. На REG.RU нет постоянного процесса: каждый запрос запускает новый Python.
Поэтому только вебхук (Telegram сам присылает POST) и исходящие вызовы Bot API через
urllib с таймаутом 5 с. Привязанные чаты хранятся в SQLite (telegram_chats), файл
конфига только читается. Ошибки Telegram наружу не пробрасываются: функции
возвращают bool или число и пишут причину в stderr (на сервере это gateway-error.log).
"""
import hmac
import html
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

# FastAPI здесь не импортируется: опрос бота по cron (telegram_poll.py) запускается раз в минуту,
# и импорт фреймворка стоил ~0,5 с процессора на каждый запуск. Маршрут вебхука импортирует
# FastAPI сам, внутри create_router.

API_TIMEOUT = 5
# Москва без перехода на летнее время с 2014 года, поэтому фиксированное смещение
# надёжнее, чем зависеть от наличия базы часовых поясов на хостинге.
MSK = timezone(timedelta(hours=3))
RETRY_WINDOW = 7 * 86400
# Сколько секунд заявка считается «занятой» отправкой: защита от двойной отправки
# двумя параллельными процессами и пауза перед повтором после сбоя.
CLAIM_LEASE = 60
MAX_ITEMS_IN_MESSAGE = 30

STATUSES = {
    'new': 'Новая',
    'in_work': 'В работе',
    'contacted': 'Связались',
    'done': 'Выполнен',
    'cancelled': 'Отменён',
}
BUTTONS = [
    ('in_work', 'Взял в работу'),
    ('contacted', 'Связались'),
    ('done', 'Выполнен'),
    ('cancelled', 'Отменён'),
]
CALLBACK_RE = re.compile(r'^st:(\d{1,9}):([a-z_]{1,20})$')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS telegram_chats(
  chat_id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, added_at REAL);
CREATE TABLE IF NOT EXISTS telegram_outbox(
  order_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, last_try REAL NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_updates(
  update_id INTEGER PRIMARY KEY, received_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS telegram_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
'''


def log(message):
    """Пишет причину в stderr. Токен и секреты сюда никогда не попадают."""
    print(f'[telegram] {message}', file=sys.stderr, flush=True)


# ---------------------------------------------------------------- конфиг

@dataclass
class Config:
    bot_token: str
    webhook_secret: str = ''
    pairing_code: str = ''
    bot_username: str = ''
    chat_ids: list = field(default_factory=list)
    allowed_user_ids: set = field(default_factory=set)


def _int_list(value):
    result = []
    for item in value or []:
        try:
            result.append(int(item))
        except (TypeError, ValueError):
            log('в конфиге пропущен нечисловой идентификатор')
    return result


def load_config():
    """Читает конфиг по пути из NOTA_TELEGRAM_CONFIG. Нет файла или токена: None (бот выключен)."""
    path = os.environ.get('NOTA_TELEGRAM_CONFIG')
    if not path:
        return None
    file = Path(path)
    try:
        mode = file.stat().st_mode
    except FileNotFoundError:
        return None
    except OSError as error:
        log(f'конфиг недоступен: {type(error).__name__}')
        return None
    if mode & 0o077:
        # Как в passenger_wsgi для anthropic.env: доступный другим файл с токеном не читаем.
        log('конфиг отклонён: права должны быть 600')
        return None
    try:
        data = json.loads(file.read_text())
    except (OSError, ValueError) as error:
        log(f'конфиг не прочитан: {type(error).__name__}')
        return None
    if not isinstance(data, dict):
        return None
    token = str(data.get('bot_token') or '').strip()
    if not token:
        return None
    return Config(
        bot_token=token,
        webhook_secret=str(data.get('webhook_secret') or ''),
        pairing_code=str(data.get('pairing_code') or ''),
        bot_username=str(data.get('bot_username') or '').lstrip('@'),
        chat_ids=_int_list(data.get('chat_ids')),
        allowed_user_ids=set(_int_list(data.get('allowed_user_ids'))),
    )


# ---------------------------------------------------------------- Bot API

# Если сеть до Telegram недоступна, не ждём таймаут на каждом следующем вызове
# в этом же процессе: оформление заявки не должно тормозить из-за Telegram.
_down_until = 0.0


def bot_api(token, method, payload):
    """Вызов Bot API. Никогда не бросает исключений, возвращает ответ Telegram как dict.

    При сетевой ошибке: {'ok': False, 'error_code': 0, 'description': ...}.
    В тестах эта функция подменяется, сеть не нужна.
    """
    global _down_until
    if time.monotonic() < _down_until:
        return {'ok': False, 'error_code': 0, 'description': 'Telegram недоступен, пропуск'}
    request = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/{method}',
        data=json.dumps(payload, ensure_ascii=False).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        # Длинный опрос getUpdates держит соединение до payload['timeout'] секунд.
        wait = API_TIMEOUT + (int(payload.get('timeout') or 0) if method == 'getUpdates' else 0)
        with urllib.request.urlopen(request, timeout=wait) as response:
            return json.loads(response.read(1_000_000))
    except urllib.error.HTTPError as error:
        # 400/403/429: Telegram отвечает JSON с описанием, его и возвращаем.
        try:
            return json.loads(error.read(100_000))
        except Exception:
            return {'ok': False, 'error_code': error.code, 'description': f'HTTP {error.code}'}
    except Exception as error:
        # В текст ошибки не включаем адрес запроса: в нём токен.
        _down_until = time.monotonic() + 60
        return {'ok': False, 'error_code': 0, 'description': f'сеть: {type(error).__name__}'}


def _call(cfg, method, payload):
    response = bot_api(cfg.bot_token, method, payload)
    if not isinstance(response, dict):
        response = {'ok': False, 'error_code': 0, 'description': 'непонятный ответ'}
    if not response.get('ok'):
        log(f'{method}: {response.get("error_code")} {str(response.get("description", ""))[:200]}')
    return response


# ---------------------------------------------------------------- база

def init_db(db):
    db.executescript(SCHEMA)
    # Колонки бонусов, как в orders.add_bonus_columns: опрос может открыть базу раньше сайта.
    # Свой код, а не импорт orders, чтобы ежеминутный опрос не загружал fastapi.
    columns = {row[1] for row in db.execute('PRAGMA table_info(orders)')}
    for column in ('bonus_earned', 'bonus_spent'):
        if columns and column not in columns:
            db.execute(f'ALTER TABLE orders ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0')


def _bound_chats(db, cfg):
    """Чаты для заявок: из конфига плюс привязанные командой /start."""
    found = list(cfg.chat_ids)
    for (chat_id,) in db.execute('SELECT chat_id FROM telegram_chats ORDER BY added_at'):
        if chat_id not in found:
            found.append(chat_id)
    return found


def _load_order(db, order_id=None, number=None):
    column, value = ('id', order_id) if order_id is not None else ('number', number)
    row = db.execute(
        f'SELECT id, number, phone, name, comment, total, status, created_at, notified_at, '
        f'bonus_earned, bonus_spent FROM orders WHERE {column}=?', (value,)).fetchone()
    if not row:
        return None
    order = dict(zip(('id', 'number', 'phone', 'name', 'comment', 'total', 'status',
                      'created_at', 'notified_at', 'bonus_earned', 'bonus_spent'), row))
    order['items'] = [
        dict(zip(('brand', 'name', 'volume_ml', 'price', 'group_name'), item))
        for item in db.execute(
            'SELECT brand, name, volume_ml, price, group_name FROM order_items '
            'WHERE order_id=? ORDER BY rowid', (order['id'],))
    ]
    return order


def _claim(db, order_id):
    """Атомарно занимает заявку для отправки. False, если её уже шлёт другой процесс."""
    now = time.time()
    cursor = db.execute(
        'INSERT INTO telegram_outbox(order_id, attempts, last_try) VALUES(?, 1, ?) '
        'ON CONFLICT(order_id) DO UPDATE SET attempts=attempts+1, last_try=excluded.last_try '
        'WHERE telegram_outbox.last_try < ?', (order_id, now, now - CLAIM_LEASE))
    db.commit()
    return cursor.rowcount == 1


# ---------------------------------------------------------------- текст сообщения

def esc(value):
    return html.escape(str(value if value is not None else ''), quote=True)


def _rub(value):
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return esc(value)
    return f'{number:,}'.replace(',', ' ') + ' ₽'


def _ml(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return esc(value)
    text = f'{number:g}'.replace('.', ',')
    return f'{text} мл'


def _phone_view(phone):
    digits = re.sub(r'\D', '', str(phone or ''))
    if len(digits) == 11 and digits[0] == '7':
        return f'+7 {digits[1:4]} {digits[4:7]}-{digits[7:9]}-{digits[9:11]}'
    return str(phone or '')


def _phone_html(phone, link):
    view = esc(_phone_view(phone))
    clean = str(phone or '')
    if link and re.fullmatch(r'\+?\d{7,15}', clean):
        return f'<a href="tel:{esc(clean)}">{view}</a>'
    # Без ссылки Telegram сам распознаёт номер в тексте и делает его кликабельным.
    return esc(clean) if clean else '-'


def _moscow(timestamp):
    try:
        return datetime.fromtimestamp(float(timestamp), MSK).strftime('%d.%m.%Y %H:%M')
    except (TypeError, ValueError, OverflowError, OSError):
        return '-'


def _cut(value, limit):
    text = str(value or '').strip()
    return text if len(text) <= limit else text[:limit - 1] + '…'


def render_order(order, link=True, actor=None):
    """HTML-текст заявки для parse_mode HTML. Все данные из базы проходят через esc()."""
    status = STATUSES.get(order.get('status'), order.get('status') or '')
    lines = [f'<b>Заявка №{esc(order["number"])}</b>',
             f'Телефон: {_phone_html(order.get("phone"), link)}']
    if order.get('name'):
        lines.append(f'Имя: {esc(_cut(order["name"], 100))}')
    if order.get('comment'):
        lines.append(f'Комментарий: {esc(_cut(order["comment"], 600))}')
    lines += ['', '<b>Состав:</b>']
    items = order.get('items') or []
    for index, item in enumerate(items[:MAX_ITEMS_IN_MESSAGE], 1):
        lines.append(f'{index}. {esc(_cut(item["brand"], 80))} - {esc(_cut(item["name"], 120))}, '
                     f'{_ml(item["volume_ml"])} - {_rub(item["price"])}')
    if len(items) > MAX_ITEMS_IN_MESSAGE:
        lines.append(f'и ещё {len(items) - MAX_ITEMS_IN_MESSAGE} поз.')
    if not items:
        lines.append('нет позиций')
    # Наборы по 5 и остаток: «Экстра + Стандарт» для 8 пробников.
    if items:
        sets = ['Экстра'] * (len(items) // 5) + (['Стандарт'] if len(items) % 5 == 3 else [])
        lines += ['', f'Набор: {" + ".join(sets) or "без набора"} ({len(items)} шт.)']
    spent, earned = order.get('bonus_spent') or 0, order.get('bonus_earned') or 0
    if spent:
        lines += ['', f'Пробники: {_rub(order.get("total"))}', f'Бонусы: -{_rub(spent)}',
                  f'<b>К оплате: {_rub((order.get("total") or 0) - spent)}</b>']
    else:
        lines += ['', f'<b>Итого: {_rub(order.get("total"))}</b>']
    if earned:
        lines.append(f'Бонус клиенту: {_rub(earned)}, станет доступен после статуса «Выполнен»')
    lines += [
              f'Создана: {_moscow(order.get("created_at"))} МСК',
              f'Статус: <b>{esc(status)}</b>']
    if actor:
        lines.append(f'Изменил: {esc(_cut(actor, 60))}')
    return '\n'.join(lines)


def keyboard(order):
    current = order.get('status')
    buttons = [{'text': ('✓ ' if code == current else '') + label,
                'callback_data': f'st:{order["number"]}:{code}'} for code, label in BUTTONS]
    return {'inline_keyboard': [buttons[:2], buttons[2:]]}


def _is_entity_error(response):
    description = str(response.get('description', '')).lower()
    return response.get('error_code') == 400 and ('entit' in description or 'url' in description)


def _send_html(cfg, method, base, order, actor=None):
    """Отправка с телефоном-ссылкой tel:. Если Telegram не принял ссылку, повтор без неё."""
    payload = {**base, 'text': render_order(order, True, actor), 'parse_mode': 'HTML',
               'reply_markup': keyboard(order), 'disable_web_page_preview': True}
    response = _call(cfg, method, payload)
    if not response.get('ok') and _is_entity_error(response):
        payload['text'] = render_order(order, False, actor)
        response = _call(cfg, method, payload)
    return response


# ---------------------------------------------------------------- уведомления

def notify_order(db, order_id) -> bool:
    """Отправляет заявку во все привязанные чаты и сохраняет notified_at и message_id.

    db: открытое соединение sqlite3 (из connect()). Функция сама делает commit, поэтому
    вызывать её после записи заявки. Исключений наружу не бросает.
    """
    try:
        cfg = load_config()
        if not cfg:
            return False
        init_db(db)
        order = _load_order(db, order_id=order_id)
        if not order:
            log('заявка для уведомления не найдена')
            return False
        if order.get('notified_at'):
            return True
        chats = _bound_chats(db, cfg)
        if not chats:
            log('нет привязанных чатов: отправьте боту /start <код>')
            return False
        if not _claim(db, order_id):
            return False
        first = None
        for chat_id in chats:
            response = _send_to_chat(db, cfg, chat_id, order)
            if response.get('ok') and first is None:
                result = response.get('result') or {}
                first = ((result.get('chat') or {}).get('id', chat_id), result.get('message_id'))
        if first is None:
            # Отметка в telegram_outbox остаётся: повтор через retry_pending не раньше CLAIM_LEASE.
            return False
        now = time.time()
        db.execute('UPDATE orders SET notified_at=?, tg_chat_id=?, tg_message_id=? WHERE id=?',
                   (now, first[0], first[1], order_id))
        db.commit()
        return True
    except Exception as error:
        log(f'notify_order: {type(error).__name__}: {error}')
        return False


def _send_to_chat(db, cfg, chat_id, order):
    response = _send_html(cfg, 'sendMessage', {'chat_id': chat_id}, order)
    if response.get('ok'):
        return response
    migrated = (response.get('parameters') or {}).get('migrate_to_chat_id')
    if migrated:
        # Группа стала супергруппой и сменила id: переносим привязку и повторяем.
        db.execute('UPDATE OR REPLACE telegram_chats SET chat_id=? WHERE chat_id=?', (migrated, chat_id))
        db.commit()
        return _send_html(cfg, 'sendMessage', {'chat_id': migrated}, order)
    if response.get('error_code') == 403:
        # Бота удалили из чата или заблокировали: привязку снимаем, чтобы не стучаться зря.
        db.execute('DELETE FROM telegram_chats WHERE chat_id=?', (chat_id,))
        db.commit()
    return response


def retry_pending(db, limit=3) -> int:
    """Досылает заявки без notified_at не старше 7 дней. Возвращает число отправленных."""
    try:
        if not load_config():
            return 0
        init_db(db)
        now = time.time()
        rows = db.execute(
            'SELECT o.id FROM orders o LEFT JOIN telegram_outbox t ON t.order_id=o.id '
            'WHERE o.notified_at IS NULL AND o.created_at>=? '
            'AND (t.last_try IS NULL OR t.last_try<?) ORDER BY o.created_at LIMIT ?',
            (now - RETRY_WINDOW, now - CLAIM_LEASE, max(0, int(limit)))).fetchall()
        sent = 0
        for (order_id,) in rows:
            if notify_order(db, order_id):
                sent += 1
        return sent
    except Exception as error:
        log(f'retry_pending: {type(error).__name__}: {error}')
        return 0


# ---------------------------------------------------------------- вебхук

def _secret_ok(cfg, header):
    if not cfg or not cfg.webhook_secret or not header:
        return False
    return hmac.compare_digest(header.encode('utf-8', 'replace'), cfg.webhook_secret.encode())


def _chat_title(chat, user):
    title = chat.get('title') or ' '.join(
        part for part in ((user or {}).get('first_name'), (user or {}).get('last_name')) if part)
    return _cut(title or chat.get('username') or str(chat.get('id')), 100)


def _is_bound(db, cfg, chat_id):
    if chat_id in cfg.chat_ids:
        return True
    return db.execute('SELECT 1 FROM telegram_chats WHERE chat_id=?', (chat_id,)).fetchone() is not None


def _reply(cfg, chat_id, text):
    _call(cfg, 'sendMessage', {'chat_id': chat_id, 'text': text, 'parse_mode': 'HTML',
                               'disable_web_page_preview': True})


def _handle_message(db, cfg, message):
    text = message.get('text')
    chat = message.get('chat') or {}
    user = message.get('from') or {}
    chat_id = chat.get('id')
    if not isinstance(text, str) or not text.startswith('/') or not isinstance(chat_id, int):
        return
    head, _, rest = text.partition(' ')
    command, _, mention = head[1:].partition('@')
    command = command.lower()
    if mention and cfg.bot_username and mention.lower() != cfg.bot_username.lower():
        return  # команда адресована другому боту в группе
    argument = rest.strip()
    if command == 'start':
        _handle_start(db, cfg, chat, user, argument)
    elif command == 'orders':
        _handle_orders(db, cfg, chat_id)


def _handle_start(db, cfg, chat, user, code):
    chat_id = chat['id']
    if not code:
        if _is_bound(db, cfg, chat_id):
            _reply(cfg, chat_id, 'Этот чат уже получает заявки НОТА. Последние заявки: /orders')
        else:
            _reply(cfg, chat_id, 'Здравствуйте! Это служебный бот заявок НОТА. '
                                 'Чтобы получать заявки в этот чат, отправьте /start и код подключения.')
        return
    expected = cfg.pairing_code
    if not expected or not hmac.compare_digest(code.encode('utf-8', 'replace'), expected.encode()):
        _reply(cfg, chat_id, 'Код не подошёл. Проверьте код подключения у администратора НОТА.')
        return
    user_id = user.get('id') if isinstance(user.get('id'), int) else None
    db.execute('INSERT INTO telegram_chats(chat_id, user_id, title, added_at) VALUES(?,?,?,?) '
               'ON CONFLICT(chat_id) DO UPDATE SET user_id=excluded.user_id, title=excluded.title',
               (chat_id, user_id, _chat_title(chat, user), time.time()))
    db.commit()
    _reply(cfg, chat_id, 'Готово: новые заявки НОТА будут приходить в этот чат. '
                         'Последние заявки: /orders')


def _handle_orders(db, cfg, chat_id):
    if not _is_bound(db, cfg, chat_id):
        _reply(cfg, chat_id, 'Чат не подключён. Отправьте /start и код подключения.')
        return
    rows = db.execute('SELECT number, phone, total - bonus_spent, status, created_at FROM orders '
                      'ORDER BY created_at DESC, number DESC LIMIT 10').fetchall()
    if not rows:
        _reply(cfg, chat_id, 'Заявок пока нет.')
        return
    lines = ['<b>Последние заявки:</b>']
    for number, phone, total, status, created_at in rows:
        lines.append(f'№{esc(number)} · {_moscow(created_at)} · {_rub(total)} · '
                     f'{esc(phone)} · {esc(STATUSES.get(status, status))}')
    _reply(cfg, chat_id, '\n'.join(lines))


def _may_change(db, cfg, user_id):
    """Менять статус могут allowed_user_ids и те, кто привязывал чат кодом."""
    if not isinstance(user_id, int):
        return False
    if user_id in cfg.allowed_user_ids:
        return True
    return db.execute('SELECT 1 FROM telegram_chats WHERE user_id=?', (user_id,)).fetchone() is not None


def _answer(cfg, callback_id, text, alert=False):
    _call(cfg, 'answerCallbackQuery', {'callback_query_id': callback_id, 'text': text,
                                       'show_alert': alert})


def _handle_callback(db, cfg, query):
    callback_id = query.get('id')
    if not callback_id:
        return
    user = query.get('from') or {}
    match = CALLBACK_RE.match(str(query.get('data') or ''))
    if not match or match.group(2) not in dict(BUTTONS):
        _answer(cfg, callback_id, 'Кнопка устарела')
        return
    if not _may_change(db, cfg, user.get('id')):
        _answer(cfg, callback_id, 'Нет прав менять статус заявки', alert=True)
        return
    number, status = int(match.group(1)), match.group(2)
    order = _load_order(db, number=number)
    if not order:
        _answer(cfg, callback_id, 'Заявка не найдена', alert=True)
        return
    if order['status'] == status:
        _answer(cfg, callback_id, f'Уже: {STATUSES[status]}')
        return
    db.execute('UPDATE orders SET status=?, updated_at=? WHERE id=?', (status, time.time(), order['id']))
    db.commit()
    order['status'] = status
    message = query.get('message') or {}
    chat_id = (message.get('chat') or {}).get('id')
    if isinstance(chat_id, int) and message.get('message_id'):
        actor = ' '.join(p for p in (user.get('first_name'), user.get('last_name')) if p) \
            or user.get('username') or str(user.get('id'))
        _send_html(cfg, 'editMessageText',
                   {'chat_id': chat_id, 'message_id': message['message_id']}, order, actor=actor)
    _answer(cfg, callback_id, f'Статус: {STATUSES[status]}')


def handle_update(connect, cfg, update):
    """Обработка одного обновления Telegram. Неизвестные типы молча пропускаются."""
    if not isinstance(update, dict):
        return
    update_id = update.get('update_id')
    with closing(connect()) as db:
        init_db(db)
        if isinstance(update_id, int):
            # Telegram может прислать то же обновление повторно: второй раз не выполняем.
            try:
                db.execute('INSERT INTO telegram_updates VALUES(?,?)', (update_id, time.time()))
            except sqlite3.IntegrityError:
                return
            db.execute('DELETE FROM telegram_updates WHERE received_at<?', (time.time() - 2 * 86400,))
            db.commit()
        if isinstance(update.get('message'), dict):
            _handle_message(db, cfg, update['message'])
        elif isinstance(update.get('callback_query'), dict):
            _handle_callback(db, cfg, update['callback_query'])
        db.commit()


def poll(connect, seconds=55, lock_path=None) -> int:
    """Опрос Telegram для хостинга, до которого Telegram не может достучаться.

    На REG.RU входящие соединения от Telegram не доходят (вебхук: Connection timed out),
    а исходящие к api.telegram.org работают. Поэтому cron раз в минуту запускает этот опрос:
    длинные запросы getUpdates в течение seconds секунд, ответ на кнопку приходит за 1-2 с.
    После каждого запроса отправляются новые заявки: в чат они попадают за 10-15 с.
    Возвращает число обработанных обновлений.
    """
    cfg = load_config()
    if not cfg:
        return 0
    lock = None
    if lock_path:
        import fcntl
        lock = open(lock_path, 'w')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            # Предыдущий запуск ещё работает: два опроса одновременно Telegram не разрешает.
            lock.close()
            return 0
    try:
        with closing(connect()) as db:
            init_db(db)
            row = db.execute("SELECT value FROM telegram_state WHERE key='offset'").fetchone()
            db.commit()
        offset = int(row[0]) if row else 0
        handled, webhook_cleared = 0, False
        deadline = time.monotonic() + seconds
        while deadline - time.monotonic() > 3:
            # 10 с: заодно так часто досылаются новые заявки.
            wait = int(max(0, min(10, deadline - time.monotonic() - 3)))
            response = _call(cfg, 'getUpdates', {'offset': offset, 'timeout': wait,
                                                 'allowed_updates': ['message', 'callback_query']})
            if not response.get('ok'):
                if response.get('error_code') == 409 and not webhook_cleared:
                    # Установлен вебхук: при нём getUpdates запрещён, снимаем его, очередь сохраняется.
                    _call(cfg, 'deleteWebhook', {'drop_pending_updates': False})
                    webhook_cleared = True
                    continue
                time.sleep(min(5, max(0, deadline - time.monotonic())))
                continue
            for update in response.get('result') or []:
                try:
                    handle_update(connect, cfg, update)
                except Exception as error:
                    log(f'опрос: {type(error).__name__}: {error}')
                if isinstance(update, dict) and isinstance(update.get('update_id'), int):
                    offset = max(offset, update['update_id'] + 1)
                handled += 1
            with closing(connect()) as db:
                db.execute("INSERT INTO telegram_state VALUES('offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                           (str(offset),))
                db.commit()
                retry_pending(db, limit=3)
        return handled
    finally:
        if lock:
            lock.close()


def create_router(connect):
    """Маршрут POST /v1/telegram/webhook. connect: фабрика соединений sqlite3 из create_app."""
    from fastapi import APIRouter, Request
    from fastapi.responses import JSONResponse
    from starlette.concurrency import run_in_threadpool
    try:
        with closing(connect()) as db:
            init_db(db)
            db.commit()
    except Exception as error:
        log(f'таблицы бота не созданы: {type(error).__name__}')
    router = APIRouter(prefix='/v1')

    @router.post('/telegram/webhook')
    async def webhook(request: Request):
        cfg = load_config()
        if not _secret_ok(cfg, request.headers.get('x-telegram-bot-api-secret-token', '')):
            return JSONResponse({'detail': 'Доступ запрещён'}, status_code=403)
        try:
            update = json.loads(await request.body() or b'null')
        except ValueError:
            return {'ok': True}
        try:
            await run_in_threadpool(handle_update, connect, cfg, update)
        except Exception as error:
            # Telegram не должен повторять обновление из-за нашей ошибки: ответ всё равно 200.
            log(f'webhook: {type(error).__name__}: {error}')
        return {'ok': True}

    return router
