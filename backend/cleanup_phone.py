"""Срок хранения невостребованных фото: пять минут плюс интервал минутной очистки."""
import sqlite3
import time
from pathlib import Path

path = Path(__file__).resolve().parent/'data/photos.sqlite'
if path.exists():
    with sqlite3.connect(path, timeout=10) as db:
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='phone_jobs'").fetchone():
            db.execute('PRAGMA secure_delete=ON')
            old = time.time()-300
            db.execute("UPDATE photo_recognitions SET status='failed' WHERE id IN (SELECT id FROM phone_jobs WHERE created<? AND state IN ('queued','claimed','matching'))", (old,))
            db.execute("UPDATE phone_jobs SET state='failed',image=NULL WHERE created<? AND state IN ('queued','claimed','matching')", (old,))
    with sqlite3.connect(path, timeout=10) as db:
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
