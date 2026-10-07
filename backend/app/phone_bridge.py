"""Личная очередь с телефона на Mac. Подписка и её авторизация остаются на Mac."""
import base64
import hashlib
import json
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field


class Unlock(BaseModel):
    invite: str = Field(min_length=32, max_length=128)


class Finished(BaseModel):
    lease: str = Field(min_length=32, max_length=128)
    data: dict | None = None
    usage: dict = Field(default_factory=dict)
    model: str = ''
    failed: bool = False


class PhoneBridge:
    def __init__(self, config_path, connect, get_catalog):
        self.config = json.loads(Path(config_path).read_text())
        self.connect = connect
        self.get_catalog = get_catalog
        with connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS phone_access(owner TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS phone_invites(hash TEXT PRIMARY KEY, expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS phone_activity(id INTEGER PRIMARY KEY, seen REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS phone_worker(id INTEGER PRIMARY KEY, seen REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS phone_jobs(id TEXT PRIMARY KEY REFERENCES photo_recognitions(id) ON DELETE CASCADE,
                image BLOB, state TEXT NOT NULL, lease TEXT, created REAL NOT NULL);
            ''')
            for invite in self.config.get('invites', []):
                db.execute('INSERT OR IGNORE INTO phone_invites(hash,expires) VALUES (?,?)', (invite['hash'], invite['expires']))

    def allowed(self, db, user):
        if not user or not db.execute('SELECT 1 FROM sessions WHERE token_hash=?', (user,)).fetchone():
            return False
        return self.config.get('public_uploads') is True or bool(db.execute('SELECT 1 FROM phone_access WHERE owner=?', (user,)).fetchone())

    def online(self, db):
        row = db.execute('SELECT seen FROM phone_worker WHERE id=1').fetchone()
        return bool(row and time.time()-row[0] < 45)

    def capabilities(self, authorization):
        user = hashlib.sha256(authorization[7:].encode()).hexdigest() if authorization.startswith('Bearer ') else None
        with self.connect() as db:
            allowed = self.allowed(db, user)
            online = self.online(db)
            if allowed:
                db.execute('INSERT OR REPLACE INTO phone_activity VALUES (1,?)', (time.time(),))
        return {'configured': allowed and online, 'personal_access': allowed,
                'personal_mode': not self.config.get('public_uploads', False), 'public_uploads': self.config.get('public_uploads') is True, 'worker_online': online if allowed else False}

    def cleanup(self, db):
        # Удаляем байты сразу после передачи на Mac, невостребованные снимки живут максимум пять минут.
        old = time.time()-300
        db.execute("UPDATE photo_recognitions SET status='failed' WHERE id IN (SELECT id FROM phone_jobs WHERE created<? AND state IN ('queued','claimed','matching'))", (old,))
        db.execute("UPDATE phone_jobs SET state='failed',image=NULL WHERE created<? AND state IN ('queued','claimed','matching')", (old,))

    def enqueue(self, db, rid, image):
        db.execute("INSERT INTO phone_jobs VALUES (?,?,'queued',NULL,?)", (rid, image, time.time()))

    def router(self, owner):
        from .recognition import Detection, resolve_bottles
        router = APIRouter(prefix='/v1/phone')

        def worker(authorization: str = Header(default='')):
            expected = 'Bearer '+self.config['worker_key']
            if not secrets.compare_digest(authorization, expected):
                raise HTTPException(401, 'Нет доступа')

        @router.post('/heartbeat', dependencies=[Depends(worker)])
        def heartbeat():
            with self.connect() as db:
                self.cleanup(db)
                db.execute('INSERT OR REPLACE INTO phone_worker VALUES (1,?)', (time.time(),))
            return {'online': True}

        @router.post('/unlock')
        def unlock(body: Unlock, user=Depends(owner)):
            digest = hashlib.sha256(body.invite.encode()).hexdigest()
            with self.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT expires,used FROM phone_invites WHERE hash=?', (digest,)).fetchone()
                if row and row[1] and self.allowed(db, user):
                    return {'unlocked': True}
                limit = next((int(x.get('max_devices', 1)) for x in self.config.get('invites', []) if x['hash'] == digest), 1)
                if not row or row[0] < time.time() or row[1] >= min(limit, 5):
                    raise HTTPException(403, 'Личная ссылка недействительна или уже использована')
                db.execute('UPDATE phone_invites SET used=used+1 WHERE hash=?', (digest,))
                db.execute('INSERT OR IGNORE INTO phone_access VALUES (?)', (user,))
            return {'unlocked': True}

        @router.post('/claim', dependencies=[Depends(worker)])
        def claim():
            with self.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                self.cleanup(db)
                db.execute('INSERT OR REPLACE INTO phone_worker VALUES (1,?)', (time.time(),))
                # Не больше трёх вызовов модели одновременно: серия из 10 снимков идёт тремя потоками.
                # Истёкшие задания не выдаются повторно.
                busy = db.execute("SELECT COUNT(*) FROM phone_jobs WHERE state IN ('claimed','matching')").fetchone()[0]
                if busy >= int(self.config.get('parallel', 3)):
                    return {'job': None}
                row = db.execute("SELECT id,image FROM phone_jobs WHERE state='queued' ORDER BY created LIMIT 1").fetchone()
                if not row:
                    activity = db.execute('SELECT seen FROM phone_activity WHERE id=1').fetchone()
                    return {'job': None, 'next_poll': 2 if activity and time.time()-activity[0] < 300 else 10}
                lease = secrets.token_urlsafe(32)
                db.execute("UPDATE phone_jobs SET state='claimed',lease=?,image=NULL WHERE id=?", (hashlib.sha256(lease.encode()).hexdigest(), row[0]))
            return {'job': {'id': row[0], 'image_base64': base64.b64encode(row[1]).decode(), 'lease': lease}}

        @router.post('/finish/{rid}', dependencies=[Depends(worker)])
        def finish(rid: str, body: Finished):
            digest = hashlib.sha256(body.lease.encode()).hexdigest()
            with self.connect() as db:
                self.cleanup(db)
                row = db.execute('SELECT state,lease FROM phone_jobs WHERE id=?', (rid,)).fetchone()
            if not row or not secrets.compare_digest(row[1] or '', digest):
                raise HTTPException(404, 'Задание не найдено')
            if row[0] in ('done', 'failed'):
                return {'accepted': True}
            failed = body.failed
            result = None
            if not failed:
                try:
                    # Принимаем ответ только от ожидаемой модели распознавания.
                    if body.model != 'claude-sonnet-5-5':
                        raise ValueError('Неверная модель')
                    data = Detection.model_validate(body.data).model_dump()
                    usage = {k: v for k, v in body.usage.items() if k in ('input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens') and isinstance(v, int)}
                    with self.connect() as db:
                        db.execute("UPDATE phone_jobs SET state='matching' WHERE id=? AND state='claimed'", (rid,))
                    result = {'id': rid, 'status': 'complete', **resolve_bottles(data, self.get_catalog()), 'usage': usage}
                except (ValueError, TypeError):
                    failed = True
            with self.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                # Удаление сессии или истечение срока во время сопоставления не восстанавливает задание.
                changed = db.execute("UPDATE phone_jobs SET state=?,image=NULL WHERE id=? AND state IN ('claimed','matching')", ('failed' if failed else 'done', rid)).rowcount
                if changed:
                    db.execute('UPDATE photo_recognitions SET status=?,result=?,model=? WHERE id=?', ('failed' if failed else 'complete', json.dumps(result, ensure_ascii=False) if result else None, body.model, rid))
            return {'accepted': True}

        @router.get('/result/{rid}')
        def result(rid: str, user=Depends(owner)):
            with self.connect() as db:
                self.cleanup(db)
                row = db.execute('SELECT status,result FROM photo_recognitions WHERE id=? AND owner=?', (rid, user)).fetchone()
            if not row:
                raise HTTPException(404, 'Задание не найдено')
            if row[0] == 'complete':
                return json.loads(row[1])
            if row[0] == 'failed':
                raise HTTPException(502, 'Не удалось завершить распознавание. Проверьте Claude Code на Mac')
            with self.connect() as db:
                job = db.execute('SELECT state FROM phone_jobs WHERE id=?', (rid,)).fetchone()
            phase = {'queued':'queued', 'claimed':'recognizing', 'matching':'matching'}.get(job[0] if job else '', 'queued')
            return {'id': rid, 'status': 'processing', 'phase': phase}

        return router
