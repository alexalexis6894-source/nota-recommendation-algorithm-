/* НОТА Air: добавление ароматов по названию и по фото.
   Модуль работает рядом с app.js и не трогает его состояние: свой лист, своя очередь, своя коллекция из каталога НОТА.
   Поиск по названию не зависит от распознавания: он работает, даже если фото выключено или проверка сервиса не ответила.
   Снимки живут только в памяти вкладки. В localStorage пишется лишь токен сессии распознавания.
   Всё, что пришло от сервера и модели, выводится через textContent: разметка из ответа не вставляется.
   Порядок файла: константы -> помощники -> сеть -> подготовка снимков -> очередь -> рендер листа -> флаконы -> коллекция -> лист -> события. */
(function () {
  'use strict';

  var openBtn = document.getElementById('rx-open');
  var tpl = document.getElementById('rx-sheet-tpl');
  if (!openBtn || !tpl || !('content' in tpl)) return;

  /* ========== Константы ========== */

  var TOKEN_KEY = 'nota.recognition.token';
  var DEFAULT_MAX_BYTES = 8388608;
  var MAX_SIDE = 2048;
  var MAX_INPUT_BYTES = 40 * 1024 * 1024; // крупнее не декодируем: бережём память телефона
  var MAX_PIXELS = 80000000;
  var DECODE_TIMEOUT = 20000;
  var RECOGNIZE_TIMEOUT = 100000;
  var API_TIMEOUT = 20000;
  var PARALLEL = 3; // Mac обрабатывает до трёх снимков одновременно
  var SERIES_MAX = 10; // кадров за одну серию камеры
  var QUALITIES = [0.86, 0.78, 0.7];
  var REMOVABLE = ['preparing', 'ready', 'queued', 'error', 'invalid'];

  // Уверенность показываем словом и объяснением, без процентов
  var CONF = Object.assign(Object.create(null), {
    high: { label: 'Уверенно', text: 'Модель уверенно определила аромат. Сверьте название перед добавлением.' },
    medium: { label: 'Скорее всего', text: 'Есть подходящая гипотеза, но флакон может принадлежать другой версии.' },
    low: { label: 'Не уверены', text: 'Признаков недостаточно. Проверьте варианты или снимите флакон крупнее.' }
  });
  var CATALOG_STATUS = ['candidates', 'not_found', 'unknown'];

  var meta = document.querySelector('meta[name="nota-api-base"]');
  // Пустой адрес означает тот же сервер, что отдал страницу
  var BASE = String((meta && meta.getAttribute('content')) || '').trim().replace(/\/+$/, '');
  // Локальный сервер разработки обслуживает API на том же адресе.
  if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') BASE = '';
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  /* ========== Состояние (только в памяти) ========== */

  var S = {
    capsState: 'idle', // idle | loading | ok | error
    caps: null,
    unavailable: false,
    photos: [],
    queue: [],
    inflight: 0,
    seq: 0,
    byKey: Object.create(null), // ключ флакона -> { p, b }
    mine: { state: 'idle', items: [] },
    bulkBusy: false, // идёт «Добавить все отмеченные»
    mode: 'name' // name | photo: выбранный способ добавления, запоминается до перезагрузки
  };
  var token = readToken();
  var sessionWait = null;
  var preparation = Promise.resolve();
  var personalInvite = window.notaPersonalInvite || null;
  delete window.notaPersonalInvite;
  var personalWait = null;
  var progressTimer = null;
  var R = null; // ссылки на узлы листа, создаются при первом открытии

  /* ========== Помощники ========== */

  var $ = function (id) { return document.getElementById(id); };

  // Безопасный конструктор узлов: строки становятся текстом, а не разметкой
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'text') n.textContent = v;
        else if (k === 'class') n.className = v;
        else if (k === 'hidden' || k === 'checked' || k === 'disabled') n[k] = true;
        else if (k === 'value') n.value = v;
        else n.setAttribute(k, v === true ? '' : String(v));
      });
    }
    if (kids) {
      kids.forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return n;
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function photosWord(n) { return n + ' ' + plural(n, 'снимок', 'снимка', 'снимков'); }
  function bottlesWord(n) { return n + ' ' + plural(n, 'флакон', 'флакона', 'флаконов'); }

  // Строка из ответа: только текст и число, пробелы схлопнуты, длина ограничена
  function str(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    return String(v).replace(/[\u2013\u2014\u2212]/g, '-').replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  function pidKey(pid) { return String(pid); }
  function fkSafe(s) { return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60); }
  function clamp01(x) { return Math.min(1, Math.max(0, x)); }

  function normItem(x) {
    if (!x || typeof x !== 'object') return null;
    var pid = x.pid;
    if ((typeof pid !== 'string' && typeof pid !== 'number') || pid === '') return null;
    return { pid: pid, name: str(x.name, 160), brand: str(x.brand, 120) };
  }
  function itemLabel(it) { return [it.name, it.brand].filter(Boolean).join(', ') || 'аромат из каталога'; }

  function normBox(v) {
    if (!Array.isArray(v) || v.length !== 4) return null;
    var n = v.map(Number);
    if (!n.every(function (x) { return isFinite(x); })) return null;
    var x = clamp01(n[0]), y = clamp01(n[1]);
    var w = Math.min(clamp01(n[2]), 1 - x), h = Math.min(clamp01(n[3]), 1 - y);
    if (w < 0.01 || h < 0.01) return null;
    return [x, y, w, h];
  }

  // Предупреждения модели показываем, только если это человеческий текст, а не служебный код
  function humanText(w) {
    if (typeof w !== 'string') return false;
    var t = w.trim();
    return t.length >= 3 && t.length <= 240 && !/^[A-Za-z0-9_.:\-]+$/.test(t);
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function count(status) { return S.photos.filter(function (p) { return p.status === status; }).length; }
  function busy() { return S.inflight > 0 || S.queue.length > 0; }
  function num(p) { return S.photos.indexOf(p) + 1; }
  function maxBytes() { return S.caps ? S.caps.maxBytes : DEFAULT_MAX_BYTES; }
  function mb(bytes) { return Math.round(bytes / 1048576) + ' МБ'; }
  function accepts(type) { return !S.caps || !S.caps.types.length || S.caps.types.indexOf(type) >= 0; }

  /* ========== Токен сессии: отдельный ключ, без снимков ========== */

  function readToken() {
    try { return window.localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function setToken(t) {
    token = t || null;
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* хранилище закрыто: токен живёт до закрытия вкладки */ }
  }

  /* ========== Сеть ========== */

  // Запрос с тайм-аутом. Ошибка всегда объект: { kind: timeout | network | http | bad, status }
  function api(method, path, opt) {
    opt = opt || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var headers = { Accept: 'application/json' };
    if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
    var timer = 0;
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort(); // прерывает ожидание, но не отменяет уже принятую сервером работу
        reject({ kind: 'timeout' });
      }, opt.timeout || API_TIMEOUT);
    });
    var req = fetch(BASE + path, {
      method: method,
      headers: headers,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined,
      cache: 'no-store',
      credentials: 'same-origin'
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        if (txt) { try { data = JSON.parse(txt); } catch (e) { data = null; } }
        if (!res.ok) throw { kind: 'http', status: res.status, code: data && data.detail && data.detail.code, detail: data && typeof data.detail === 'string' ? data.detail : '' };
        if (res.status === 204) return {};
        if (!data || typeof data !== 'object') throw { kind: 'bad' };
        return data;
      });
    }, function () { throw { kind: 'network' }; });
    return Promise.race([req, timeout]).then(
      function (d) { clearTimeout(timer); return d; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  // Одна сессия на все параллельные запросы
  function ensureSession() {
    if (token) return Promise.resolve(token);
    if (!sessionWait) {
      function createSession() {
        // Вторая вкладка того же браузера использует уже созданную сессию.
        var saved = readToken();
        if (saved) { token = saved; return Promise.resolve(saved); }
        return api('POST', '/v1/sessions', { body: {} }).then(function (d) {
          if (typeof d.token !== 'string' || !d.token) throw { kind: 'bad' };
          setToken(d.token);
          return d.token;
        });
      }
      sessionWait = navigator.locks ? navigator.locks.request('nota-session', createSession) : createSession();
      var clear = function () { sessionWait = null; };
      sessionWait.then(clear, clear);
    }
    return sessionWait;
  }

  // 401 сбрасывает устаревший токен. Платный запрос сам не повторяется
  function authed(method, path, opt, allowCreate) {
    var start = token ? Promise.resolve(token)
      : allowCreate ? ensureSession()
      : Promise.reject({ kind: 'http', status: 401 });
    return start.then(function (t) {
      return api(method, path, Object.assign({}, opt || {}, { token: t })).catch(function (e) {
        if (e && e.status === 401 && token === t) setToken(null);
        throw e;
      });
    });
  }

  function searchCatalog(q) {
    return api('GET', '/v1/catalog?q=' + encodeURIComponent(q)).then(function (d) {
      return {
        items: (Array.isArray(d.items) ? d.items : []).map(normItem).filter(Boolean).slice(0, 12),
        suggestions: (Array.isArray(d.suggestions) ? d.suggestions : []).slice(0, 3).map(function (x) {
          var item = normItem(x);
          if (item) item.query = str(x.query, 150);
          return item;
        }).filter(function (x) { return x && x.query; })
      };
    });
  }

  function recognizeError(e) {
    var s = e && e.status;
    if (e && e.kind === 'timeout') return { short: 'Нет ответа', text: 'Сервер не ответил вовремя. Отправку этого снимка можно повторить.', retry: true };
    if (e && e.kind === 'network') return { short: 'Нет связи', text: 'Нет связи с сервером. Проверьте интернет и повторите.', retry: true };
    if (e && e.kind === 'local') return { short: 'Не прочитан', text: 'Снимок не прочитался. Уберите его и выберите заново.', retry: false };
    if (s === 401) return { short: 'Сессия устарела', text: 'Сессия устарела и сброшена. Нажмите «Повторить», чтобы отправить снимок в новой сессии.', retry: true };
    if (s === 409 && e.code === 'failed_request') return { short: 'Не завершено', text: 'Предыдущая попытка завершилась ошибкой. Уберите снимок и добавьте его заново для новой попытки.', retry: false };
    if (s === 409) return { short: 'Ещё в работе', text: 'Этот снимок ещё обрабатывается. Повторите чуть позже.', retry: true };
    if (s === 413) return { short: 'Слишком большой', text: 'Файл слишком большой для отправки. Выберите другой снимок.', retry: false };
    if (s === 422) return { short: 'Не подходит', text: 'Снимок не подошёл для распознавания. Уберите его и выберите другой.', retry: false };
    if (s === 429) return { short: 'Много запросов', text: 'Слишком много запросов подряд. Повторите через минуту.', retry: true };
    if (s === 502) return { short: 'Сбой сервиса', text: 'Сервис распознавания не справился с этим снимком. Уберите его и добавьте заново для новой попытки.', retry: false };
    if (s === 503) return { short: 'Недоступно', text: 'Распознавание сейчас недоступно.', retry: false };
    return { short: 'Ошибка', text: 'Не получилось распознать снимок. Отправку можно повторить.', retry: true };
  }

  function actionError(e) {
    var s = e && e.status;
    if (e && e.kind === 'timeout') return 'Сервер не ответил вовремя. Попробуйте ещё раз.';
    if (e && e.kind === 'network') return 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.';
    if (s === 401) return 'Сессия устарела, поэтому сохранить не получилось. Чтобы продолжить, добавьте снимок заново.';
    if (s === 404) return 'Этот результат распознавания больше недоступен. Добавьте снимок заново.';
    if (s === 400 || s === 422) return 'Этот вариант сохранить нельзя. Выберите другой.';
    return 'Не получилось сохранить. Попробуйте ещё раз.';
  }

  // Ошибки добавления по названию. После 401 токен уже сброшен: следующее нажатие создаст новую сессию
  function addError(e) {
    var s = e && e.status;
    if (e && e.kind === 'timeout') return 'Сервер не ответил вовремя. Нажмите «Добавить» ещё раз.';
    if (e && e.kind === 'network') return 'Нет связи с сервером. Проверьте интернет и нажмите «Добавить» ещё раз.';
    if (e && e.kind === 'bad') return 'Сервер ответил неожиданно. Нажмите «Добавить» ещё раз.';
    if (s === 401) return 'Сессия устарела. Нажмите «Добавить» ещё раз, и НОТА начнёт новую.';
    if (s === 404) return 'Этого аромата больше нет в каталоге. Обновите поиск.';
    if (s === 400 || s === 422) return 'Этот аромат добавить нельзя. Выберите другой.';
    if (s === 429) return 'Слишком много запросов подряд. Попробуйте через минуту.';
    return 'Не получилось добавить. Попробуйте ещё раз.';
  }

  /* ========== Подготовка снимков: уменьшение до 2048 и JPEG до лимита ========== */

  function isHeic(f) { return /hei[cf]/i.test(f.type || '') || /\.hei[cf]$/i.test(f.name || ''); }
  function cleanName(name) { return String(name || '').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, '_').trim(); }
  function jpegName(name) {
    var base = cleanName(name).replace(/\.[^.]*$/, '').slice(0, 80);
    return (base || 'photo') + '.jpg';
  }

  // Декодирование с защитой: тайм-аут и предел по пикселям до отрисовки
  function decodeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () { finish(new Error('timeout')); }, DECODE_TIMEOUT);
      function release() { img.onload = img.onerror = null; img.removeAttribute('src'); URL.revokeObjectURL(url); }
      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { release(); reject(err); return; }
        resolve({ img: img, w: img.naturalWidth, h: img.naturalHeight, release: release });
      }
      img.onload = function () {
        if (!img.naturalWidth || !img.naturalHeight) return finish(new Error('empty'));
        if (img.naturalWidth * img.naturalHeight > MAX_PIXELS) return finish(new Error('huge'));
        finish(null);
      };
      img.onerror = function () { finish(new Error('decode')); };
      img.decoding = 'async';
      img.src = url;
    });
  }

  function canvasBlob(c, q) {
    return new Promise(function (resolve, reject) {
      if (!c.toBlob) { reject(new Error('encode')); return; }
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('encode')); }, 'image/jpeg', q);
    });
  }

  function encodeJpeg(dec, limit) {
    function attempt(scale, round) {
      var w = Math.max(1, Math.round(dec.w * scale)), h = Math.max(1, Math.round(dec.h * scale));
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var ctx = c.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.fillStyle = '#FFFFFF'; // прозрачный PNG не станет чёрным
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(dec.img, 0, 0, w, h);
      function tryQ(i) {
        return canvasBlob(c, QUALITIES[i]).then(function (b) {
          if (b.size <= limit) { c.width = c.height = 0; return { blob: b, w: w, h: h }; }
          if (i + 1 < QUALITIES.length) return tryQ(i + 1);
          c.width = c.height = 0;
          if (round >= 3) throw new Error('too-big');
          return attempt(scale * 0.75, round + 1);
        });
      }
      return tryQ(0);
    }
    return Promise.resolve().then(function () {
      return attempt(Math.min(1, MAX_SIDE / Math.max(dec.w, dec.h)), 0);
    });
  }

  function prepFail(p, text) {
    p.status = 'invalid';
    p.err = { short: 'Не подходит', text: text, retry: false };
    p.file = null;
    render();
  }

  function prepare(p) {
    var f = p.file;
    var heic = isHeic(f);
    var limit = maxBytes();
    if (!/^image\//i.test(f.type || '') && !heic) return prepFail(p, 'Это не изображение. Выберите фото.');
    if (f.size > MAX_INPUT_BYTES) return prepFail(p, 'Файл больше ' + mb(MAX_INPUT_BYTES) + '. Выберите снимок поменьше.');
    return decodeImage(f).then(function (dec) {
      if (p.removed) { dec.release(); return null; }
      return encodeJpeg(dec, limit).then(
        function (out) { dec.release(); return out; },
        function (e) { dec.release(); throw e; }
      );
    }).then(function (out) {
      if (!out || p.removed) return;
      p.blob = out.blob;
      p.w = out.w;
      p.h = out.h;
      p.mediaType = 'image/jpeg';
      p.filename = jpegName(f.name);
      p.url = URL.createObjectURL(out.blob); // превью из того же JPEG, что уйдёт на сервер: рамки совпадут
      p.thumb = null;
      p.file = null;
      p.status = 'ready';
      render();
    }).catch(function (e) {
      if (p.removed) return;
      var reason = e && e.message;
      // Браузер не читает HEIC: отправляем исходник, сервер принимает его сам
      if (heic && f.size <= limit && accepts('image/heic')) {
        p.blob = f;
        p.heic = true;
        p.mediaType = 'image/heic';
        p.filename = cleanName(f.name) || 'photo.heic';
        p.thumb = null;
        p.file = null;
        p.status = 'ready';
        render();
        return;
      }
      prepFail(p, heic ? 'Этот браузер не открывает такой HEIC. Сохраните снимок как JPEG до ' + mb(limit) + ' и выберите снова.'
        : reason === 'huge' ? 'Слишком большое разрешение снимка. Выберите фото поменьше.'
        : reason === 'too-big' ? 'Снимок не удалось уменьшить до ' + mb(limit) + '. Выберите другой.'
        : 'Не получилось открыть снимок. Выберите другой файл.');
    });
  }

  function addFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var take = files;
    setLimit('');
    take.forEach(function (f) {
      var p = { key: 'p' + (++S.seq), file: f, status: 'preparing', err: null, bottles: [], warnings: [], selected: null };
      S.photos.push(p);
      // Декодируем по одному, чтобы несколько больших снимков не заняли память одновременно.
      preparation = preparation.then(function () { if (!p.removed) return prepare(p); });
    });
    render();
    if (take.length) announce('Добавлено: ' + photosWord(take.length) + '.');
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result || '');
        var i = s.indexOf(',');
        if (i < 0) reject({ kind: 'local' }); else resolve(s.slice(i + 1));
      };
      r.onerror = function () { reject({ kind: 'local' }); };
      r.readAsDataURL(blob);
    });
  }

  /* ========== Очередь: снимок за запрос, не больше трёх одновременно, без автоповторов ========== */

  function enqueue(p) {
    if (!p.blob || S.unavailable) return;
    if (!p.requestId) p.requestId = uuid(); // ручной повтор идёт с тем же идентификатором
    p.startedAt = p.startedAt || Date.now();
    p.status = 'queued';
    if (!progressTimer) progressTimer = setInterval(updateProgressClock, 1000);
    p.err = null;
    S.queue.push(p);
  }

  function pump() {
    if (S.unavailable) {
      // Сервис выключился: неотправленные возвращаются в «готов», ничего не уходит
      S.queue.forEach(function (p) { if (p.status === 'queued') p.status = 'ready'; });
      S.queue = [];
      return;
    }
    while (S.inflight < PARALLEL && S.queue.length) {
      var p = S.queue.shift();
      if (!p.removed && p.status === 'queued') run(p);
    }
  }

  function run(p) {
    S.inflight++;
    p.status = 'sending';
    p.phase = 'uploading';
    render();
    blobToBase64(p.blob).then(function (b64) {
      return authed('POST', '/v1/recognition', {
        timeout: RECOGNIZE_TIMEOUT,
        body: { request_id: p.requestId, image_base64: b64, media_type: p.mediaType, filename: p.filename }
      }, true);
    }).then(function (d) { return waitPersonal(d, Date.now(), p); }).then(function (d) {
      acceptResult(p, d);
      var n = p.bottles.length;
      announce('Снимок ' + num(p) + ': ' + (n ? 'найдено ' + bottlesWord(n) + '.' : 'флаконы не найдены.'));
    }).catch(function (e) {
      var err = recognizeError(e);
      p.err = err;
      p.status = (e && (e.status === 413 || e.status === 422 || e.kind === 'local')) ? 'invalid' : 'error';
      if (e && e.status === 503) { S.unavailable = true; if (S.caps) S.caps.configured = false; }
      announce('Снимок ' + num(p) + ': ' + err.text);
    }).then(function () {
      S.inflight--;
      pump();
      render();
    });
  }

  function waitPersonal(d, started, p) {
    if (d.status === 'processing') { p.phase = d.phase || 'queued'; updateProgressClock(); }
    if (d.status !== 'processing') return Promise.resolve(d);
    if (!/^[a-zA-Z0-9-]+$/.test(d.id) || Date.now() - started > 310000) return Promise.reject({ kind: 'timeout' });
    return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () {
      return authed('GET', '/v1/phone/result/' + d.id, {}, false);
    }).then(function (next) { return waitPersonal(next, started, p); });
  }

  function acceptResult(p, d) {
    if (d.status !== 'complete' || !Array.isArray(d.bottles) || (typeof d.id !== 'string' && typeof d.id !== 'number')) throw { kind: 'bad' };
    p.recId = String(d.id);
    p.bottles = d.bottles.slice(0, 30).map(function (raw, i) { return normBottle(p, raw, i); });
    p.warnings = (Array.isArray(d.warnings) ? d.warnings : []).filter(humanText).slice(0, 3).map(function (w) { return str(w, 240); });
    p.finishedAt = Date.now();
    p.status = 'done';
  }

  function normBottle(p, raw, i) {
    var x = raw && typeof raw === 'object' ? raw : {};
    var conf = CONF[x.confidence] ? x.confidence : 'low';
    var matches = (Array.isArray(x.matches) ? x.matches : []).map(normItem).filter(Boolean).slice(0, 8);
    var alts = [];
    (Array.isArray(x.alternatives) ? x.alternatives : []).forEach(function (a) {
      var t = a && typeof a === 'object' ? [str(a.brand, 80), str(a.name, 120)].filter(Boolean).join(' ') : '';
      if (t && alts.indexOf(t) < 0 && alts.length < 5) alts.push(t);
    });
    var b = {
      key: p.key + 'b' + i,
      id: (typeof x.id === 'string' || typeof x.id === 'number') ? x.id : i,
      brand: str(x.brand, 120),
      name: str(x.name, 160),
      concentration: str(x.concentration, 60),
      text: str(x.visible_text, 240),
      conf: conf,
      reason: str(x.reason, 300),
      bbox: normBox(x.bbox),
      alternatives: alts,
      matches: matches,
      catalog: CATALOG_STATUS.indexOf(x.catalog_status) >= 0 ? x.catalog_status : 'unknown',
      items: Object.create(null), // все варианты, которые видел пользователь: pid -> позиция каталога
      choice: null,
      search: { state: 'idle', items: [], seq: 0, q: '' },
      save: { state: 'idle' },
      missing: { state: 'idle' }
    };
    matches.forEach(function (m) { b.items[pidKey(m.pid)] = m; });
    // Одно уверенное совпадение отмечаем заранее, но добавление всё равно по кнопке
    if (conf === 'high' && b.catalog === 'candidates' && matches.length === 1) b.choice = pidKey(matches[0].pid);
    S.byKey[b.key] = { p: p, b: b };
    return b;
  }

  function sendReady() {
    if (S.unavailable) return;
    S.photos.forEach(function (p) { if (p.status === 'ready') enqueue(p); });
    pump();
    render();
  }

  function retry(p) {
    if (!p || p.status !== 'error' || !p.err || !p.err.retry || S.unavailable) return;
    enqueue(p);
    pump();
    render();
  }

  function removePhoto(p) {
    if (!p || REMOVABLE.indexOf(p.status) < 0) return;
    var i = S.photos.indexOf(p);
    p.removed = true;
    S.queue = S.queue.filter(function (x) { return x !== p; });
    if (p.url) URL.revokeObjectURL(p.url);
    S.photos.splice(i, 1);
    setLimit('');
    render();
    var next = S.photos[i] || S.photos[i - 1];
    var target = next ? R.tray.querySelector('[data-rx-fk="row-' + next.key + '"]') : null;
    (target || (visible(R.file) ? R.file : R.title)).focus({ preventScroll: true });
    announce('Снимок убран.');
  }

  function clearAll() {
    if (busy()) return;
    S.photos.forEach(function (p) { p.removed = true; if (p.url) URL.revokeObjectURL(p.url); });
    S.photos = [];
    S.queue = [];
    S.byKey = Object.create(null);
    R.results.textContent = '';
    setLimit('');
    render();
    // Если фото выключено, после очистки виден только поиск: фокус не должен уйти в скрытое поле
    (visible(R.file) ? R.file : R.title).focus({ preventScroll: true });
    announce('Снимки и результаты очищены.');
  }

  /* ========== Серийная съёмка: камера внутри страницы, до 10 кадров подряд ========== */

  // Системная камера iPhone отдаёт один кадр и закрывается. Поток getUserMedia остаётся открытым,
  // поэтому можно снимать флакон за флаконом, а каждый кадр сразу уходит на распознавание.
  var cam = null;

  function canSeries() {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function ensureCam() {
    if (cam) return;
    cam = { shots: 0, stream: null };
    cam.video = el('video', { class: 'rx-cam-video', playsinline: '', muted: '', autoplay: '', 'aria-hidden': 'true' });
    cam.video.muted = true;
    cam.video.playsInline = true; // иначе iPhone разворачивает видео на весь экран
    cam.count = el('span', { class: 'rx-cam-count', 'aria-live': 'polite' });
    cam.msg = el('p', { class: 'rx-cam-msg', role: 'status' });
    cam.strip = el('ol', { class: 'rx-cam-strip', 'aria-label': 'Снятые кадры' });
    cam.shutter = el('button', { type: 'button', class: 'rx-shutter', 'aria-label': 'Сделать снимок', 'data-testid': 'rx-shutter' });
    cam.done = el('button', { type: 'button', class: 'rx-cam-done', 'data-testid': 'rx-cam-done', text: 'Готово' });
    cam.flash = el('span', { class: 'rx-cam-flash', 'aria-hidden': 'true' });
    cam.d = el('dialog', { class: 'rx-cam', 'aria-label': 'Съёмка флаконов', 'data-testid': 'rx-cam' }, [
      cam.video, cam.flash,
      el('div', { class: 'rx-cam-top' }, [cam.count, cam.done]),
      cam.msg,
      el('div', { class: 'rx-cam-bottom' }, [cam.strip, cam.shutter])
    ]);
    document.body.appendChild(cam.d);
    cam.shutter.addEventListener('click', shoot);
    cam.done.addEventListener('click', closeCamera);
    cam.d.addEventListener('cancel', function (e) { e.preventDefault(); closeCamera(); });
    cam.d.addEventListener('close', stopCamera);
    // Свернули Safari: iOS сам гасит камеру, закрываем окно, чтобы не остался чёрный экран
    document.addEventListener('visibilitychange', function () { if (document.hidden && cam.d.open) closeCamera(); });
  }

  function renderCam() {
    var left = SERIES_MAX - cam.shots;
    cam.count.textContent = cam.shots + ' из ' + SERIES_MAX;
    var off = !cam.stream || left <= 0;
    cam.shutter.setAttribute('aria-disabled', off ? 'true' : 'false');
    cam.shutter.classList.toggle('is-off', off);
    if (cam.stream && left <= 0) cam.msg.textContent = 'Серия заполнена. Нажмите «Готово».';
    cam.done.textContent = cam.shots ? 'Готово' : 'Закрыть';
  }

  function openCamera() {
    ensureCam();
    cam.shots = 0;
    cam.strip.textContent = '';
    cam.msg.textContent = 'Включаем камеру';
    if (typeof cam.d.showModal === 'function') cam.d.showModal(); else cam.d.setAttribute('open', '');
    renderCam();
    cam.done.focus({ preventScroll: true });
    navigator.mediaDevices.getUserMedia({ audio: false, video: {
      facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 }
    } }).then(function (stream) {
      if (!cam.d.open) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      cam.stream = stream;
      cam.video.srcObject = stream;
      return cam.video.play();
    }).then(function () {
      if (!cam.stream) return;
      cam.msg.textContent = 'Наведите на флакон так, чтобы этикетка читалась, и нажмите на круг.';
      renderCam();
    }).catch(function (e) {
      cam.msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Нет доступа к камере. Разрешите камеру для этого сайта в настройках Safari или выберите готовые фото.'
        : 'Камера не включилась. Закройте окно и выберите готовые фото.';
      renderCam();
    });
  }

  function stopCamera() {
    if (!cam) return;
    cam.closedAt = Date.now();
    if (cam.stream) cam.stream.getTracks().forEach(function (t) { t.stop(); });
    cam.stream = null;
    cam.video.srcObject = null;
    if (R && cam.shots) {
      // После серии показываем ленту: снимки уже распознаются
      var tray = R.tray;
      setTimeout(function () { tray.scrollIntoView({ block: 'start', behavior: reduceMotion.matches ? 'auto' : 'smooth' }); }, 60);
    }
    if (R) (visible(R.camera) ? R.camera : R.title).focus({ preventScroll: true });
  }

  function closeCamera() {
    if (!cam || !cam.d.open) return;
    if (typeof cam.d.close === 'function') cam.d.close();
    else { cam.d.removeAttribute('open'); stopCamera(); }
  }

  // Кадр снимается синхронно в момент нажатия, сжатие идёт в фоне: быстрые нажатия не теряются
  function shoot() {
    var v = cam.video;
    if (!cam.stream || cam.shots >= SERIES_MAX) return;
    if (!v.videoWidth) { cam.msg.textContent = 'Камера ещё включается. Нажмите через секунду.'; return; }
    var s = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    var c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * s);
    c.height = Math.round(v.videoHeight * s);
    var ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    cam.shots++;
    var n = cam.shots;
    renderCam();
    if (!reduceMotion.matches && cam.flash.animate) cam.flash.animate([{ opacity: .85 }, { opacity: 0 }], { duration: 220, easing: 'ease-out' });
    var limit = maxBytes();
    (function tryQ(i) {
      return canvasBlob(c, QUALITIES[i]).then(function (b) {
        return b.size <= limit || i + 1 >= QUALITIES.length ? b : tryQ(i + 1);
      });
    })(0).then(function (blob) {
      if (blob.size > limit) throw new Error('too-big');
      var p = addShot(blob, c.width, c.height, n);
      cam.strip.appendChild(el('li', {}, [el('img', { src: p.url, alt: 'Кадр ' + n, width: 44, height: 44 })]));
      cam.strip.scrollLeft = cam.strip.scrollWidth;
    }).catch(function () {
      cam.shots--;
      cam.msg.textContent = 'Кадр не сохранился. Попробуйте ещё раз.';
    }).then(function () {
      c.width = c.height = 0;
      renderCam();
    });
  }

  // Кадр серии сразу готов и сразу встаёт в очередь: распознавание идёт, пока снимаете дальше
  function addShot(blob, w, h, n) {
    var p = { key: 'p' + (++S.seq), file: null, status: 'ready', err: null, bottles: [], warnings: [], selected: null,
      blob: blob, w: w, h: h, mediaType: 'image/jpeg', filename: 'nota-' + S.seq + '.jpg' };
    p.url = URL.createObjectURL(blob);
    S.photos.push(p);
    setLimit('');
    enqueue(p);
    pump();
    render();
    announce('Кадр ' + n + ' отправлен на распознавание.');
    return p;
  }

  /* ========== Рендер листа ========== */

  // Перерисовка с возвратом фокуса по ключу data-rx-fk, запасной ключ в data-rx-alt
  function keepFocus(box, fn) {
    var a = document.activeElement;
    var inside = !!a && a !== document.body && box.contains(a);
    var fk = inside ? a.getAttribute('data-rx-fk') : null;
    var alt = inside ? a.getAttribute('data-rx-alt') : null;
    fn();
    if (!inside || document.body.contains(a)) return;
    var next = (fk && R.d.querySelector('[data-rx-fk="' + fk + '"]')) || (alt && R.d.querySelector('[data-rx-fk="' + alt + '"]'));
    if (next) next.focus({ preventScroll: true });
  }

  function announce(t) {
    if (!R) return;
    R.live.textContent = '';
    setTimeout(function () { R.live.textContent = t; }, 40);
  }

  function setLimit(msg) {
    if (!R) return;
    R.limit.textContent = msg;
    R.limit.hidden = !msg;
  }

  function render() {
    renderHero();
    if (!R) return;
    renderGate();
    renderTray();
    renderFoot();
    renderResults();
  }

  function visible(n) { return !!n && n.getClientRects().length > 0; }

  // Фото выключено сервером. Сетевая ошибка проверки сюда не относится: её можно повторить
  function photoOff() { return S.capsState === 'ok' && S.unavailable; }

  // Без фото и без снимков остаётся один способ, переключатель не нужен
  function currentMode() {
    if (photoOff() && !S.photos.length && !(S.caps && (S.caps.personalMode || S.caps.publicUploads))) return 'name';
    return S.mode === 'photo' ? 'photo' : 'name';
  }

  function renderGate() {
    var ok = S.capsState === 'ok';
    var off = photoOff();
    var mode = currentMode();
    var single = off && !S.photos.length && !(S.caps && (S.caps.personalMode || S.caps.publicUploads));
    R.seg.hidden = single;
    Array.prototype.forEach.call(R.seg.querySelectorAll('[data-rx-mode]'), function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-rx-mode') === mode));
    });
    R.paneName.hidden = mode !== 'name';
    R.panePhoto.hidden = mode !== 'photo';
    R.photoNote.hidden = !single;
    R.photoNote.textContent = S.caps && S.caps.personalAccess ? 'Mac сейчас не подключен. Включите его и откройте этот экран снова.' : 'Добавление по фото сейчас выключено.';
    R.caps.hidden = S.capsState !== 'loading';
    R.capsError.hidden = S.capsState !== 'error';
    R.photoOff.hidden = !off;
    R.photoOff.querySelector('p').textContent = S.caps && S.caps.publicUploads
      ? 'Распознавание временно недоступно. Попробуйте чуть позже или добавьте аромат по названию.'
      : S.caps && S.caps.personalAccess
      ? 'Mac сейчас не подключен. Включите его и нажмите «Проверить снова».'
      : S.caps && S.caps.personalMode ? 'Этот браузер еще не подключен. Откройте личную ссылку из чата в этом браузере.'
      : 'Новые снимки сейчас не распознаются. Найденные флаконы можно подтвердить ниже.';
    R.intake.hidden = !(ok && !off);
    R.lead.textContent = 'Снимите до ' + SERIES_MAX + ' флаконов подряд или выберите фото из галереи. Каждый кадр распознаётся сразу, на одном фото может быть несколько флаконов.';
  }

  function elapsed(p) {
    var seconds = Math.max(0, Math.floor(((p.finishedAt || Date.now()) - (p.startedAt || Date.now())) / 1000));
    return Math.floor(seconds / 60) + ':' + ('0' + seconds % 60).slice(-2);
  }

  function updateProgressClock() {
    var active = S.photos.filter(function (p) { return p.status === 'queued' || p.status === 'sending'; });
    if (!active.length) { clearInterval(progressTimer); progressTimer = null; return; }
    if (!R) return;
    active.forEach(function (p) {
      var node = R.tray.querySelector('[data-rx-clock="' + p.key + '"]');
      if (node) node.textContent = statusText(p);
    });
    var first = active.reduce(function (a, b) { return a.startedAt < b.startedAt ? a : b; });
    R.sendNote.textContent = 'Прошло ' + elapsed(first) + '. Обработка продолжается, окно можно закрыть.';
  }

  function statusText(p) {
    if (p.status === 'preparing') return 'Готовим снимок';
    if (p.status === 'ready') return p.heic ? 'Готов, HEIC без превью' : 'Готов к отправке';
    if (p.status === 'queued') return 'В очереди · ' + elapsed(p);
    if (p.status === 'sending') return ({ uploading: 'Загружаем фото', queued: 'В очереди на Mac', recognizing: 'Распознаём флаконы', matching: 'Ищем в каталоге' }[p.phase] || 'Обрабатываем') + ' · ' + elapsed(p);
    if (p.status === 'done') return (p.bottles.length ? 'Найдено: ' + bottlesWord(p.bottles.length) : 'Флаконы не найдены') + ' · ' + elapsed(p);
    return (p.err && p.err.short) || 'Ошибка';
  }

  function trayRow(p, n) {
    if (!p.thumb) {
      p.thumb = p.url
        ? el('img', { class: 'rx-thumb', src: p.url, alt: '', width: 56, height: 56, decoding: 'async' })
        : el('span', { class: 'rx-thumb', text: p.heic ? 'HEIC' : '' });
    }
    var acts = [];
    if (p.status === 'error' && p.err && p.err.retry && !S.unavailable) {
      acts.push(el('button', { type: 'button', class: 'text-btn', 'data-rx-act': 'retry', 'data-rx-key': p.key,
        'data-rx-fk': 'rt-' + p.key, 'data-rx-alt': 'row-' + p.key, 'aria-label': 'Повторить отправку снимка ' + n, text: 'Повторить' }));
    }
    if (REMOVABLE.indexOf(p.status) >= 0) {
      acts.push(el('button', { type: 'button', class: 'text-btn', 'data-rx-act': 'remove', 'data-rx-key': p.key,
        'data-rx-fk': 'rm-' + p.key, 'data-rx-alt': 'row-' + p.key, 'aria-label': 'Убрать снимок ' + n, text: 'Убрать' }));
    }
    return el('li', { class: 'rx-row is-' + p.status, tabindex: '-1', 'data-rx-fk': 'row-' + p.key, 'data-testid': 'rx-photo-' + n }, [
      el('span', { class: 'rx-thumb-wrap', 'aria-hidden': 'true' }, [p.thumb]),
      el('span', { class: 'rx-row-text' }, [
        el('b', { text: 'Снимок ' + n }),
        el('span', { class: 'rx-row-status', 'data-rx-clock': p.key, text: statusText(p) }),
        p.err ? el('span', { class: 'rx-row-msg', text: p.err.text }) : null
      ]),
      acts.length ? el('span', { class: 'rx-row-acts' }, acts) : null
    ]);
  }

  function renderTray() {
    keepFocus(R.tray, function () {
      R.tray.textContent = '';
      S.photos.forEach(function (p, i) { R.tray.appendChild(trayRow(p, i + 1)); });
    });
    R.tray.hidden = !S.photos.length;
    R.tray.setAttribute('aria-label', 'Выбранные снимки: ' + S.photos.length);
    R.clear.hidden = !S.photos.length || busy();
  }

  function renderFoot() {
    var ready = count('ready'), prep = count('preparing'), n = S.inflight + S.queue.length;
    var bulk = bulkList().length, rest = unpicked();
    var sending = ready || prep || n;
    R.foot.hidden = currentMode() !== 'photo' || S.capsState !== 'ok' || !((sending && !S.unavailable) || bulk || S.bulkBusy);
    R.send.hidden = !sending || S.unavailable;
    R.send.classList.toggle('quiet', !ready && (bulk > 0 || S.bulkBusy));
    R.send.textContent = ready ? 'Распознать ' + photosWord(ready)
      : n ? 'Распознаём ' + photosWord(n)
      : prep ? 'Готовим снимки' : 'Распознать';
    if (ready) R.send.removeAttribute('aria-disabled');
    else R.send.setAttribute('aria-disabled', 'true');
    R.bulk.hidden = !(bulk || S.bulkBusy);
    R.bulk.textContent = S.bulkBusy ? 'Добавляем в коллекцию' : 'Добавить отмеченные: ' + bulk;
    if (bulk && !S.bulkBusy) R.bulk.removeAttribute('aria-disabled');
    else R.bulk.setAttribute('aria-disabled', 'true');
    // Честно: отправленный снимок не отменить закрытием окна
    R.sendNote.textContent = n
      ? 'Отправленные снимки обрабатываются, даже если закрыть окно.'
      : (bulk || S.bulkBusy) && rest ? 'Ещё ' + bottlesWord(rest) + ' без выбранного варианта: отметьте вариант ниже.'
      : bulk || S.bulkBusy ? 'Добавятся флаконы с отмеченным вариантом из каталога.'
      : 'Проверьте снимки: после отправки убрать их уже нельзя.';
  }

  // Флаконы, у которых выбран вариант из каталога и которые ещё не сохранены
  function bulkList() {
    var list = [];
    S.photos.forEach(function (p) {
      if (p.status !== 'done') return;
      p.bottles.forEach(function (b) {
        if (b.choice && b.items[b.choice] && b.save.state !== 'saved' && b.save.state !== 'saving') list.push({ p: p, b: b });
      });
    });
    return list;
  }

  function unpicked() {
    var n = 0;
    S.photos.forEach(function (p) {
      if (p.status !== 'done') return;
      p.bottles.forEach(function (b) { if (!b.choice && b.save.state !== 'saved' && b.missing.state !== 'sent') n++; });
    });
    return n;
  }

  // По одному запросу за раз: серверу на REG.RU проще, а каждая карточка показывает свой итог
  function addAll() {
    var list = bulkList();
    if (!list.length || S.bulkBusy) return;
    S.bulkBusy = true;
    var saved = 0;
    renderFoot();
    list.reduce(function (chain, en) {
      return chain.then(function () {
        return confirmBottle(en.p, en.b).then(function () { if (en.b.save.state === 'saved') saved++; });
      });
    }, Promise.resolve()).then(function () {
      S.bulkBusy = false;
      renderFoot();
      announce('Добавлено в коллекцию: ' + bottlesWord(saved) + '.');
    });
  }

  function renderResults() {
    var done = S.photos.filter(function (p) { return p.status === 'done'; });
    Array.prototype.slice.call(R.results.children).forEach(function (node) {
      if (!done.some(function (p) { return p.resEl === node; })) R.results.removeChild(node);
    });
    // Блоки создаются один раз: ввод в поиске и выбор варианта не сбрасываются
    var prev = null;
    done.forEach(function (p) {
      if (!p.resEl) p.resEl = buildResult(p);
      var want = prev ? prev.nextSibling : R.results.firstChild;
      if (want !== p.resEl) R.results.insertBefore(p.resEl, want);
      prev = p.resEl;
      p.resTitle.textContent = 'Снимок ' + num(p);
    });
    R.results.hidden = !done.length;
  }

  function buildResult(p) {
    var id = 'rx-res-' + p.key;
    var n = p.bottles.length;
    p.resTitle = el('h3', { class: 'rx-res-title', id: id });
    var sec = el('section', { class: 'rx-res', 'aria-labelledby': id, 'data-testid': 'rx-result' }, [
      p.resTitle,
      el('p', { class: 'rx-res-sub', text: n
        ? 'Найдено ' + bottlesWord(n) + '. Подтвердите каждый, и он появится в коллекции.'
        : 'Флаконов с читаемой надписью не нашлось. Снимите ближе и при хорошем свете.' })
    ]);
    if (p.url) sec.appendChild(buildStage(p));
    else if (n && p.heic) sec.appendChild(el('p', { class: 'rx-hint', text: 'Превью HEIC в этом браузере недоступно, поэтому рамки флаконов не показаны.' }));
    if (p.warnings.length) sec.appendChild(el('ul', { class: 'rx-warn' }, p.warnings.map(function (w) { return el('li', { text: w }); })));
    if (n) sec.appendChild(el('ol', { class: 'rx-bottles' }, p.bottles.map(function (b, i) { return buildBottle(p, b, i); })));
    return sec;
  }

  // Снимок и рамки в долях от сторон: рамка всегда на своём флаконе при любой ширине
  function buildStage(p) {
    var withBoxes = p.bottles.some(function (b) { return b.bbox; });
    var stage = el('div', { class: 'rx-stage' }, [
      el('img', { class: 'rx-stage-img', src: p.url, width: p.w, height: p.h, decoding: 'async',
        alt: withBoxes ? 'Снимок с отмеченными флаконами' : 'Отправленный снимок' })
    ]);
    stage.style.setProperty('--r', (p.w / p.h).toFixed(5));
    p.bottles.forEach(function (b, i) {
      if (!b.bbox) return;
      var box = el('span', { class: 'rx-box', 'aria-hidden': 'true', 'data-rx-box': b.key }, [
        el('span', { class: 'rx-box-n', text: String(i + 1) })
      ]);
      box.style.left = (b.bbox[0] * 100).toFixed(3) + '%';
      box.style.top = (b.bbox[1] * 100).toFixed(3) + '%';
      box.style.width = (b.bbox[2] * 100).toFixed(3) + '%';
      box.style.height = (b.bbox[3] * 100).toFixed(3) + '%';
      b.boxEl = box;
      stage.appendChild(box);
    });
    p.stage = stage;
    return stage;
  }

  /* ========== Флаконы: надпись, уверенность, варианты, подтверждение ========== */

  function displayName(b) { return [b.brand, b.name].filter(Boolean).join(' '); }
  function defaultQuery(b) { return displayName(b) || b.text.slice(0, 80); }

  function buildBottle(p, b, i) {
    var n = i + 1;
    var li = el('li', { class: 'rx-bottle', 'data-testid': 'rx-bottle' });
    b.li = li;
    b.n = n;
    var head = el('div', { class: 'rx-b-head' }, [
      el('span', { class: 'rx-b-n', 'aria-hidden': 'true', text: String(n) }),
      el('div', { class: 'rx-b-title' }, [
        el('p', { class: 'rx-b-name' }, [el('span', { class: 'vh', text: 'Флакон ' + n + ': ' }), displayName(b) || 'Название не прочитано']),
        b.concentration ? el('p', { class: 'rx-b-meta', text: b.concentration }) : null
      ])
    ]);
    if (b.bbox && p.url) {
      b.showBtn = el('button', { type: 'button', class: 'text-btn rx-show', 'data-rx-act': 'show', 'data-rx-key': b.key,
        'aria-pressed': 'false', 'aria-label': 'Показать флакон ' + n + ' на фото', text: 'На фото' });
      head.appendChild(b.showBtn);
    }
    li.appendChild(head);

    if (b.text) li.appendChild(el('p', { class: 'rx-read' }, [el('span', { class: 'rx-k', text: 'Надпись на этикетке' }), el('q', { text: b.text })]));

    var c = CONF[b.conf];
    li.appendChild(el('div', { class: 'rx-conf is-' + b.conf }, [
      el('span', { class: 'rx-chip' }, [el('span', { class: 'vh', text: 'Уверенность: ' }), c.label]),
      el('p', { text: c.text }),
      b.reason ? el('p', { class: 'rx-reason', text: 'Почему: ' + b.reason }) : null
    ]));

    if (b.alternatives.length) {
      b.altsEl = el('div', { class: 'rx-alts' }, [
        el('p', { class: 'rx-k', text: 'Похоже также на' }),
        el('div', { class: 'rx-chips' }, b.alternatives.map(function (a, j) {
          return el('button', { type: 'button', class: 'rx-alt', 'data-rx-act': 'alt', 'data-rx-key': b.key, 'data-rx-i': j,
            'aria-label': 'Найти в каталоге: ' + a, text: a });
        }))
      ]);
      li.appendChild(b.altsEl);
    }

    b.choicesBox = el('div', { class: 'rx-choices' });
    li.appendChild(b.choicesBox);
    renderChoices(b);
    b.searchWrap = buildSearch(b);
    li.appendChild(b.searchWrap);
    b.actBox = el('div', { class: 'rx-act' });
    li.appendChild(b.actBox);
    renderAct(b);
    return li;
  }

  function option(b, item, src, j) {
    var k = pidKey(item.pid);
    var id = 'rx-o-' + b.key + '-' + src + j;
    return el('label', { class: 'rx-opt', 'for': id }, [
      el('input', { type: 'radio', name: 'rx-pick-' + b.key, id: id, value: k, checked: b.choice === k,
        'data-rx-key': b.key, 'data-rx-fk': 'o-' + b.key + '-' + src + '-' + fkSafe(k) }),
      el('span', { class: 'rx-opt-text' }, [
        el('b', { text: item.name || 'Название не указано' }),
        item.brand ? el('span', { text: item.brand }) : null
      ])
    ]);
  }

  function renderChoices(b) {
    b.choicesBox.textContent = '';
    if (b.catalog === 'candidates' && b.matches.length) {
      var fs = el('fieldset', { class: 'rx-fs' }, [
        el('legend', { text: b.matches.length > 1 ? 'Совпадения в каталоге НОТА' : 'Совпадение в каталоге НОТА' })
      ]);
      b.matches.forEach(function (m, j) { fs.appendChild(option(b, m, 'm', j)); });
      b.choicesBox.appendChild(fs);
    } else {
      b.choicesBox.appendChild(el('p', { class: 'rx-note', text: b.catalog === 'unknown'
        ? 'Каталог для этого флакона не проверялся. Найдите аромат по названию.'
        : 'Аромат распознан. Его карточки пока нет в каталоге НОТА. Можно уточнить название или отправить его на добавление.' }));
    }
  }

  function buildSearch(b) {
    var open = !(b.catalog === 'candidates' && b.matches.length);
    var panelId = 'rx-s-' + b.key, inputId = 'rx-q-' + b.key;
    b.searchOpen = open;
    b.input = el('input', { class: 'field', id: inputId, type: 'search', autocomplete: 'off', autocapitalize: 'off',
      spellcheck: 'false', enterkeyhint: 'search', placeholder: 'Марка и название', 'data-rx-search': b.key, value: defaultQuery(b) });
    b.deb = debounce(function () { runBottleSearch(b, b.input.value); }, 350);
    b.foundBox = el('div', { class: 'rx-found', 'aria-live': 'polite' });
    b.panel = el('div', { class: 'rx-search', id: panelId, hidden: !open }, [
      el('label', { class: 'field-label', 'for': inputId, text: 'Найти в каталоге НОТА' }),
      el('div', { class: 'rx-search-row' }, [
        b.input,
        el('button', { type: 'button', class: 'btn quiet rx-go', 'data-rx-act': 'search-go', 'data-rx-key': b.key,
          'aria-label': 'Найти в каталоге для флакона ' + b.n, text: 'Найти' })
      ]),
      b.foundBox
    ]);
    b.toggle = open ? null : el('button', { type: 'button', class: 'text-btn rx-toggle', 'data-rx-act': 'search-open',
      'data-rx-key': b.key, 'aria-expanded': 'false', 'aria-controls': panelId, text: 'Нет нужного? Найти вручную' });
    return el('div', { class: 'rx-search-wrap' }, [b.toggle, b.panel]);
  }

  function openSearch(b, q, focus) {
    if (!b.searchOpen) {
      b.searchOpen = true;
      b.panel.hidden = false;
      if (b.toggle) { b.toggle.setAttribute('aria-expanded', 'true'); b.toggle.hidden = true; }
      renderAct(b);
    }
    if (typeof q === 'string') { b.input.value = q; runBottleSearch(b, q); }
    if (focus) b.input.focus();
  }

  function runBottleSearch(b, q) {
    q = str(q, 150);
    var seq = ++b.search.seq;
    b.search.q = q;
    if (q.length < 2) { b.search.state = 'idle'; b.search.items = []; renderFound(b); return; }
    if (b.search.state !== 'done') { b.search.state = 'loading'; renderFound(b); }
    searchCatalog(q).then(function (result) {
      var items = result.items;
      if (seq !== b.search.seq) return;
      b.search.state = 'done';
      b.search.items = items;
      b.search.suggestions = result.suggestions;
      items.forEach(function (it) { b.items[pidKey(it.pid)] = it; });
      renderFound(b);
    }, function () {
      if (seq !== b.search.seq) return;
      b.search.state = 'error';
      renderFound(b);
    });
  }

  function renderFound(b) {
    keepFocus(b.foundBox, function () {
      var box = b.foundBox;
      box.textContent = '';
      var st = b.search.state;
      if (st === 'loading') { box.appendChild(el('p', { class: 'rx-hint', text: 'Ищем в каталоге' })); return; }
      if (st === 'error') { box.appendChild(el('p', { class: 'rx-err', text: 'Поиск не ответил. Попробуйте ещё раз.' })); return; }
      if (st !== 'done') return;
      var inMatches = Object.create(null);
      b.matches.forEach(function (m) { inMatches[pidKey(m.pid)] = true; });
      var list = b.search.items.filter(function (it) { return !inMatches[pidKey(it.pid)]; });
      // Выбранный из прошлого поиска вариант не пропадает при новом запросе
      if (b.choice && !inMatches[b.choice] && b.items[b.choice] && !list.some(function (it) { return pidKey(it.pid) === b.choice; })) {
        list.unshift(b.items[b.choice]);
      }
      if (!list.length && (b.search.suggestions || []).length) {
        showSuggestions(box, b.search.suggestions, function (query) { b.input.value = query; runBottleSearch(b, query); });
        return;
      }
      if (!list.length) {
        box.appendChild(el('p', { class: 'rx-hint', text: b.search.items.length
          ? 'Всё найденное уже есть в совпадениях выше.'
          : 'В каталоге НОТА ничего не нашлось по запросу «' + b.search.q + '». Попробуйте только марку.' }));
        return;
      }
      var fs = el('fieldset', { class: 'rx-fs' }, [el('legend', { text: 'Найдено в каталоге' })]);
      list.forEach(function (it, j) { fs.appendChild(option(b, it, 'f', j)); });
      box.appendChild(fs);
    });
  }

  function renderAct(b) {
    keepFocus(b.actBox, function () {
      var box = b.actBox;
      box.textContent = '';
      if (b.save.state === 'saved') {
        box.appendChild(el('p', { class: 'rx-ok', tabindex: '-1', 'data-rx-fk': 'ok-' + b.key, 'data-testid': 'rx-saved',
          text: (b.save.duplicate ? 'Уже есть в вашей коллекции: ' : 'Добавлено в коллекцию: ') + itemLabel(b.save.item) }));
        return;
      }
      var saving = b.save.state === 'saving';
      var can = !!b.choice && !saving;
      var hintId = 'rx-h-' + b.key;
      box.appendChild(el('button', { type: 'button', class: 'btn rx-confirm', 'data-rx-act': 'confirm', 'data-rx-key': b.key,
        'data-rx-fk': 'cf-' + b.key, 'data-rx-alt': 'ok-' + b.key, 'aria-disabled': can ? null : 'true',
        'aria-describedby': b.choice ? null : hintId, 'data-testid': 'rx-confirm',
        text: saving ? 'Сохраняем' : 'Добавить в коллекцию' }));
      if (!b.choice) box.appendChild(el('p', { class: 'rx-hint', id: hintId, text: 'Сначала выберите вариант из каталога.' }));
      if (b.save.state === 'error') box.appendChild(el('p', { class: 'rx-err', text: b.save.msg }));
      // Кандидат на пополнение базы: не добавляет в коллекцию и не заполняет каталог
      if (b.missing.state === 'sent') {
        box.appendChild(el('p', { class: 'rx-sent', tabindex: '-1', 'data-rx-fk': 'ms-' + b.key,
          text: 'Отправлено кандидатом на пополнение каталога. В коллекцию этот флакон не добавлен.' }));
      } else if (b.catalog === 'not_found') {
        var sending = b.missing.state === 'sending';
        box.appendChild(el('button', { type: 'button', class: 'btn quiet', 'data-rx-act': 'missing', 'data-rx-key': b.key,
          'data-rx-fk': 'mi-' + b.key, 'data-rx-alt': 'ms-' + b.key, 'aria-disabled': sending ? 'true' : null,
          text: sending ? 'Отправляем' : 'Нет в каталоге: предложить добавить' }));
        if (b.missing.state === 'error') box.appendChild(el('p', { class: 'rx-err', text: b.missing.msg }));
      }
    });
  }

  function selectBottle(p, b, fromStage) {
    p.selected = (!fromStage && p.selected === b.key) ? null : b.key;
    p.bottles.forEach(function (x) {
      var on = x.key === p.selected;
      if (x.boxEl) x.boxEl.classList.toggle('is-on', on);
      if (x.showBtn) x.showBtn.setAttribute('aria-pressed', String(on));
      if (x.li) x.li.classList.toggle('is-on', on);
    });
    if (p.stage) p.stage.classList.toggle('has-sel', !!p.selected);
    var behavior = reduceMotion.matches ? 'auto' : 'smooth';
    if (fromStage) {
      b.li.scrollIntoView({ block: 'nearest', behavior: behavior });
      if (b.showBtn) b.showBtn.focus({ preventScroll: true });
    } else if (p.selected && p.stage) {
      p.stage.scrollIntoView({ block: 'nearest', behavior: behavior });
    }
  }

  function confirmBottle(p, b) {
    if (!b.choice || b.save.state === 'saving' || b.save.state === 'saved') return Promise.resolve();
    var item = b.items[b.choice];
    if (!item) return Promise.resolve();
    b.save = { state: 'saving' };
    renderAct(b);
    return authed('POST', '/v1/recognition/' + encodeURIComponent(p.recId) + '/confirm', { body: { bottle_id: b.id, pid: item.pid } }, false)
      .then(function (d) {
        if (d.saved !== true) throw { kind: 'bad' };
        var saved = normItem(d.item) || item;
        b.save = { state: 'saved', item: saved, duplicate: d.duplicate === true };
        addMine(saved);
        b.choicesBox.hidden = true;
        b.searchWrap.hidden = true;
        if (b.altsEl) b.altsEl.hidden = true;
        announce((d.duplicate === true ? 'Уже есть в коллекции: ' : 'Добавлено в коллекцию: ') + itemLabel(saved) + '.');
      })
      .catch(function (e) { b.save = { state: 'error', msg: actionError(e) }; })
      .then(function () { renderAct(b); renderHero(); if (R) renderFoot(); });
  }

  function sendMissing(p, b) {
    if (b.missing.state === 'sending' || b.missing.state === 'sent' || b.save.state === 'saved') return;
    b.missing = { state: 'sending' };
    renderAct(b);
    authed('POST', '/v1/recognition/' + encodeURIComponent(p.recId) + '/missing', { body: { bottle_id: b.id } }, false)
      .then(function (d) {
        if (d.saved !== true) throw { kind: 'bad' };
        b.missing = { state: 'sent' };
        announce('Отправлено кандидатом на пополнение каталога.');
      })
      .catch(function (e) { b.missing = { state: 'error', msg: actionError(e) }; })
      .then(function () { renderAct(b); renderHero(); });
  }

  /* ========== Добавление по названию: поиск в каталоге и сохранение через сервер ========== */

  // state: idle | short | loading | done | error. add: pid -> { state: saving | saved | dup | error, msg }
  var free = { seq: 0, q: '', state: 'idle', items: [], suggestions: [], known: Object.create(null), add: Object.create(null) };
  var freeDeb = debounce(function () { runFree(R.freeQ.value); }, 350);

  function runFree(q) {
    q = str(q, 150);
    var seq = ++free.seq;
    free.q = q;
    if (q.length < 2) {
      free.state = q ? 'short' : 'idle';
      free.items = [];
      renderFree();
      return;
    }
    // Прежние результаты остаются на месте до ответа: список не мигает при наборе
    free.state = 'loading';
    renderFree();
    searchCatalog(q).then(function (result) {
      var items = result.items;
      if (seq !== free.seq) return;
      free.state = 'done';
      free.items = items;
      free.suggestions = result.suggestions;
      items.forEach(function (it) { free.known[pidKey(it.pid)] = it; });
      renderFree();
    }, function () {
      if (seq !== free.seq) return;
      free.state = 'error';
      free.items = [];
      renderFree();
    });
  }

  function mineHas(k) { return S.mine.items.some(function (it) { return pidKey(it.pid) === k; }); }

  function freeRow(it) {
    var k = pidKey(it.pid);
    var a = free.add[k] || { state: 'idle' };
    var st = a.state;
    // Уже сохранённый в коллекции показываем сразу, без лишнего запроса
    if ((st === 'idle' || st === 'error') && mineHas(k)) st = 'have';
    var done = st === 'saved' || st === 'dup' || st === 'have';
    var label = st === 'saving' ? 'Добавляем'
      : st === 'saved' ? 'Добавлено'
      : done ? 'Уже в коллекции'
      : 'Добавить';
    var errId = 'rx-fe-' + fkSafe(k);
    var btn = el('button', {
      type: 'button', class: 'btn rx-add' + (done ? ' quiet is-done' : '') + (st === 'saving' ? ' is-saving' : ''),
      'data-rx-act': 'free-add', 'data-rx-pid': k, 'data-rx-fk': 'add-' + fkSafe(k), 'data-testid': 'rx-free-add',
      'data-state': st, 'aria-disabled': st === 'saving' || done || free.state === 'loading' ? 'true' : null,
      'aria-describedby': st === 'error' ? errId : null,
      'aria-label': label + ': ' + itemLabel(it), text: label
    });
    return el('li', { class: 'rx-free-item', 'data-testid': 'rx-free-item' }, [
      el('span', { class: 'rx-free-text' }, [
        el('b', { text: it.name || 'Название не указано' }),
        it.brand ? el('span', { text: it.brand }) : null
      ]),
      btn,
      st === 'error' ? el('p', { class: 'rx-err rx-free-err', id: errId, text: a.msg }) : null
    ]);
  }

  function showSuggestions(parent, items, choose) {
    if (!items.length) return;
    var panel = el('section', { class: 'rx-suggestions', 'data-testid': 'rx-suggestions' }, [
      el('h3', { text: 'Возможно, вы искали' }),
      el('p', { class: 'rx-hint', text: 'Это похожие написания. Выберите вариант, чтобы уточнить поиск.' })
    ]);
    items.forEach(function (item) {
      var button = el('button', { type: 'button', class: 'btn quiet', text: itemLabel(item), 'data-testid': 'rx-suggestion' });
      button.addEventListener('click', function () { choose(item.query); });
      panel.appendChild(button);
    });
    parent.appendChild(panel);
  }

  function renderFree() {
    if (!R) return;
    var st = free.state, n = free.items.length;
    var text = st === 'short' ? 'Введите хотя бы две буквы.'
      : st === 'loading' ? 'Ищем в каталоге'
      : st === 'error' ? 'Поиск не ответил. Проверьте интернет и нажмите «Найти».'
      : st === 'done' && !n && free.suggestions.length ? 'Точного совпадения нет. Проверьте варианты ниже.'
      : st === 'done' && !n ? 'Ничего не нашлось по запросу «' + free.q + '». Попробуйте только марку или другое написание.'
      : st === 'done' ? 'Найдено: ' + n + '. Нажмите «Добавить» у нужного аромата.'
      : '';
    // Статус «Ищем» не повторяем на каждую букву: читалка экрана не должна тараторить
    if (R.freeStatus.textContent !== text) R.freeStatus.textContent = text;
    R.freeStatus.classList.toggle('rx-err', st === 'error');
    keepFocus(R.freeResults, function () {
      R.freeResults.textContent = '';
      free.items.forEach(function (it) { R.freeResults.appendChild(freeRow(it)); });
    });
    R.freeSuggestions.textContent = '';
    if (st === 'done' && !n) showSuggestions(R.freeSuggestions, free.suggestions, function (query) { R.freeQ.value = query; runFree(query); });
    R.freeResults.hidden = !n;
    if (st === 'loading') R.freeResults.setAttribute('aria-busy', 'true');
    else R.freeResults.removeAttribute('aria-busy');
  }

  // Сохранение только через сервер: успех показываем лишь после ответа saved:true
  function addFree(k) {
    if (free.state !== 'done') return;
    var it = free.known[k];
    if (!it) return;
    var cur = free.add[k];
    if (cur && (cur.state === 'saving' || cur.state === 'saved' || cur.state === 'dup')) return;
    if (mineHas(k)) return;
    free.add[k] = { state: 'saving' };
    renderFree();
    authed('POST', '/v1/recognition/collection', { body: { pid: String(it.pid) } }, true)
      .then(function (d) {
        if (d.saved !== true) throw { kind: 'bad' };
        var saved = normItem(d.item) || it;
        var dup = d.duplicate === true;
        free.add[k] = { state: dup ? 'dup' : 'saved' };
        addMine(saved);
        announce((dup ? 'Уже в коллекции: ' : 'Добавлено в коллекцию: ') + itemLabel(saved) + '.');
      })
      .catch(function (e) {
        var msg = addError(e);
        free.add[k] = { state: 'error', msg: msg };
        announce(msg);
      })
      .then(renderFree);
  }

  function setMode(m, from) {
    if (m !== 'name' && m !== 'photo') return;
    S.mode = m;
    render();
    R.d.scrollTop = 0;
    // Кнопка внутри панели исчезает вместе с ней: фокус переходит на переключатель
    if (from && !R.seg.contains(from)) {
      var b = R.seg.querySelector('[data-rx-mode="' + currentMode() + '"]');
      (visible(b) ? b : R.title).focus({ preventScroll: true });
    }
  }

  /* ========== Экранная клавиатура iPhone: лист остаётся над ней ========== */

  function fitViewport() {
    var vv = window.visualViewport;
    if (!R || !R.d.open || !vv) return;
    var kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    R.d.style.setProperty('--rx-kb', kb + 'px');
    R.d.style.setProperty('--rx-vh', Math.round(vv.height) + 'px');
    R.d.classList.toggle('has-kb', kb > 80);
    var a = document.activeElement;
    if (kb > 80 && a && a.tagName === 'INPUT' && R.d.contains(a)) a.scrollIntoView({ block: 'nearest' });
  }
  function watchViewport(on) {
    var vv = window.visualViewport;
    if (!vv) return;
    var fn = on ? 'addEventListener' : 'removeEventListener';
    vv[fn]('resize', fitViewport);
    vv[fn]('scroll', fitViewport);
    if (on) fitViewport();
    else if (R) { R.d.style.removeProperty('--rx-kb'); R.d.style.removeProperty('--rx-vh'); R.d.classList.remove('has-kb'); }
  }

  /* ========== Моя коллекция: только позиции каталога, сохранённые сервером (по названию и по фото) ========== */

  function sameItems(list) {
    var seen = Object.create(null);
    return list.filter(function (it) {
      var k = pidKey(it.pid);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  function addMine(item) {
    S.mine.items = sameItems([item].concat(S.mine.items));
    if (S.mine.state !== 'loading') S.mine.state = 'ok';
    renderMine();
  }

  function loadMine() {
    // Без сессии коллекции ещё нет: сессию ради пустого списка не создаём
    if (!token) { S.mine.state = 'ok'; renderMine(); return; }
    S.mine.state = 'loading';
    renderMine();
    authed('GET', '/v1/recognition/collection', {}, false).then(function (d) {
      var server = (Array.isArray(d.items) ? d.items : []).map(normItem).filter(Boolean);
      S.mine.items = sameItems(server.concat(S.mine.items));
      S.mine.state = 'ok';
    }, function (e) {
      S.mine.state = e && e.status === 401 ? 'ok' : 'error';
    }).then(renderMine);
  }

  function renderMine() {
    var list = $('rx-mine-list'), st = $('rx-mine-state'), cnt = $('rx-mine-count');
    if (!list || !st) return;
    var items = S.mine.items;
    Array.prototype.forEach.call(list.querySelectorAll('[data-testid=rx-mine-item]'), function (row) { row.remove(); });
    items.forEach(function (it) {
      list.appendChild(el('li', { class: 'item', 'data-testid': 'rx-mine-item' }, [
        el('div', { class: 'item-head' }, [
          el('span', { class: 'dot rx-mine-dot', 'aria-hidden': 'true' }),
          el('span', { class: 'item-name' }, [
            el('span', { class: 'rx-mine-name', title: it.name || '', text: it.name || 'Название не указано' }),
            it.brand ? el('span', { class: 'item-meta', text: it.brand }) : null
          ])
        ])
      ]));
    });
    list.hidden = false;
    var subtitle = document.querySelector('.rx-mine-sub');
    if (subtitle) subtitle.hidden = !items.length;
    if (cnt) cnt.textContent = items.length ? String(items.length) : '';
    st.textContent = '';
    if (S.mine.state === 'error') {
      st.appendChild(el('div', { class: 'rx-mine-note' }, [
        el('p', { text: 'Не удалось загрузить коллекцию.' }),
        el('button', { type: 'button', class: 'btn quiet', 'data-rx-act': 'mine-retry', text: 'Повторить' })
      ]));
    } else if (!items.length && S.mine.state === 'loading') {
      st.appendChild(el('p', { class: 'rx-mine-note', text: 'Загружаем коллекцию' }));
    }
    window.dispatchEvent(new CustomEvent('nota-collection-changed'));
    // Кнопки поиска знают, что уже лежит в коллекции
    renderFree();
  }

  function renderHero() {
    var s = $('rx-hero-state');
    if (!s) return;
    var n = S.inflight + S.queue.length;
    var pending = 0;
    S.photos.forEach(function (p) {
      if (p.status !== 'done') return;
      p.bottles.forEach(function (b) { if (b.save.state !== 'saved' && b.missing.state !== 'sent') pending++; });
    });
    var t = n ? 'Распознаём ' + photosWord(n)
      : pending ? 'Ждут подтверждения: ' + bottlesWord(pending) : '';
    s.textContent = t;
    s.hidden = !t;
  }

  /* ========== Возможности сервиса ========== */

  function connectPersonal() {
    if (!personalInvite) return Promise.resolve();
    if (!personalWait) {
      personalWait = authed('POST', '/v1/phone/unlock', { body: { invite: personalInvite } }, true).catch(function (e) {
        if (e && e.status === 401) return authed('POST', '/v1/phone/unlock', { body: { invite: personalInvite } }, true);
        throw e;
      }).then(function () {
        personalInvite = null;
        S.mode = 'photo';
      });
      personalWait.catch(function () { personalWait = null; });
    }
    return personalWait;
  }

  function loadCaps(force) {
    if (S.capsState === 'loading' || (S.capsState === 'ok' && !force)) return;
    S.capsState = 'loading';
    render();
    ensureSession().then(connectPersonal).then(function () { return api('POST', '/v1/recognition/capabilities', { token: token, body: {} }); }).then(function (d) {
      var bytes = Number(d.max_bytes);
      S.caps = {
        configured: d.configured === true,
        personalAccess: d.personal_access === true,
        personalMode: d.personal_mode === true,
        publicUploads: d.public_uploads === true,
        maxBytes: bytes > 0 && isFinite(bytes) ? bytes : DEFAULT_MAX_BYTES,
        types: Array.isArray(d.accepted_types) ? d.accepted_types.filter(function (x) { return typeof x === 'string'; }) : []
      };
      S.unavailable = !S.caps.configured;
      S.capsState = 'ok';
    }).catch(function () {
      S.capsState = 'error';
    }).then(function () {
      pump();
      render();
    });
  }

  /* ========== Лист: нативный dialog, Escape, ловушка фокуса, возврат фокуса ========== */

  function ensureSheet() {
    if (R) return;
    document.body.appendChild(tpl.content.cloneNode(true));
    var d = $('sheet-photo');
    var q = function (name) { return d.querySelector('[data-rx="' + name + '"]'); };
    R = {
      d: d, title: $('rx-title'), opener: null,
      seg: q('seg'), paneName: q('pane-name'), panePhoto: q('pane-photo'), photoNote: q('photo-note'),
      caps: q('caps'), capsError: q('caps-error'), photoOff: q('photo-off'), intake: q('intake'),
      lead: q('lead'), file: q('file'), camera: q('camera'), limit: q('limit'), tray: q('tray'),
      results: q('results'), clear: q('clear'), live: q('live'),
      foot: q('foot'), send: q('send'), bulk: q('bulk'), sendNote: q('send-note'),
      freeQ: q('free-q'), freeResults: q('free-results'), freeStatus: q('free-status')
    };
    R.freeSuggestions = el('div', { 'data-rx': 'free-suggestions' });
    R.freeResults.insertAdjacentElement('afterend', R.freeSuggestions);
    bindSheet();
    renderFree();
  }

  function openSheet(from) {
    ensureSheet();
    R.opener = from || document.activeElement;
    if (!R.d.open) {
      if (typeof R.d.showModal === 'function') R.d.showModal();
      else R.d.setAttribute('open', '');
    }
    document.documentElement.classList.add('is-locked');
    watchViewport(true);
    R.d.scrollTop = 0;
    // Фокус на заголовок, а не на поле: клавиатура не выезжает сама при открытии
    R.title.focus({ preventScroll: true });
    // Сервис мог выключиться или включиться: проверяем заново, если он был недоступен
    loadCaps(S.unavailable || S.capsState === 'error');
    render();
  }

  function closeSheet() {
    if (!R || !R.d.open) return;
    if (typeof R.d.close === 'function') R.d.close();
    else { R.d.removeAttribute('open'); onClose(); }
  }

  function onClose() {
    watchViewport(false);
    var others = Array.prototype.some.call(document.querySelectorAll('dialog'), function (x) { return x.open; });
    if (others) return;
    document.documentElement.classList.remove('is-locked');
    var o = R.opener;
    if (!o || !document.body.contains(o) || !o.getClientRects().length) o = openBtn;
    if (!o.getClientRects().length) o = document.querySelector('.view:not([hidden]) .view-title');
    if (o) o.focus({ preventScroll: true });
    R.opener = null;
  }

  function trapTab(e) {
    var list = Array.prototype.filter.call(
      R.d.querySelectorAll('button, input:not([type="radio"]), a[href], [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.getClientRects().length > 0; }
    );
    if (!list.length) return;
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function entry(key) { return key ? S.byKey[key] : null; }
  function photoByKey(key) { return S.photos.filter(function (p) { return p.key === key; })[0]; }

  function bindSheet() {
    var d = R.d;
    R.camera.parentNode.addEventListener('click', function (e) {
      if (!canSeries()) return; // старый браузер: остаётся системная камера на один кадр
      e.preventDefault();
      openCamera();
    });
    d.addEventListener('cancel', function (e) { e.preventDefault(); closeSheet(); });
    d.addEventListener('close', onClose);
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return trapTab(e);
      if (e.key !== 'Enter') return;
      var t = e.target;
      if (t === R.freeQ) {
        e.preventDefault();
        runFree(t.value);
        // На телефоне «Найти» убирает клавиатуру, чтобы результаты были видны целиком
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) t.blur();
        return;
      }
      var en = entry(t.getAttribute && t.getAttribute('data-rx-search'));
      if (en) { e.preventDefault(); runBottleSearch(en.b, t.value); }
    });

    d.addEventListener('click', function (e) {
      // Нажатие по затемнению вне листа закрывает его
      if (e.target === d) {
        // Двойное нажатие на «Готово» в камере не должно закрыть лист с результатами
        if (cam && Date.now() - (cam.closedAt || 0) < 600) return;
        var r = d.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet();
        return;
      }
      var boxEl = e.target.closest ? e.target.closest('[data-rx-box]') : null;
      if (boxEl) {
        var hit = entry(boxEl.getAttribute('data-rx-box'));
        if (hit) selectBottle(hit.p, hit.b, true);
        return;
      }
      var t = e.target.closest ? e.target.closest('[data-rx-act]') : null;
      if (!t || !d.contains(t)) return;
      if (t.getAttribute('aria-disabled') === 'true') return;
      var act = t.getAttribute('data-rx-act');
      var key = t.getAttribute('data-rx-key');
      var en = entry(key);
      if (act === 'close') return closeSheet();
      if (act === 'mode') return setMode(t.getAttribute('data-rx-mode'), t);
      if (act === 'free-add') return addFree(t.getAttribute('data-rx-pid'));
      if (act === 'caps-retry') return loadCaps(true);
      if (act === 'send') return sendReady();
      if (act === 'bulk') return addAll();
      if (act === 'clear') return clearAll();
      if (act === 'retry') return retry(photoByKey(key));
      if (act === 'remove') return removePhoto(photoByKey(key));
      if (act === 'free-go') return runFree(R.freeQ.value);
      if (!en) return;
      if (act === 'show') return selectBottle(en.p, en.b, false);
      if (act === 'alt') return openSearch(en.b, en.b.alternatives[Number(t.getAttribute('data-rx-i'))] || '', false);
      if (act === 'search-open') return openSearch(en.b, null, true);
      if (act === 'search-go') return runBottleSearch(en.b, en.b.input.value);
      if (act === 'confirm') return confirmBottle(en.p, en.b);
      if (act === 'missing') return sendMissing(en.p, en.b);
    });

    d.addEventListener('change', function (e) {
      var t = e.target;
      if (t === R.file || t === R.camera) {
        addFiles(t.files);
        t.value = ''; // тот же файл можно выбрать снова
        return;
      }
      if (t.type === 'radio') {
        var en = entry(t.getAttribute('data-rx-key'));
        if (!en || en.b.save.state === 'saving' || en.b.save.state === 'saved') return;
        en.b.choice = t.value;
        if (en.b.save.state === 'error') en.b.save = { state: 'idle' };
        renderAct(en.b);
        renderFoot();
      }
    });

    d.addEventListener('input', function (e) {
      var t = e.target;
      if (t === R.freeQ) return freeDeb();
      var en = entry(t.getAttribute && t.getAttribute('data-rx-search'));
      if (en) en.b.deb();
    });
  }

  /* ========== Старт ========== */

  openBtn.addEventListener('click', function () { openSheet(openBtn); });
  var mineState = $('rx-mine-state');
  if (mineState) {
    mineState.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-rx-act="mine-retry"]') : null;
      if (!t) return;
      loadMine();
      var h = $('rx-mine-title');
      if (h) h.focus({ preventScroll: true });
    });
  }
  // «Назад» браузера закрывает лист, чтобы он не остался поверх другой вкладки
  window.addEventListener('hashchange', function () { closeCamera(); closeSheet(); });
  // Ссылка может открыться в уже работающей вкладке без загрузки скриптов заново.
  window.addEventListener('nota-personal-invite', function () {
    personalInvite = window.notaPersonalInvite || null;
    delete window.notaPersonalInvite;
    if (!personalInvite) return;
    personalWait = null;
    S.capsState = 'idle';
    setTimeout(function () { openSheet(openBtn); }, 0);
  });

  window.NotaCollection = {
    items: function () { return S.mine.items.slice(); },
    request: function (method, path, body) { return authed(method, path, body === undefined ? {} : { body: body }, true); }
  };
  renderMine();
  renderHero();
  loadMine();
  if (personalInvite) openSheet(openBtn);
})();
