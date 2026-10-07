"""Небольшой сервер фото для REG.RU, без загрузки рекомендательной модели."""
import hashlib
import json
import os
import pickle
import secrets
import sqlite3
import time
import threading
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from . import recognition, groups, orders, public_pages
from .search import SearchIndex, catalog_response


HEAVY = ('accord_weights', 'note_weights')


def trusted_pickle(folder, name):
    """Собственный файл из закрытого пакета публикации, сверенный по контрольной сумме."""
    raw = (folder / f'{name}.pkl').read_bytes()
    expected = (folder / f'{name}.sha256').read_text().strip()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise RuntimeError('Поврежден файл ' + name)
    return pickle.loads(raw)


class LazyRecords:
    """Карточки каталога из SQLite по одной.

    На хостинге каждый запрос запускает новый процесс Python, поэтому читать
    весь каталог на 140 тысяч ароматов в каждом запросе слишком долго.
    """
    def __init__(self, folder, count):
        self.folder, self.count, self.cache = folder, count, {}
        self.db = sqlite3.connect(f'file:{folder / "catalog.sqlite"}?mode=ro', uri=True, check_same_thread=False)
        self._similarity = None

    def __len__(self):
        return self.count

    def __getitem__(self, i):
        if i not in self.cache:
            row = self.db.execute('SELECT card FROM cards WHERE i=?', (i,)).fetchone()
            if row is None:
                raise IndexError(i)
            self.cache[i] = json.loads(row[0])
        return self.cache[i]

    def __iter__(self):
        for i in range(self.count):
            yield self[i]

    def position(self, pid):
        row = self.db.execute('SELECT i FROM cards WHERE pid=?', (str(pid),)).fetchone()
        return row[0] if row else None

    @property
    def similarity(self):
        # Индекс нот собран при публикации, здесь только чтение готового файла.
        if self._similarity is None:
            self._similarity = trusted_pickle(self.folder, 'similarity')
            self._similarity.records = self
        return self._similarity


class LazyPositions:
    def __init__(self, records):
        self.records = records

    def __contains__(self, pid):
        return self.records.position(pid) is not None

    def __getitem__(self, pid):
        found = self.records.position(pid)
        if found is None:
            raise KeyError(pid)
        return found


def create_app(data_dir):
    folder = Path(data_dir)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    records = []
    count_file = folder / 'catalog-count.txt'
    count = int(count_file.read_text()) if count_file.exists() else len(json.loads((folder / 'catalog.json').read_text()))

    class Catalog:
        def __init__(self):
            if (folder / 'catalog.sqlite').exists():
                self.records = LazyRecords(folder, count)
                self.index = LazyPositions(self.records)
            else:
                records.extend(json.loads((folder / 'catalog.json').read_text()))
                for record in records:
                    record.setdefault('votes', 0)
                self.index = {r['pid']: i for i, r in enumerate(records)}
                self.records = records
            self._search_index = None
            self._index_lock = threading.Lock()

        @property
        def search_index(self):
            with self._index_lock:
                if self._search_index is None:
                    self._load_index()
                return self._search_index

        def _load_index(self):
            if (folder / 'catalog-index.pkl').exists():
                self._search_index = trusted_pickle(folder, 'catalog-index')
            else:
                self._search_index = SearchIndex(self.records)

        def summary(self, i):
            # Веса нужны только подбору, в ответы поиска их не отдаём.
            record = self.records[i]
            return {**{k: v for k, v in record.items() if k not in HEAVY}, 'votes': record.get('votes', 0)}

        def search(self, query, limit=15):
            return [self.summary(i) for i in self.search_index.find(query, limit)]

    catalog = None
    catalog_lock = threading.Lock()

    def get_catalog():
        nonlocal catalog
        with catalog_lock:
            if catalog is None:
                catalog = Catalog()
            return catalog

    def connect():
        db = sqlite3.connect(folder / 'photos.sqlite', timeout=10)
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA secure_delete=ON')
        return db

    with connect() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS missing_fragrances(owner TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,name TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(owner,name));
        ''')
    os.chmod(folder / 'photos.sqlite', 0o600)
    recognition.init_recognition_db(connect)
    groups.init_db(connect)
    public_pages.init_db(connect)
    orders.init_db(connect)
    offers = orders.Offers(folder)
    app = FastAPI(title='НОТА: фотографии и коллекция', docs_url=None, redoc_url=None, openapi_url=None)

    def owner(authorization: str = Header(default='')):
        if not authorization.startswith('Bearer '):
            raise HTTPException(401, 'Нужна сессия')
        key = hashlib.sha256(authorization[7:].encode()).hexdigest()
        with connect() as db:
            found = db.execute('SELECT 1 FROM sessions WHERE token_hash=?', (key,)).fetchone()
        if not found:
            raise HTTPException(401, 'Неизвестная сессия')
        return key

    @app.middleware('http')
    async def limits(request: Request, call_next):
        if request.method in {'POST', 'PUT', 'PATCH'}:
            maximum = 12*1024*1024 if request.url.path.endswith('/v1/recognition') else 65536
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > maximum:
                    return JSONResponse({'detail': 'Слишком большой запрос'}, status_code=413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.get('/health')
    def health():
        return {'status': 'ok', 'catalog_size': count, 'recognition_configured': recognition.configured()}

    @app.post('/v1/sessions', status_code=201)
    def session():
        token = secrets.token_urlsafe(32)
        with connect() as db:
            # Ограничение роста анонимных сессий независимо от адреса клиента.
            if db.execute('SELECT COUNT(*) FROM sessions WHERE created_at>?', (time.time()-86400,)).fetchone()[0] >= 1000:
                raise HTTPException(429, 'Попробуйте позже')
            db.execute('INSERT INTO sessions VALUES (?,?)', (hashlib.sha256(token.encode()).hexdigest(), time.time()))
        return {'token': token}

    @app.delete('/v1/session', status_code=204)
    def erase(user=Depends(owner)):
        with connect() as db:
            # Смысл маршрута прежний: удаляется сессия и каскадом все её данные.
            # Дополнительно удаляются файлы публичных страниц её групп, их каскад базы не достаёт.
            public_pages.remove_owner_pages(db, user)
            db.execute('DELETE FROM sessions WHERE token_hash=?', (user,))

    @app.get('/v1/catalog')
    def search(q: str = '', limit: int = 15):
        if len(q) > 150 or not 1 <= limit <= 30:
            raise HTTPException(422, 'Проверьте запрос')
        catalog = get_catalog()
        return catalog_response(catalog.search_index, q, catalog.summary, limit)

    bridge = None
    config = os.environ.get('NOTA_PHONE_CONFIG')
    if config and Path(config).is_file():
        from .phone_bridge import PhoneBridge
        bridge = PhoneBridge(config, connect, get_catalog)
        app.include_router(bridge.router(owner))
    app.include_router(recognition.create_router(owner, connect, get_catalog, bridge))
    app.include_router(groups.create_router(owner, connect, get_catalog, offers))
    app.include_router(orders.create_router(owner, connect, get_catalog, offers))
    try:
        from . import telegram
    except ImportError:
        telegram = None
    if telegram:
        app.include_router(telegram.create_router(connect))
    return app
