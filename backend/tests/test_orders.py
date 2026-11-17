import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import orders, telegram


class BonusOrdersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'orders.sqlite'
        orders.init_db(self.connect)
        with self.connect() as db:
            telegram.init_db(db)
            db.executescript('''
                CREATE TABLE scent_groups(id TEXT, name TEXT);
                CREATE TABLE sample_selection(owner TEXT, pid TEXT, group_id TEXT, created_at REAL);
            ''')
        catalog = SimpleNamespace(index={str(i): i for i in range(5)},
                                  summary=lambda i: {'brand': 'Brand', 'name': str(i)})
        offers = SimpleNamespace(get=lambda pid: {'ml': 5, 'price': 100})
        app = FastAPI()
        app.include_router(orders.create_router(lambda: 'user', self.connect, lambda: catalog, offers))
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.select()

    def connect(self):
        return sqlite3.connect(self.path)

    def select(self):
        with self.connect() as db:
            db.execute('DELETE FROM sample_selection')
            db.executemany('INSERT INTO sample_selection VALUES(?,?,NULL,?)',
                           [('user', str(i), i) for i in range(5)])

    def previous(self, earned=200, spent=0, status='done', owner='user'):
        with self.connect() as db:
            number = db.execute('SELECT COUNT(*) + 1 FROM orders').fetchone()[0]
            db.execute('INSERT INTO orders(id,number,owner,phone,total,status,created_at,updated_at,bonus_earned,bonus_spent) '
                       'VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (str(number), number, owner, '+79991234567', 1000, status,
                        time.time() - 90000, time.time(), earned, spent))

    def submit(self, **extra):
        return self.client.post('/v1/orders', json={'phone': '+79991234567', 'consent': True, **extra})

    def test_first_purchase_earns_for_next_without_discount(self):
        response = self.submit()
        self.assertEqual(response.status_code, 201)
        order = response.json()
        self.assertEqual((order['total'], order['bonus_spent'], order['to_pay'], order['bonus_earned']),
                         (500, 0, 500, 75))
        self.assertEqual(self.client.get('/v1/orders').json()['bonus']['available'], 0)
        self.assertEqual(self.client.get('/v1/orders').json()['bonus']['pending'], 75)
        with self.connect() as db:
            db.execute("UPDATE orders SET status='done'")
        self.assertEqual(self.client.get('/v1/orders').json()['bonus']['available'], 75)

    def test_existing_balance_is_not_spent_by_default(self):
        self.previous()
        order = self.submit().json()
        self.assertEqual((order['bonus_spent'], order['to_pay']), (0, 500))
        self.assertEqual(self.client.get('/v1/orders').json()['bonus']['available'], 200)

    def test_partial_spend_matches_database_history_and_manager_card(self):
        self.previous()
        order = self.submit(bonus_spent=100).json()
        self.assertEqual((order['bonus_spent'], order['to_pay'], order['bonus_earned']), (100, 400, 75))
        history = self.client.get('/v1/orders').json()
        self.assertEqual(history['orders'][0]['to_pay'], 400)
        self.assertEqual(history['bonus']['available'], 100)
        with self.connect() as db:
            saved = telegram._load_order(db, number=order['number'])
        self.assertIn('К оплате: 400 ₽', telegram.render_order(saved).replace('\u00a0', ' '))
        with self.connect() as db:
            db.execute('UPDATE orders SET status=? WHERE number=?', ('cancelled', order['number']))
        balance = self.client.get('/v1/orders').json()['bonus']
        self.assertEqual((balance['available'], balance['pending']), (200, 0))

    def test_pending_cancelled_and_other_users_earnings_cannot_be_spent(self):
        self.previous(status='new')
        self.previous(status='cancelled')
        self.previous(owner='someone-else')
        self.assertEqual(self.submit(bonus_spent=1).status_code, 409)
        with self.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sample_selection').fetchone()[0], 5)

    def test_invalid_amounts_rejected(self):
        self.previous(earned=1000)
        for amount in [-1, 1.5, '100', True]:
            with self.subTest(amount=amount):
                self.assertEqual(self.submit(bonus_spent=amount).status_code, 422)
        self.assertEqual(self.submit(bonus_spent=501).status_code, 409)
        self.assertEqual(self.submit(bonus_spent=500).json()['to_pay'], 0)

    def test_reserved_bonus_cannot_be_spent_twice(self):
        self.previous()
        self.assertEqual(self.submit(bonus_spent=200).status_code, 201)
        self.select()
        self.assertEqual(self.submit(bonus_spent=200).status_code, 409)
        self.assertEqual(self.submit(bonus_spent=0).status_code, 201)


if __name__ == '__main__':
    unittest.main()
