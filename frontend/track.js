/* НОТА: события воронки. window.notaTrack(name, params) копит события и отправляет пачкой.
   Сервер принимает их в PHP без запуска Python (/articles/nota-api/v1/events), поэтому запрос дешёвый.
   Если на странице подключена Яндекс Метрика (window.ym и window.NOTA_YM_ID), то же событие уходит
   целью: ym(NOTA_YM_ID, 'reachGoal', name, params). Счётчик Метрики подключается отдельно. */
(function () {
  'use strict';
  if (window.notaTrack) return;
  // Список совпадает с белым списком сервера (model-service/deploy-photo/events.php).
  var EVENTS = ['group_created', 'group_ranked', 'recs_opened', 'recs_more', 'kit_added', 'share_opened', 'shared',
    'group_published', 'public_opened', 'public_to_app', 'order_sent'];
  var QUEUE_KEY = 'nota-events-queue', VID_KEY = 'nota-vid', MAX_BATCH = 20, MAX_QUEUE = 60, DELAY = 8000;
  var meta = document.querySelector('meta[name="nota-api-base"]');
  var base = String((meta && meta.getAttribute('content')) || '/articles/nota-api').replace(/\/+$/, '');
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') base = '';
  var page = document.getElementById('nota-public') ? 'public' : 'app';
  var queue = [], timer = 0;

  function store(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { /* хранилище закрыто */ }
  }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  // Случайный id браузера: не токен сессии и не связан с телефоном, нужен только для подсчёта людей.
  function visitor() {
    var v = read(VID_KEY);
    if (v && /^[A-Za-z0-9_-]{8,40}$/.test(v)) return v;
    var bytes = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(bytes) : bytes.forEach(function (_, i) { bytes[i] = Math.random() * 256; });
    v = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    store(VID_KEY, v);
    return v;
  }
  function clean(params) {
    var out = {};
    Object.keys(params || {}).slice(0, 6).forEach(function (k) {
      var v = params[k];
      if (!/^[a-z_]{1,20}$/.test(k)) return;
      if (typeof v === 'number' && isFinite(v)) out[k] = v;
      else if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = v.slice(0, 64);
    });
    return out;
  }
  function persist() { store(QUEUE_KEY, queue.length ? JSON.stringify(queue) : null); }
  function restore() {
    try { var saved = JSON.parse(read(QUEUE_KEY) || '[]'); if (Array.isArray(saved)) queue = saved.slice(-MAX_QUEUE); } catch (e) { queue = []; }
  }

  function send(batch, beacon) {
    var body = JSON.stringify({ v: visitor(), page: page, events: batch });
    var url = base + '/v1/events';
    if (beacon && navigator.sendBeacon) {
      try { if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return Promise.resolve(); } catch (e) { /* ниже fetch */ }
    }
    return fetch(url, { method: 'POST', body: body, keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' } }).then(function (r) {
      if (!r.ok && r.status !== 422) throw new Error(String(r.status));
    });
  }
  function flush(beacon) {
    clearTimeout(timer); timer = 0;
    if (!queue.length) return;
    var batch = queue.splice(0, MAX_BATCH);
    persist();
    send(batch, beacon).catch(function () {
      // Сеть недоступна: события вернутся в очередь и уйдут со следующей пачкой.
      queue = batch.concat(queue).slice(-MAX_QUEUE); persist();
    });
    if (queue.length) timer = setTimeout(flush, DELAY);
  }
  function schedule() {
    if (queue.length >= 10) { flush(false); return; }
    if (!timer) timer = setTimeout(flush, DELAY);
  }

  window.notaTrack = function (name, params) {
    if (EVENTS.indexOf(name) < 0) return;
    var p = clean(params);
    queue.push({ n: name, t: Date.now(), p: p });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    persist();
    schedule();
    // Точка подключения Метрики: цель с тем же именем, если счётчик есть на странице.
    try { if (typeof window.ym === 'function' && window.NOTA_YM_ID) window.ym(window.NOTA_YM_ID, 'reachGoal', name, p); } catch (e) { /* Метрика не мешает приложению */ }
  };
  window.notaTrack.flush = function () { flush(true); };
  window.notaTrack.events = EVENTS.slice();

  restore();
  if (queue.length) schedule();
  // Уход со страницы: отправляем накопленное без ожидания ответа.
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(true); });
  window.addEventListener('pagehide', function () { flush(true); });
})();
