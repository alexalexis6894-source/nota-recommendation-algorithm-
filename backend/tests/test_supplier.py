import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import orders, supplier, telegram as tg


class SupplierTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)
        self.path = self.folder / 'orders.sqlite'
        orders.init_db(self.connect)
        self.db = self.connect()
        tg.init_db(self.db)
        now = time.time()
        self.db.execute('INSERT INTO orders(id,number,owner,phone,total,status,created_at,updated_at) '
                        "VALUES('one',1,'owner','+79991234567',300,'new',?,?)", (now, now))
        self.db.executemany("INSERT INTO order_items VALUES('one',?,?,?,5,100,'Group')",
                            [(str(i), 'Brand', f'Scent {i}') for i in range(1, 4)])
        self.db.execute("INSERT INTO telegram_chats VALUES(10,100,'Manager',?)", (now,))
        self.db.execute("INSERT INTO supplier_chats VALUES(20,200,'Supplier',?)", (now,))
        self.db.commit()
        self.manager = tg.Config('test-manager', role='manager')
        self.vendor = tg.Config('test-supplier', role='supplier')
        self.config = patch.object(tg, 'load_config', side_effect=lambda role='manager':
                                   self.vendor if role == 'supplier' else self.manager)
        self.config.start()
        self.calls = []
        self.network = patch.object(tg, 'bot_api', side_effect=self.api)
        self.network.start()
        self.addCleanup(self.config.stop)
        self.addCleanup(self.network.stop)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.db.close)

    def connect(self):
        db = sqlite3.connect(self.path)
        db.execute('PRAGMA foreign_keys=ON')
        return db

    def api(self, token, method, payload):
        self.calls.append((token, method, payload))
        return {'ok': True, 'result': {'message_id': 50, 'chat': {'id': payload.get('chat_id')}}}

    def request(self):
        result = supplier.request_check(self.db, tg._load_order(self.db, number=1))
        return self.db.execute('SELECT id FROM supplier_checks ORDER BY rowid DESC LIMIT 1').fetchone()[0], result

    def callback(self, cid, user=200, chat=20, state='approved'):
        tg._handle_callback(self.db, self.vendor, {'id': 'cb', 'from': {'id': user},
                             'data': f'sp:{cid}:{state}',
                             'message': {'chat': {'id': chat}, 'message_id': 50}})

    def manager_click(self, action):
        tg._handle_callback(self.db, self.manager, {'id': 'manager-cb', 'from': {'id': 100},
                            'data': f'st:1:{action}', 'message': {'chat': {'id': 10}, 'message_id': 99}})

    def test_approval_notifies_manager_without_marking_paid(self):
        cid, _ = self.request()
        supplier.deliver_pending(self.db)
        self.callback(cid)
        supplier.deliver_pending(self.db)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'approved')
        self.assertEqual(self.db.execute('SELECT status,paid_at FROM orders').fetchone(), ('new', None))
        notices = [p for t, m, p in self.calls if t == 'test-manager' and m == 'sendMessage']
        self.assertIn('Состав подтверждён', notices[0]['text'])
        payload = [p for t, m, p in self.calls if t == 'test-supplier' and m == 'sendMessage'][0]
        self.assertNotIn('+7999', payload['text'])
        self.assertNotIn('₽', payload['text'])

    def test_paid_can_skip_approval_and_cannot_be_edited(self):
        self.manager_click('paid')
        order = tg._load_order(self.db, number=1)
        self.assertIsNotNone(order['paid_at'])
        self.assertIn('до оплаты', supplier.request_check(self.db, order))
        self.manager_click('in_work')
        self.assertIsNotNone(tg._load_order(self.db, number=1)['paid_at'])

    def test_request_is_idempotent(self):
        first, _ = self.request()
        second, _ = self.request()
        self.assertEqual(first, second)
        supplier.deliver_pending(self.db)
        supplier.deliver_pending(self.db)
        self.assertEqual(sum(m == 'sendMessage' for _, m, _ in self.calls), 1)

    def test_supplier_cannot_operate_manager_bot_or_other_chat(self):
        cid, _ = self.request()
        supplier.deliver_pending(self.db)
        self.callback(cid, user=100)
        self.callback(cid, chat=30)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'pending')
        tg._handle_callback(self.db, self.vendor, {'id': 'forged', 'from': {'id': 200}, 'data': 'st:1:paid'})
        self.assertIsNone(tg._load_order(self.db, number=1)['paid_at'])

    def test_stale_snapshot_cannot_be_approved(self):
        cid, _ = self.request()
        supplier.deliver_pending(self.db)
        self.db.execute("UPDATE order_items SET volume_ml=10 WHERE pid='1'")
        self.db.commit()
        self.callback(cid)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'superseded')

    def test_decision_cannot_be_changed_by_second_click(self):
        cid, _ = self.request()
        supplier.deliver_pending(self.db)
        self.callback(cid, state='changes')
        self.callback(cid)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'changes')

    def test_paid_during_check_closes_supplier_decision(self):
        cid, _ = self.request()
        supplier.deliver_pending(self.db)
        self.manager_click('paid')
        self.callback(cid)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'superseded')
        self.assertEqual(tg._load_order(self.db, number=1)['status'], 'paid')

    def test_failed_delivery_retries_without_duplicate_success(self):
        cid, _ = self.request()
        with patch.object(tg, 'bot_api', return_value={'ok': False, 'error_code': 503}):
            supplier.deliver_pending(self.db)
        self.assertIsNone(self.db.execute('SELECT message_id FROM supplier_messages').fetchone()[0])
        self.db.execute('UPDATE supplier_messages SET last_try=0')
        self.db.commit()
        supplier.deliver_pending(self.db)
        supplier.deliver_pending(self.db)
        self.assertEqual(sum(m == 'sendMessage' for _, m, _ in self.calls), 1)

    def test_update_ids_are_isolated_between_bots(self):
        update = {'update_id': 111, 'message': {'chat': {'id': 10}, 'from': {'id': 100}, 'text': '/orders'}}
        tg.handle_update(self.connect, self.manager, update)
        tg.handle_update(self.connect, self.vendor, update)
        tg.handle_update(self.connect, self.manager, update)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM telegram_bot_updates').fetchone()[0], 2)
        self.assertEqual(len(self.calls), 2)

    def test_replacement_invalidates_ok_and_recalculates_price(self):
        cid, _ = self.request()
        supplier.deliver_pending(self.db)
        self.callback(cid)
        (self.folder / 'offers.json').write_text(json.dumps({'9': {'ml': 10, 'price': 250}}))
        with sqlite3.connect(self.folder / 'catalog.sqlite') as catalog:
            catalog.execute('CREATE TABLE cards(pid TEXT,card TEXT)')
            catalog.execute('INSERT INTO cards VALUES(?,?)', ('9', json.dumps({'brand': 'New', 'name': 'New scent'})))
        supplier.replace_item(self.db, 'one', 2, '9', folder=self.folder)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'superseded')
        self.assertEqual(self.db.execute('SELECT total FROM orders').fetchone()[0], 450)
        self.assertEqual([r[0] for r in self.db.execute('SELECT pid FROM order_items ORDER BY rowid')], ['1', '9', '3'])
        new_cid, _ = self.request()
        self.assertNotEqual(new_cid, cid)
        self.callback(cid)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'pending')
        self.manager_click('paid')
        self.manager_click('in_work')
        with self.assertRaises(ValueError):
            supplier.replace_item(self.db, 'one', 1, '9', folder=self.folder)

    def test_unbound_supplier_does_not_queue_check(self):
        self.db.execute('DELETE FROM supplier_chats')
        self.db.commit()
        message = supplier.request_check(self.db, tg._load_order(self.db, number=1))
        self.assertIn('подключите', message)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM supplier_checks').fetchone()[0], 0)

    def test_manager_forwarded_card_cannot_leak_order(self):
        tg._handle_callback(self.db, self.manager, {'id': 'foreign', 'from': {'id': 100},
            'data': 'st:1:paid', 'message': {'chat': {'id': 999}, 'message_id': 1}})
        self.assertIsNone(tg._load_order(self.db, number=1)['paid_at'])
        self.assertEqual([m for _, m, _ in self.calls], ['answerCallbackQuery'])

    def test_webhooks_require_independent_role_secret_and_flush_outbox(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        self.manager.webhook_secret = 'manager-secret'
        self.vendor.webhook_secret = 'supplier-secret'
        app = FastAPI()
        app.include_router(tg.create_router(self.connect))
        with TestClient(app) as client:
            url = '/v1/telegram/webhook/supplier'
            self.assertEqual(client.post(url, json={}).status_code, 403)
            self.assertEqual(client.post(url, json={}, headers={
                'x-telegram-bot-api-secret-token': 'manager-secret'}).status_code, 403)
            response = client.post('/v1/telegram/webhook/manager', json={
                'update_id': 333, 'callback_query': {'id': 'request', 'from': {'id': 100},
                'data': 'st:1:supplier', 'message': {'chat': {'id': 10}, 'message_id': 1}}},
                headers={'x-telegram-bot-api-secret-token': 'manager-secret'})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(supplier.current_check(self.db, 'one'), 'pending')
        self.assertTrue(any(t == 'test-supplier' and m == 'sendMessage' for t, m, _ in self.calls))

    def test_schema_migration_is_repeatable(self):
        tg.init_db(self.db)
        tg.init_db(self.db)
        self.assertIn('paid_at', [r[1] for r in self.db.execute('PRAGMA table_info(orders)')])


if __name__ == '__main__':
    unittest.main()
