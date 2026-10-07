"""Опрос Telegram раз в минуту из cron.

Telegram не может достучаться до хостинга REG.RU, поэтому вебхук не работает.
Сервер сам забирает сообщения боту (getUpdates) и досылает неотправленные заявки.
"""
import os
import sqlite3
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root))
os.environ.setdefault('NOTA_TELEGRAM_CONFIG', str(root/'telegram.json'))
from app import telegram


def connect():
    db = sqlite3.connect(root/'data/photos.sqlite', timeout=10)
    db.execute('PRAGMA foreign_keys=ON')
    return db


if (root/'data/photos.sqlite').exists():
    telegram.poll(connect, seconds=55, lock_path=root/'telegram-poll.lock')
