/* НОТА Sapphire: мобильный прототип.
   Порядок файла: данные -> чистые функции -> хранилище -> состояние и переходы -> рендер -> навигация, листы, свайп.
   Без сети, библиотек и внешних API. */
(function () {
  'use strict';

  /* ========== Данные (демо) ========== */

  // Аккорды: русские названия и оттенок жидкости в пробнике
  var ACC = {
    citrus: 'цитрус', green: 'зелень', tea: 'чай', floral: 'цветы', powder: 'пудра', sweet: 'сладость',
    wood: 'дерево', resin: 'смолы', smoke: 'дымка', leather: 'замша', musk: 'мускус', spice: 'специи'
  };
  var ACC_ORDER = Object.keys(ACC);
  var TINT = {
    citrus: '#E3D28A', green: '#9DB48A', tea: '#C49D6A', floral: '#D9A9B2', powder: '#C8B8D6', sweet: '#D6A866',
    wood: '#B0936C', resin: '#C4894A', smoke: '#8E99A8', leather: '#A07E66', musk: '#D5DCE6', spice: '#C77E5E'
  };
  var CTX = Object.assign(Object.create(null), {
    day: { label: 'День', gen: 'дня', adv: 'днём' },
    evening: { label: 'Вечер', gen: 'вечера', adv: 'вечером' },
    special: { label: 'Особый случай', gen: 'особого случая', adv: 'в особый случай' }
  });
  var RATING = Object.assign(Object.create(null), {
    love: { label: 'Люблю', w: 2 },
    like: { label: 'Нравится', w: 1 },
    dislike: { label: 'Не моё', w: -1 },
    unknown: { label: 'Не знаю', w: 0 }
  });
  var SOURCES = ['deck', 'search', 'example', 'trial'];

  // Демонстрационный каталог: авторские названия и условные марки, не товары
  var CATALOG = [
    { id: 'c01', name: 'Кедровая стружка', brand: 'Студия Север', acc: { wood: 2, resin: 1, smoke: 1 }, ctx: ['day', 'evening'], notes: ['кедр', 'ладан', 'сухая кора'], mood: 'сухое светлое дерево с тонкой смолой' },
    { id: 'c02', name: 'Инжирный лист', brand: 'Дом Лён', acc: { green: 2, wood: 1, musk: 1 }, ctx: ['day'], notes: ['инжирный лист', 'зелёный сок', 'светлое дерево'], mood: 'зелёный лист на мягкой древесной основе' },
    { id: 'c03', name: 'Холодный чай', brand: 'Дом Лён', acc: { tea: 2, citrus: 1, musk: 1 }, ctx: ['day'], notes: ['чёрный чай', 'бергамот', 'чистый мускус'], mood: 'прохладный чай с бергамотом' },
    { id: 'c04', name: 'Тёмный мёд', brand: 'Ателье Сумерки', acc: { sweet: 2, resin: 1, spice: 1 }, ctx: ['evening', 'special'], notes: ['мёд', 'бензоин', 'гвоздика'], mood: 'густой мёд со специями' },
    { id: 'c05', name: 'Ирис и замша', brand: 'Ателье Сумерки', acc: { powder: 2, leather: 1, floral: 1 }, ctx: ['evening', 'special'], notes: ['ирис', 'фиалка', 'замша'], mood: 'пудровый ирис на мягкой замше' },
    { id: 'c06', name: 'Соль на коже', brand: 'Студия Север', acc: { musk: 2, citrus: 1 }, ctx: ['day'], notes: ['морская соль', 'мускус', 'лайм'], mood: 'чистая кожа после моря' },
    { id: 'c07', name: 'Тлеющий ветивер', brand: 'Студия Север', acc: { wood: 2, smoke: 2, green: 1 }, ctx: ['evening'], notes: ['ветивер', 'берёзовый дёготь', 'сухая трава'], mood: 'ветивер с дымом, суше и темнее' },
    { id: 'c08', name: 'Бергамот и мох', brand: 'Дом Лён', acc: { citrus: 2, green: 1, wood: 1 }, ctx: ['day'], notes: ['бергамот', 'дубовый мох', 'кедр'], mood: 'яркое начало, мох и кедр в основе' },
    { id: 'c09', name: 'Ладан и перец', brand: 'Ателье Сумерки', acc: { resin: 2, spice: 1, smoke: 1 }, ctx: ['evening', 'special'], notes: ['ладан', 'чёрный перец', 'гваяковое дерево'], mood: 'ладан с перцем, сухо и собранно' },
    { id: 'c10', name: 'Ванильная амбра', brand: 'Ателье Сумерки', acc: { sweet: 2, resin: 2 }, ctx: ['evening', 'special'], notes: ['ваниль', 'амбра', 'бобы тонка'], mood: 'тёплая сладкая амбра' },
    { id: 'c11', name: 'Белый сандал', brand: 'Студия Север', acc: { wood: 2, musk: 1, powder: 1 }, ctx: ['day', 'evening'], notes: ['сандал', 'белый мускус', 'рисовая пудра'], mood: 'гладкое сливочное дерево' },
    { id: 'c12', name: 'Сухая роза', brand: 'Дом Лён', acc: { floral: 2, wood: 1, spice: 1 }, ctx: ['special'], notes: ['роза', 'кедр', 'розовый перец'], mood: 'роза без сладости, на дереве' },
    { id: 'c13', name: 'Копчёный чай', brand: 'Студия Север', acc: { tea: 2, smoke: 1, leather: 1 }, ctx: ['evening'], notes: ['лапсанг', 'замша', 'берёзовый дым'], mood: 'дымный чай и мягкая кожа' },
    { id: 'c14', name: 'Табак и тонка', brand: 'Ателье Сумерки', acc: { leather: 2, sweet: 1, wood: 1 }, ctx: ['evening', 'special'], notes: ['табачный лист', 'бобы тонка', 'кожа'], mood: 'табак и кожа, чуть сладко' }
  ];
  var BY_ID = Object.create(null);
  CATALOG.forEach(function (f) { BY_ID[f.id] = f; });

  // Порядок колоды: соседние карточки разные по характеру
  var DECK_ORDER = ['c01', 'c04', 'c02', 'c10', 'c03', 'c07', 'c05', 'c08', 'c09', 'c06', 'c12', 'c11', 'c13', 'c14'];

  // Три образа из Graphite, переложенные на оценки демо-каталога
  var EXAMPLES = [
    { id: 'wood', name: 'Древесный', text: 'Любит кедр и ветивер с дымом, мёд не своё.',
      ratings: { c01: 'love', c07: 'like', c11: 'like', c04: 'dislike' } },
    { id: 'green', name: 'Зелёный', text: 'Инжирный лист, холодный чай и соль. Сладкая амбра не своё.',
      ratings: { c02: 'love', c03: 'like', c06: 'like', c10: 'dislike' } },
    { id: 'warm', name: 'Тёплый', text: 'Мёд, амбра и ладан. Холодный чай не своё. Попробуйте с «Без сладкого».',
      ratings: { c04: 'love', c10: 'like', c09: 'like', c03: 'dislike' } }
  ];
  var EX_BY_ID = Object.create(null);
  EXAMPLES.forEach(function (e) { EX_BY_ID[e.id] = e; });

  var KIT_MAX = 3;

  /* ========== Чистые функции: профиль, рейтинг, тексты ========== */

  function byAccOrder(a, b) { return ACC_ORDER.indexOf(a) - ACC_ORDER.indexOf(b); }

  function joinRu(list) {
    if (list.length < 2) return list.join('');
    return list.slice(0, -1).join(', ') + ' и ' + list[list.length - 1];
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  // Профиль: сумма аккордов с весом оценки. «Не знаю» веса не имеет
  function profileOf(ratings) {
    var P = {};
    Object.keys(ratings).forEach(function (id) {
      var f = BY_ID[id], r = ratings[id];
      if (!f || !r || !RATING[r.r]) return;
      var w = RATING[r.r].w;
      if (!w) return;
      Object.keys(f.acc).forEach(function (k) { P[k] = (P[k] || 0) + w * f.acc[k]; });
    });
    return P;
  }

  function statsOf(ratings) {
    var s = { love: 0, like: 0, dislike: 0, unknown: 0, trial: 0 };
    Object.keys(ratings).forEach(function (id) {
      var r = ratings[id];
      if (!r || !RATING[r.r]) return;
      s[r.r]++;
      if (r.src === 'trial') s.trial++;
    });
    s.positive = s.love + s.like;
    s.meaningful = s.positive + s.dislike;
    return s;
  }

  function rankedAccords(P) {
    var keys = Object.keys(P);
    return {
      pos: keys.filter(function (k) { return P[k] > 0; }).sort(function (a, b) { return P[b] - P[a] || byAccOrder(a, b); }),
      neg: keys.filter(function (k) { return P[k] < 0; }).sort(function (a, b) { return P[a] - P[b] || byAccOrder(a, b); })
    };
  }

  // Модель карты: доля от ведущего аккорда и словесный ярус, без процентов
  function mapModel(P) {
    var r = rankedAccords(P);
    var max = r.pos.length ? P[r.pos[0]] : 0;
    return {
      rows: r.pos.slice(0, 6).map(function (k, i) {
        var share = P[k] / max;
        return { k: k, label: ACC[k], share: share, tier: i === 0 ? 'ведущий' : share >= 0.5 ? 'заметный' : 'фон' };
      }),
      neg: r.neg.map(function (k) { return ACC[k]; })
    };
  }

  // Что поменялось в профиле после действия
  function profileDelta(P0, P1) {
    var keys = {};
    Object.keys(P0).concat(Object.keys(P1)).forEach(function (k) { keys[k] = true; });
    var diffs = Object.keys(keys).map(function (k) { return { k: k, d: (P1[k] || 0) - (P0[k] || 0) }; })
      .filter(function (x) { return x.d !== 0; })
      .sort(function (a, b) { return Math.abs(b.d) - Math.abs(a.d) || byAccOrder(a.k, b.k); })
      .slice(0, 3);
    return {
      up: diffs.filter(function (x) { return x.d > 0; }).map(function (x) { return x.k; }),
      down: diffs.filter(function (x) { return x.d < 0; }).map(function (x) { return x.k; })
    };
  }

  function deltaText(d) {
    var parts = [];
    if (d.up.length) parts.push(joinRu(d.up.map(function (k) { return ACC[k]; })) + ' сильнее');
    if (d.down.length) parts.push(joinRu(d.down.map(function (k) { return ACC[k]; })) + ' слабее');
    return parts.length ? 'Карта вкуса: ' + parts.join(', ') + '.' : '';
  }

  function insightText(P, st) {
    if (!st.meaningful) return 'Карта заполнится после первых ответов. «Не знаю» её не меняет.';
    var r = rankedAccords(P);
    if (!r.pos.length) {
      return 'Пока известно только, что не ваше: ' + joinRu(r.neg.slice(0, 3).map(function (k) { return ACC[k]; })) +
        '. Отметьте аромат, который нравится, и появится направление.';
    }
    var t = 'Ведущее: ' + ACC[r.pos[0]] + '.';
    if (r.pos.length > 1) t += ' Рядом ' + joinRu(r.pos.slice(1, 3).map(function (k) { return ACC[k]; })) + '.';
    return t;
  }

  function leadAccord(f) {
    return Object.keys(f.acc).sort(function (a, b) { return f.acc[b] - f.acc[a] || byAccOrder(a, b); })[0];
  }
  function dot(P, f) {
    return Object.keys(f.acc).reduce(function (s, k) { return s + (P[k] || 0) * f.acc[k]; }, 0);
  }
  function weightSum(f) {
    return Object.keys(f.acc).reduce(function (s, k) { return s + f.acc[k]; }, 0);
  }
  function isSweet(f) { return (f.acc.sweet || 0) > 0; }

  // Ближайший из любимых: больше общих аккордов, при равенстве «Люблю» важнее
  function nearestLiked(f, ratings) {
    var best = null, bestN = 0, bestW = 0;
    Object.keys(ratings).forEach(function (id) {
      var r = ratings[id], g = BY_ID[id];
      if (!g || !r || (r.r !== 'love' && r.r !== 'like')) return;
      var shared = Object.keys(f.acc).filter(function (k) { return g.acc[k]; });
      var w = RATING[r.r].w;
      if (shared.length > bestN || (shared.length === bestN && shared.length && w > bestW)) {
        best = { f: g, shared: shared.sort(byAccOrder) }; bestN = shared.length; bestW = w;
      }
    });
    return best;
  }

  function explain(x, kind, P, ratings, ctx) {
    var f = x.f;
    var near = nearestLiked(f, ratings);
    var top = rankedAccords(P).pos;
    var t = near
      ? 'Общее с «' + near.f.name + '»: ' + joinRu(near.shared.map(function (k) { return ACC[k]; })) + '.'
      : 'Держится на ведущем аккорде профиля: ' + ACC[top[0]] + '.';
    if (kind === 'side') t += ' Другой акцент: ' + ACC[x.lead] + '.';
    if (x.fit) t += ' Уместен ' + CTX[ctx].adv + '.';
    else if (kind === 'ctx-miss') t += ' Для ' + CTX[ctx].gen + ' подходящих в демо-каталоге не осталось, это следующий по вкусу.';
    var risky = Object.keys(f.acc).filter(function (k) { return (P[k] || 0) < 0; }).sort(byAccOrder);
    if (risky.length) t += ' Есть немного: ' + joinRu(risky.map(function (k) { return ACC[k]; })) + '. Вы отмечали это как не своё.';
    return t;
  }

  /* Подбор: до трёх пробников. Оценённые «Нравится», «Люблю» и «Не моё» не предлагаются.
     «Без сладкого» жёсткое: сладкие не подмешиваются, даже если пробников станет меньше. */
  function recommend(ratings, ctx, nosweet) {
    var st = statsOf(ratings);
    if (!st.meaningful) return { status: 'empty', items: [], cutSweet: 0 };
    if (!st.positive) return { status: 'no-positive', items: [], cutSweet: 0 };
    var P = profileOf(ratings);
    var top2 = rankedAccords(P).pos.slice(0, 2);
    var pool = [], cutSweet = 0;
    CATALOG.forEach(function (f) {
      var r = ratings[f.id];
      if (r && r.r !== 'unknown') return;
      var d = dot(P, f);
      if (d <= 0) return;
      if (nosweet && isSweet(f)) { cutSweet++; return; }
      var fit = f.ctx.indexOf(ctx) >= 0;
      pool.push({ f: f, fit: fit, lead: leadAccord(f), s: d / weightSum(f) + (fit ? 0.5 : 0) });
    });
    var used = {};
    function best(test) {
      var b = null;
      pool.forEach(function (x) {
        if (used[x.f.id] || (test && !test(x))) return;
        if (!b || x.s > b.s || (x.s === b.s && x.f.id < b.f.id)) b = x;
      });
      if (b) used[b.f.id] = true;
      return b;
    }
    var out = [];
    var s1 = best(function (x) { return top2.indexOf(x.lead) >= 0; }) || best();
    if (s1) out.push({ x: s1, role: 'Ближе всего к вашему вкусу', kind: 'near' });
    var s2 = best(function (x) { return x.fit; });
    if (s2) out.push({ x: s2, role: 'Для ' + CTX[ctx].gen, kind: 'ctx' });
    else { s2 = best(); if (s2) out.push({ x: s2, role: 'Ещё рядом по вкусу', kind: 'ctx-miss' }); }
    var s3 = best(function (x) { return top2.indexOf(x.lead) < 0; });
    if (s3) out.push({ x: s3, role: 'Шаг в сторону', kind: 'side' });
    else { s3 = best(); if (s3) out.push({ x: s3, role: 'Ещё рядом по вкусу', kind: 'near' }); }
    return {
      status: 'ok',
      cutSweet: cutSweet,
      items: out.map(function (o) {
        return { id: o.x.f.id, role: o.role, why: explain(o.x, o.kind, P, ratings, ctx), fit: o.x.fit };
      })
    };
  }

  function deckQueue(ratings, front) {
    var q = DECK_ORDER.filter(function (id) { return !ratings[id]; });
    if (front && q.indexOf(front) > 0) { q.splice(q.indexOf(front), 1); q.unshift(front); }
    return q;
  }

  function normalize(s) { return String(s).toLowerCase().replace(/ё/g, 'е').trim(); }
  function searchCatalog(query) {
    var q = normalize(query);
    if (!q) return CATALOG.slice();
    return CATALOG.filter(function (f) {
      return normalize(f.name + ' ' + f.brand + ' ' + f.notes.join(' ')).indexOf(q) >= 0;
    });
  }

  // Совпадают ли оценки с примером: тогда смена примера не требует резерва
  function sameRatings(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return b[k] && b[k].r === a[k].r; });
  }
  function ratingsFromExample(ex) {
    var r = {};
    Object.keys(ex.ratings).forEach(function (id) { r[id] = { r: ex.ratings[id], src: 'example' }; });
    return r;
  }

  /* ========== Хранилище: версия, безопасный разбор, ошибки доступа ========== */

  var KEY = 'nota.mobile.v1';
  var storage = { status: 'ok' }; // ok | blocked | corrupt

  function defaultState() {
    return { v: 1, ratings: {}, ctx: 'day', nosweet: false, saved: [], backup: null, example: null };
  }
  function cleanRatings(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).forEach(function (id) {
      var r = raw[id];
      if (BY_ID[id] && r && RATING[r.r]) out[id] = { r: r.r, src: SOURCES.indexOf(r.src) >= 0 ? r.src : 'search' };
    });
    return out;
  }
  function sanitize(raw) {
    var s = defaultState();
    s.ratings = cleanRatings(raw.ratings);
    if (CTX[raw.ctx]) s.ctx = raw.ctx;
    s.nosweet = raw.nosweet === true;
    if (Array.isArray(raw.saved)) {
      raw.saved.forEach(function (id) { if (BY_ID[id] && s.saved.indexOf(id) < 0 && s.saved.length < KIT_MAX) s.saved.push(id); });
    }
    if (raw.backup && typeof raw.backup === 'object') s.backup = { ratings: cleanRatings(raw.backup.ratings) };
    if (EX_BY_ID[raw.example]) s.example = raw.example;
    return s;
  }
  function loadState() {
    var raw;
    try { raw = window.localStorage.getItem(KEY); }
    catch (e) { storage.status = 'blocked'; return defaultState(); }
    if (raw == null) return defaultState();
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('версия');
      return sanitize(parsed);
    } catch (e) {
      storage.status = 'corrupt';
      return defaultState();
    }
  }
  function saveState(s) {
    try { window.localStorage.setItem(KEY, JSON.stringify(s)); if (storage.status === 'corrupt') storage.status = 'ok'; }
    catch (e) { storage.status = 'blocked'; }
  }
  function clearStorage() {
    try { window.localStorage.removeItem(KEY); } catch (e) { storage.status = 'blocked'; }
  }

  // Чистое ядро доступно для независимой проверки в консоли
  window.NOTA_CORE = {
    CATALOG: CATALOG, EXAMPLES: EXAMPLES, profileOf: profileOf, statsOf: statsOf, mapModel: mapModel,
    profileDelta: profileDelta, recommend: recommend, deckQueue: deckQueue, searchCatalog: searchCatalog, sanitize: sanitize
  };

  /* ========== Состояние и переходы ========== */

  var state = loadState();
  var undoStack = [];      // снимки до действия, в хранилище не пишутся
  var deckFront = null;    // карточка, возвращённая отменой, встаёт первой
  var deckEnter = 0;       // сторона, откуда возвращается карточка: -1 слева, 1 справа
  var lastDelta = '';
  var lastChanged = [];
  var lastPicks = null;
  var pickReason = '';

  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function snapshot() {
    return copy({ ratings: state.ratings, saved: state.saved, backup: state.backup, example: state.example });
  }
  function pushUndo(label, meta) {
    undoStack.push({ label: label, snap: snapshot(), meta: meta || {} });
    if (undoStack.length > 30) undoStack.shift();
  }

  // Общий хвост любого изменения оценок: дельта карты, сохранение, перерисовка
  function afterRatings(P0, reason) {
    var d = profileDelta(P0, profileOf(state.ratings));
    lastDelta = deltaText(d);
    lastChanged = d.up.concat(d.down);
    pickReason = reason || '';
    saveState(state);
    renderAll();
  }

  function setRating(id, r, src, opts) {
    opts = opts || {};
    var f = BY_ID[id];
    if (!f || !RATING[r]) return;
    var cur = state.ratings[id];
    // Та же оценка ничего не меняет; исключение: отклик после пробы помечает источник
    if (cur && cur.r === r && (cur.src === src || src !== 'trial')) return;
    var P0 = profileOf(state.ratings);
    pushUndo('«' + f.name + '»: ' + RATING[r].label, { id: id, src: src, dir: opts.dir || 0 });
    state.ratings[id] = { r: r, src: src };
    afterRatings(P0, '«' + f.name + '»: ' + RATING[r].label.toLowerCase() + '.');
  }

  function removeRating(id) {
    var f = BY_ID[id];
    if (!f || !state.ratings[id]) return;
    var P0 = profileOf(state.ratings);
    pushUndo('Убран «' + f.name + '»');
    delete state.ratings[id];
    afterRatings(P0, '«' + f.name + '» убран из коллекции.');
    showToast('«' + f.name + '» убран из коллекции.', true);
  }

  // Пример профиля: свои оценки уходят в резерв, а не пропадают
  function applyExample(exId) {
    var ex = EX_BY_ID[exId];
    if (!ex) return;
    var P0 = profileOf(state.ratings);
    var hasOwn = Object.keys(state.ratings).length > 0;
    var editedExample = state.example && !sameRatings(state.ratings, ratingsFromExample(EX_BY_ID[state.example]));
    pushUndo('Пример «' + ex.name + '»');
    if (hasOwn && !state.example && !state.backup) state.backup = { ratings: copy(state.ratings) };
    state.ratings = ratingsFromExample(ex);
    state.example = exId;
    afterRatings(P0, 'Пример «' + ex.name + '».');
    var tail = state.backup ? ' Прежние оценки можно вернуть.' : '';
    if (editedExample) tail = ' Правки прошлого примера вернёт «Отменить».';
    showToast('Загружен пример «' + ex.name + '».' + tail, true);
  }

  function restoreBackup() {
    if (!state.backup) return;
    var P0 = profileOf(state.ratings);
    pushUndo('Возврат своих оценок');
    state.ratings = state.backup.ratings;
    state.backup = null;
    state.example = null;
    afterRatings(P0, 'Возвращены ваши оценки.');
    showToast('Ваши оценки возвращены.', true);
  }

  function setCtx(c) {
    if (!CTX[c] || state.ctx === c) return;
    state.ctx = c;
    pickReason = 'Когда носить: ' + CTX[c].label.toLowerCase() + '.';
    saveState(state);
    renderAll();
  }
  function setSweet(on) {
    state.nosweet = !!on;
    pickReason = state.nosweet ? 'Сладкое исключено.' : 'Сладкое разрешено.';
    saveState(state);
    renderAll();
  }

  function toggleSaved(id) {
    var f = BY_ID[id];
    if (!f) return;
    var i = state.saved.indexOf(id);
    if (i >= 0) {
      pushUndo('Убран из набора «' + f.name + '»');
      state.saved.splice(i, 1);
      showToast('«' + f.name + '» убран из набора.', true);
    } else if (state.saved.length >= KIT_MAX) {
      showToast('В наборе уже ' + KIT_MAX + ' пробника. Уберите один, чтобы добавить этот.', false);
      return;
    } else {
      pushUndo('Добавлен в набор «' + f.name + '»');
      state.saved.push(id);
      showToast('«' + f.name + '» добавлен в набор.', true);
    }
    saveState(state);
    renderAll();
  }

  function undo() {
    var e = undoStack.pop();
    if (!e) return;
    var P0 = profileOf(state.ratings);
    state.ratings = e.snap.ratings;
    state.saved = e.snap.saved;
    state.backup = e.snap.backup;
    state.example = e.snap.example;
    if (e.meta.src === 'deck' && !state.ratings[e.meta.id]) { deckFront = e.meta.id; deckEnter = e.meta.dir || 0; }
    var a = document.activeElement;
    var fromToast = a && a.id === 'toast-undo';
    hideToast();
    afterRatings(P0, 'Отменено: ' + e.label + '.');
    announce('Отменено: ' + e.label);
    // Кнопка отмены могла скрыться: фокус не должен падать в body
    if (fromToast || (a && a.id === 'undo-btn' && !undoStack.length)) {
      var next = route.tab === 'taste' && !$('rate-grid').hidden ? $('rate-grid').querySelector('button') : $('h-' + route.tab);
      next.focus({ preventScroll: true });
    }
  }

  function resetAll() {
    clearStorage();
    state = defaultState();
    undoStack = [];
    deckFront = null;
    lastDelta = '';
    lastChanged = [];
    lastPicks = null;
    pickReason = '';
    saveState(state);
    renderAll();
  }

  /* ========== Рендер ========== */

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function tintOf(f) { return TINT[leadAccord(f)]; }
  function vialHtml(f) {
    return '<span class="vial" style="--tint:' + tintOf(f) + '" aria-hidden="true"><i class="cap"></i><i class="glass-tube"></i></span>';
  }

  // Строка аромата с оценкой: одна разметка для коллекции и поиска
  function itemRow(f, where) {
    var r = state.ratings[f.id];
    var meta = f.brand + ', демо-марка';
    if (r && r.src === 'trial') meta += ', оценено после пробы';
    if (r && r.src === 'example') meta += ', из примера';
    var seg = ['dislike', 'like', 'love'].map(function (k) {
      return '<button type="button" class="' + (k === 'dislike' ? 'neg' : '') + '" data-rate="' + k + '" data-id="' + f.id + '" data-where="' + where + '"' +
        ' data-fk="r-' + where + '-' + f.id + '-' + k + '" data-testid="rate-' + where + '-' + f.id + '-' + k + '"' +
        ' aria-pressed="' + (!!r && r.r === k) + '">' + RATING[k].label + '</button>';
    }).join('');
    return '<li class="item" data-testid="item-' + where + '-' + f.id + '"><div class="item-head">' +
      '<span class="dot" style="--tint:' + tintOf(f) + '" aria-hidden="true"></span>' +
      '<span class="item-name" id="n-' + where + '-' + f.id + '">' + esc(f.name) + '<span class="item-meta">' + esc(meta) + '</span></span>' +
      (r ? '<button type="button" class="text-btn" data-act="remove" data-id="' + f.id + '" data-fk="rm-' + where + '-' + f.id + '" aria-label="Убрать «' + esc(f.name) + '»">Убрать</button>' : '') +
      '</div><div class="seg" role="group" aria-labelledby="n-' + where + '-' + f.id + '">' + seg + '</div></li>';
  }

  function renderCollection() {
    var ids = Object.keys(state.ratings);
    var h = '';
    if (state.example || state.backup) {
      var ex = EX_BY_ID[state.example];
      var st = statsOf(state.ratings);
      h += '<div class="banner" data-testid="example-banner">';
      h += ex ? '<p><b>Пример «' + esc(ex.name) + '».</b> ' + esc(insightText(profileOf(state.ratings), st)) +
        ' Оценки «Люблю» весят вдвое больше «Нравится», «Не моё» ослабляет аккорды.</p>'
        : '<p><b>Ваши прежние оценки сохранены.</b></p>';
      h += '<div class="row"><a class="btn quiet" href="#/taste">Открыть карту вкуса</a>' +
        (state.backup ? '<button class="btn" type="button" data-act="restore" data-fk="restore" data-testid="restore-own">Вернуть мои оценки</button>' : '') +
        '</div></div>';
    }
    if (!ids.length) {
      h += '<div class="empty" data-testid="collection-empty"><h2>Здесь будут ароматы, которые вы знаете</h2>' +
        '<p>Добавьте знакомые из демо-каталога или загрузите пример профиля и посмотрите, как складывается вкус.</p>' +
        '<div class="row"><button class="btn" type="button" data-act="open-add" data-fk="add" data-testid="add-open">Добавить аромат</button>' +
        '<button class="btn quiet" type="button" data-act="open-examples" data-fk="examples" data-testid="examples-open">Пример профиля</button></div></div>';
      $('collection-body').innerHTML = h;
      return;
    }
    h += '<div class="actions"><button class="btn" type="button" data-act="open-add" data-fk="add" data-testid="add-open">Добавить аромат</button>' +
      '<button class="btn quiet" type="button" data-act="open-examples" data-fk="examples" data-testid="examples-open">Пример профиля</button></div>';
    h += '<p class="demo-mark">Демонстрационные ароматы</p>';
    var groups = [
      ['Нравится', ['love', 'like']],
      ['Не моё', ['dislike']],
      ['Не знаю', ['unknown']]
    ];
    groups.forEach(function (g) {
      var list = CATALOG.filter(function (f) { var r = state.ratings[f.id]; return r && g[1].indexOf(r.r) >= 0; });
      if (!list.length) return;
      list.sort(function (a, b) { return RATING[state.ratings[b.id].r].w - RATING[state.ratings[a.id].r].w; });
      h += '<h2 class="group-title">' + g[0] + ' <span class="muted">' + list.length + '</span></h2><ul class="list">' +
        list.map(function (f) { return itemRow(f, 'col'); }).join('') + '</ul>';
    });
    $('collection-body').innerHTML = h;
  }

  function renderResults() {
    var q = $('search').value;
    var list = searchCatalog(q);
    $('results').innerHTML = list.length
      ? list.map(function (f) { return itemRow(f, 'search'); }).join('')
      : '<li class="none" data-testid="search-empty">Среди ' + CATALOG.length + ' демонстрационных ароматов такого нет. Попробуйте «кедр», «чай» или «Дом Лён».</li>';
  }

  function renderExamples() {
    $('examples').innerHTML = EXAMPLES.map(function (ex) {
      var cur = state.example === ex.id;
      return '<button type="button" class="example" data-example="' + ex.id + '" data-fk="ex-' + ex.id + '" data-testid="example-' + ex.id + '"' +
        (cur ? ' aria-current="true"' : '') + '><b>' + esc(ex.name) + '</b><span>' + esc(ex.text) + '</span>' +
        (cur ? '<span>Загружен сейчас. Нажмите, чтобы вернуть его исходные оценки.</span>' : '') + '</button>';
    }).join('');
  }

  function renderSteps(st) {
    var steps = [
      ['Первый отклик', st.meaningful > 0],
      ['Подбор готов', recommend(state.ratings, state.ctx, state.nosweet).items.length > 0],
      ['Проба оценена', st.trial > 0]
    ];
    $('steps').innerHTML = steps.map(function (s) {
      return '<li class="' + (s[1] ? 'done' : '') + '">' + s[0] + '<span class="vh">' + (s[1] ? ', выполнено' : ', впереди') + '</span></li>';
    }).join('');
  }

  // Карта: полоски переиспользуются по ключу, поэтому ширина плавно меняется
  function renderMap(P, st) {
    var m = mapModel(P);
    var box = $('map');
    if (!box.firstChild) {
      box.innerHTML = '<h2>Карта вкуса</h2><p class="map-insight" id="insight"></p><ul class="bars" id="bars"></ul><p class="neg-line" id="neg-line"></p>';
    }
    $('insight').textContent = insightText(P, st);
    var ul = $('bars');
    var old = {};
    Array.prototype.forEach.call(ul.children, function (li) { old[li.getAttribute('data-k')] = li; });
    m.rows.forEach(function (row, i) {
      var li = old[row.k];
      var fresh = !li;
      if (fresh) {
        li = document.createElement('li');
        li.setAttribute('data-k', row.k);
        li.innerHTML = '<span class="bar-name"></span><span class="bar-track" aria-hidden="true"><span class="bar-fill"></span></span><span class="bar-tier"></span>';
        li.style.setProperty('--w', '0');
      }
      delete old[row.k];
      li.className = 'bar' + (i === 0 ? ' lead' : '') + (lastChanged.indexOf(row.k) >= 0 ? ' changed' : '');
      li.querySelector('.bar-name').textContent = row.label;
      li.querySelector('.bar-tier').textContent = row.tier;
      ul.appendChild(li);
      var fill = li.querySelector('.bar-fill');
      if (fresh) requestAnimationFrame(function () { requestAnimationFrame(function () { li.style.setProperty('--w', row.share.toFixed(3)); }); });
      else li.style.setProperty('--w', row.share.toFixed(3));
      fill.setAttribute('data-share', row.share.toFixed(2));
    });
    Object.keys(old).forEach(function (k) { ul.removeChild(old[k]); });
    var neg = $('neg-line');
    neg.hidden = !m.neg.length;
    neg.textContent = m.neg.length ? 'Не ваше: ' + joinRu(m.neg.slice(0, 4)) + '.' : '';
  }

  function renderTaste() {
    var st = statsOf(state.ratings);
    var n = st.meaningful;
    var t = n ? n + ' ' + plural(n, 'ответ', 'ответа', 'ответов') + ' ' + plural(n, 'влияет', 'влияют', 'влияют') + ' на вкус.'
      : 'Ответьте на пару карточек, и появится карта вкуса.';
    if (st.unknown) t += ' «Не знаю»: ' + st.unknown + ', это не минус.';
    $('taste-count').textContent = t;
    renderSteps(st);
    renderMap(profileOf(state.ratings), st);
    $('delta').textContent = lastDelta;
    var u = $('undo-btn');
    u.hidden = !undoStack.length;
    if (undoStack.length) u.setAttribute('aria-label', 'Отменить: ' + undoStack[undoStack.length - 1].label);
    renderDeck();
  }

  function renderDeck() {
    var deck = $('deck');
    var q = deckQueue(state.ratings, deckFront);
    var grid = $('rate-grid'), hint = $('deck-hint');
    var cur = deck.querySelector('.card:not(.ghost)');
    // Снимаем всё, кроме улетающих карточек
    Array.prototype.slice.call(deck.children).forEach(function (el) {
      if (!el.classList.contains('ghost') && (!cur || el !== cur || !q.length || cur.getAttribute('data-id') !== q[0])) deck.removeChild(el);
    });
    if (!q.length) {
      grid.hidden = true; hint.hidden = true;
      var done = document.createElement('div');
      done.className = 'deck-done';
      done.setAttribute('data-testid', 'deck-done');
      done.innerHTML = '<h3>Демо-ароматы закончились</h3><p>Все ' + CATALOG.length + ' оценены. Подбор собран из ваших ответов.</p>' +
        '<a class="btn" href="#/picks">Открыть подбор</a>';
      deck.appendChild(done);
      return;
    }
    grid.hidden = false; hint.hidden = false;
    var f = BY_ID[q[0]];
    Array.prototype.forEach.call(grid.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-label', RATING[b.getAttribute('data-deck')].label + ': ' + f.name);
    });
    if (cur && cur.parentNode && cur.getAttribute('data-id') === f.id) return;
    var card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-id', f.id);
    card.setAttribute('data-testid', 'deck-card');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Карточка: ' + f.name);
    card.innerHTML = '<span class="swipe-tag like" aria-hidden="true">Нравится</span><span class="swipe-tag dislike" aria-hidden="true">Не моё</span>' +
      vialHtml(f) + '<h3 class="card-name">' + esc(f.name) + '</h3><p class="card-brand">' + esc(f.brand) + ', демо-марка</p>' +
      '<p class="card-notes">' + esc(f.notes.join(', ')) + '</p><p class="card-brand">В колоде ещё ' + (q.length - 1) + '</p>';
    deck.insertBefore(card, deck.firstChild);
    var ctl = bindSwipe(card);
    if (deckEnter) { ctl.enter(deckEnter); }
    deckEnter = 0;
    // deckFront не сбрасываем: возвращённая карточка остаётся первой, пока её не оценят
  }

  // Контролы контекста и сладкого строятся один раз в двух местах и синхронизируются
  function renderControls() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-controls]'), function (box) {
      var where = box.getAttribute('data-controls');
      if (!box.firstChild) {
        box.innerHTML = '<div role="group" aria-labelledby="ctx-' + where + '"><p class="ctl-name" id="ctx-' + where + '">Когда носить</p>' +
          '<div class="seg ctx">' + Object.keys(CTX).map(function (k) {
            return '<button type="button" data-ctx="' + k + '" data-testid="ctx-' + where + '-' + k + '">' + CTX[k].label + '</button>';
          }).join('') + '</div></div>' +
          '<button type="button" class="switch" data-sweet data-testid="nosweet-' + where + '"><span class="knob" aria-hidden="true"></span>' +
          '<span class="switch-text"><b>Без сладкого</b><span></span></span></button>';
      }
      Array.prototype.forEach.call(box.querySelectorAll('[data-ctx]'), function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-ctx') === state.ctx));
      });
      var sw = box.querySelector('[data-sweet]');
      sw.setAttribute('aria-pressed', String(state.nosweet));
      sw.querySelector('.switch-text span').textContent = state.nosweet
        ? 'Включено: сладкие ароматы не попадут в подбор'
        : 'Выключено: сладкое допускается';
    });
  }

  function renderPicks() {
    var rec = recommend(state.ratings, state.ctx, state.nosweet);
    var body = $('picks-body');
    var ids = rec.items.map(function (it) { return it.id; });
    var h = '';
    if (rec.status === 'empty') {
      h = '<div class="empty" data-testid="picks-empty"><h2>Подбор строится от ваших оценок</h2>' +
        '<p>Отметьте хотя бы один аромат «Нравится» или «Люблю». Можно начать с примера профиля.</p>' +
        '<div class="row"><a class="btn" href="#/taste">Оценить знакомые</a>' +
        '<button class="btn quiet" type="button" data-act="open-examples">Пример профиля</button></div></div>';
    } else if (rec.status === 'no-positive') {
      h = '<div class="empty" data-testid="picks-negative"><h2>Пока только «Не моё»</h2>' +
        '<p>Этого хватает, чтобы исключать, но не чтобы предлагать. Отметьте аромат, который нравится.</p>' +
        '<div class="row"><a class="btn" href="#/taste">Оценить знакомые</a></div></div>';
    } else {
      h = '<p class="demo-mark">Демонстрационные ароматы</p><ul class="picks">' + rec.items.map(function (it) {
        var f = BY_ID[it.id];
        var saved = state.saved.indexOf(it.id) >= 0;
        var isNew = lastPicks && lastPicks.indexOf(it.id) < 0;
        return '<li class="pick' + (isNew ? ' is-new' : '') + '" data-testid="pick-' + it.id + '">' +
          '<p class="role">' + esc(it.role) + '</p><h2>' + esc(f.name) + '</h2><p class="item-meta">' + esc(f.brand) + ', демо-марка</p>' +
          vialHtml(f) + '<p class="why">' + esc(it.why) + '</p>' +
          '<div class="row"><a class="btn quiet" href="#/picks/' + it.id + '" data-testid="pick-open-' + it.id + '">Подробнее</a>' +
          '<button type="button" class="btn' + (saved ? ' saved' : '') + '" data-act="save" data-id="' + it.id + '" data-fk="sv-pick-' + it.id + '"' +
          ' aria-pressed="' + saved + '" data-testid="save-' + it.id + '">' + (saved ? 'В наборе' : 'В набор') + '</button></div></li>';
      }).join('') + '</ul>';
      if (rec.items.length < 3) {
        h += '<div class="shortfall" data-testid="picks-shortfall"><p>Показано ' + rec.items.length + ' из 3.' +
          (rec.cutSweet
            ? ' «Без сладкого» убрал ' + rec.cutSweet + ' ' + plural(rec.cutSweet, 'подходящий аромат', 'подходящих аромата', 'подходящих ароматов') + '. Сладкое не подмешиваем.</p>' +
              '<button class="btn quiet" type="button" data-act="sweet-off" data-fk="sweet-off">Разрешить сладкое</button>'
            : ' Остальные близкие демо-ароматы уже в вашей коллекции.</p>') + '</div>';
      }
    }
    body.innerHTML = h;
    // Строка изменений: что именно поменялось и из-за чего
    // Строка обновляется только от нового действия, от сохранения в набор не меняется
    if (pickReason && lastPicks) {
      var added = ids.filter(function (id) { return lastPicks.indexOf(id) < 0; });
      $('change').textContent = pickReason + ' ' + (added.length
        ? 'Новое в подборе: ' + joinRu(added.map(function (id) { return '«' + BY_ID[id].name + '»'; })) + '.'
        : rec.status === 'ok' ? 'Подбор не изменился.' : '');
    }
    pickReason = '';
    lastPicks = ids;
    renderKit();
  }

  function renderKit() {
    var box = $('kit-body');
    if (!state.saved.length) {
      box.innerHTML = '<p class="kit-empty">Пока пусто. Добавьте до ' + KIT_MAX + ' пробников кнопкой «В набор».</p>';
    } else {
      box.innerHTML = '<ul class="list">' + state.saved.map(function (id) { return kitRow(BY_ID[id], 'kit'); }).join('') + '</ul>';
    }
    var badge = $('kit-badge');
    badge.hidden = !state.saved.length;
    badge.textContent = state.saved.length;
    badge.setAttribute('aria-label', 'в наборе ' + state.saved.length);
  }

  // Пробник в наборе: отклик после пробы меняет вкус
  function kitRow(f, where) {
    var r = state.ratings[f.id];
    var tried = r && r.src === 'trial';
    var seg = ['like', 'dislike'].map(function (k) {
      return '<button type="button" class="' + (k === 'dislike' ? 'neg' : '') + '" data-trial="' + k + '" data-id="' + f.id + '"' +
        ' data-fk="tr-' + where + '-' + f.id + '-' + k + '" data-testid="trial-' + where + '-' + f.id + '-' + k + '"' +
        ' aria-pressed="' + (!!tried && r.r === k) + '">' + (k === 'like' ? 'Понравилось' : 'Не моё') + '</button>';
    }).join('');
    return '<li class="item" data-testid="kit-' + f.id + '"><div class="item-head">' +
      '<span class="dot" style="--tint:' + tintOf(f) + '" aria-hidden="true"></span>' +
      '<span class="item-name" id="k-' + where + '-' + f.id + '">' + esc(f.name) + '<span class="item-meta">' + esc(f.brand) + ', демо-марка</span></span>' +
      '<button type="button" class="text-btn" data-act="save" data-id="' + f.id + '" data-fk="sv-' + where + '-' + f.id + '" aria-label="Убрать из набора «' + esc(f.name) + '»">Убрать</button></div>' +
      '<p class="trial' + (tried ? ' done' : '') + '">' + (tried ? 'Проба: ' + RATING[r.r].label.toLowerCase() + '. Учтено во вкусе.' : 'Попробовали? Отметьте, и вкус обновится.') + '</p>' +
      '<div class="seg two" role="group" aria-labelledby="k-' + where + '-' + f.id + '">' + seg + '</div></li>';
  }

  function renderSample(id) {
    var f = BY_ID[id];
    if (!f) return;
    var rec = recommend(state.ratings, state.ctx, state.nosweet);
    var it = rec.items.filter(function (x) { return x.id === id; })[0];
    var r = state.ratings[id];
    var saved = state.saved.indexOf(id) >= 0;
    var full = !saved && state.saved.length >= KIT_MAX;
    $('sample-role').textContent = it ? it.role : saved ? 'Из вашего набора' : 'Демо-аромат';
    $('sample-title').textContent = f.name;
    var why = it ? it.why : 'Сейчас этот аромат не входит в подбор.' + (r && r.r !== 'unknown' ? ' Вы оценили его: ' + RATING[r.r].label.toLowerCase() + '.' : '');
    $('sample-body').innerHTML = vialHtml(f) +
      '<section><h3>Почему в подборе</h3><p>' + esc(why) + '</p></section>' +
      '<section><h3>Характер</h3><p>' + esc(f.mood.charAt(0).toUpperCase() + f.mood.slice(1)) + '.</p></section>' +
      '<section><h3>Ноты для иллюстрации</h3><ul>' + f.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></section>' +
      '<section><h3>Уместен</h3><p>' + f.ctx.map(function (k) { return CTX[k].label; }).join(', ') + '.</p></section>' +
      '<section><h3>Как пробовать</h3><ol><li>Нанесите на запястье и не растирайте.</li><li>Отметьте первое впечатление и то, что осталось через пару часов.</li><li>Наденьте в той ситуации, для которой пробник выбран.</li></ol></section>' +
      '<button type="button" class="btn' + (saved ? ' saved' : '') + '" data-act="save" data-id="' + id + '" data-fk="sv-sheet-' + id + '" aria-pressed="' + saved + '" data-testid="sheet-save"' + (full ? ' disabled aria-describedby="kit-full"' : '') + '>' +
      (saved ? 'В наборе, убрать' : 'В набор') + '</button>' +
      (full ? '<p class="muted" id="kit-full">В наборе уже ' + KIT_MAX + ' пробника. Уберите один в разделе «Ваш набор», чтобы добавить этот.</p>' : '') +
      (saved ? '<ul class="list">' + kitRow(f, 'sheet') + '</ul>' : '') +
      '<p class="muted">«' + esc(f.brand) + '» условная демо-марка. Цен и наличия в прототипе нет.</p>';
  }

  function renderStorageNote() {
    var t = storage.status === 'blocked'
      ? 'Сохранение на этом устройстве недоступно. Всё работает, но после закрытия вкладки ответы пропадут.'
      : storage.status === 'corrupt' ? 'Сохранённые данные не прочитались, начата чистая сессия.' : '';
    var n = $('storage-note');
    n.hidden = !t;
    n.textContent = t;
    $('more-storage').textContent = t || 'Ответы хранятся только в этом браузере.';
  }

  // Полная перерисовка с сохранением фокуса по ключу data-fk
  function renderAll() {
    var a = document.activeElement;
    var fk = a && a.getAttribute ? a.getAttribute('data-fk') : null;
    var scope = a && a.closest ? a.closest('dialog, .view') : null;
    renderCollection();
    renderTaste();
    renderControls();
    renderPicks();
    renderExamples();
    if ($('sheet-add').open) renderResults();
    if ($('sheet-sample').open && route.sample) renderSample(route.sample);
    renderStorageNote();
    if (fk && !document.body.contains(a)) {
      var next = (scope || document).querySelector('[data-fk="' + fk + '"]');
      if (!next && scope) next = scope.querySelector('.view-title, .close');
      if (next) next.focus();
    }
  }

  /* ========== Маршруты: вкладки и листы в hash, «Назад» браузера работает ========== */

  var TABS = ['collection', 'taste', 'picks'];
  var TITLES = { collection: 'Коллекция', taste: 'Вкус', picks: 'Подбор' };
  var ROUTED = ['sheet-add', 'sheet-examples', 'sheet-sample'];
  var route = { tab: 'collection', sheet: null, sample: null };
  var scrollPos = {};
  var sheetPushed = false; // лист открыт из приложения, закрытие делает шаг назад
  var lastTrigger = null;
  var reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  function parseRoute() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var r = { tab: TABS.indexOf(parts[0]) >= 0 ? parts[0] : 'collection', sheet: null, sample: null };
    if (r.tab === 'collection' && (parts[1] === 'add' || parts[1] === 'examples')) r.sheet = parts[1];
    if (r.tab === 'picks' && BY_ID[parts[1]]) { r.sheet = 'sample'; r.sample = parts[1]; }
    return r;
  }
  function routeHash(r) {
    return '#/' + r.tab + (r.sheet === 'sample' ? '/' + r.sample : r.sheet ? '/' + r.sheet : '');
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; }
  function anyOpen() {
    return Array.prototype.some.call(document.querySelectorAll('dialog'), function (d) { return d.open; });
  }

  function applyRoute(initial) {
    var prev = route;
    var next = parseRoute();
    var canonical = routeHash(next);
    // Неизвестный адрес исправляем без новой записи в истории
    if (location.hash !== canonical) history.replaceState(null, '', canonical);
    if (!initial) ['sheet-more', 'sheet-confirm'].forEach(function (id) { if ($(id).open) $(id).close(); });
    var tabChanged = initial || next.tab !== prev.tab;
    if (tabChanged) {
      if (!initial) scrollPos[prev.tab] = window.scrollY;
      TABS.forEach(function (t) { $('view-' + t).hidden = t !== next.tab; });
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (a) {
        if (a.getAttribute('data-tab') === next.tab) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      });
      document.title = 'НОТА: ' + TITLES[next.tab];
    }
    route = next;
    var want = next.sheet ? $('sheet-' + next.sheet) : null;
    ROUTED.forEach(function (id) { var d = $(id); if (d.open && d !== want) d.close(); });
    if (tabChanged) window.scrollTo(0, scrollPos[next.tab] || 0);
    if (want) {
      if (next.sheet === 'sample') renderSample(next.sample);
      if (next.sheet === 'add') renderResults();
      if (next.sheet === 'examples') renderExamples();
      if (!want.open) openDialog(want, lastTrigger);
      if (!initial && !prev.sheet) sheetPushed = true;
    } else {
      sheetPushed = false;
      if (!initial && tabChanged && !anyOpen()) $('h-' + next.tab).focus({ preventScroll: true });
    }
  }

  /* ========== Листы: нативный dialog, Escape, ловушка фокуса, возврат фокуса ========== */

  function openerKey(el) {
    if (!el || !el.getAttribute) return null;
    if (el.getAttribute('data-fk')) return '[data-fk="' + el.getAttribute('data-fk') + '"]';
    if (el.getAttribute('href')) return '[href="' + el.getAttribute('href') + '"]';
    if (el.id) return '#' + el.id;
    return null;
  }
  function openDialog(d, opener) {
    var o = opener && document.body.contains(opener) ? opener : document.activeElement;
    d._openerKey = openerKey(o);
    d._opener = o;
    if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); }
    else d.setAttribute('open', '');
    document.documentElement.classList.add('is-locked');
    d.scrollTop = 0;
    if (d.id === 'sheet-add') $('search').focus();
  }
  function requestClose(d) {
    if (!d) return;
    if (d.hasAttribute('data-route') && route.sheet && $('sheet-' + route.sheet) === d) {
      if (sheetPushed) history.back();
      else location.replace(routeHash({ tab: route.tab }));
    } else if (d.open) d.close();
  }
  function onDialogClose(d) {
    if (!anyOpen()) document.documentElement.classList.remove('is-locked');
    // Лист закрылся в обход адреса: синхронизируем адрес
    if (d.hasAttribute('data-route') && route.sheet && $('sheet-' + route.sheet) === d) requestClose(d);
    if (anyOpen()) return;
    var o = d._opener;
    if (!o || !document.body.contains(o) || !o.getClientRects().length) o = d._openerKey ? document.querySelector(d._openerKey) : null;
    if (o && o.getClientRects().length) o.focus({ preventScroll: true });
    else $('h-' + route.tab).focus({ preventScroll: true });
    d._opener = null;
  }
  function trapTab(d, e) {
    if (e.key !== 'Tab') return;
    var list = Array.prototype.slice.call(d.querySelectorAll('button:not([disabled]), a[href], input, [tabindex]:not([tabindex="-1"])'))
      .filter(function (el) { return el.getClientRects().length > 0; });
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  Array.prototype.forEach.call(document.querySelectorAll('dialog'), function (d) {
    d.addEventListener('cancel', function (e) { e.preventDefault(); requestClose(d); });
    d.addEventListener('close', function () { onDialogClose(d); });
    d.addEventListener('keydown', function (e) { trapTab(d, e); });
    // Нажатие по затемнению вне листа закрывает его
    d.addEventListener('click', function (e) {
      if (e.target !== d) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) requestClose(d);
    });
  });

  /* ========== Тост и объявления для экранного диктора ========== */

  var toastTimer = 0;
  function showToast(text, withUndo) {
    $('toast-text').textContent = text;
    $('toast-undo').hidden = !withUndo || !undoStack.length;
    $('toast').hidden = false;
    armToast(6000);
  }
  function armToast(ms) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { clearTimeout(toastTimer); $('toast').hidden = true; }
  // Пока палец или фокус на тосте, он не исчезает
  $('toast').addEventListener('pointerenter', function () { clearTimeout(toastTimer); });
  $('toast').addEventListener('pointerleave', function () { armToast(3000); });
  $('toast').addEventListener('focusin', function () { clearTimeout(toastTimer); });
  $('toast').addEventListener('focusout', function () { armToast(3000); });

  var live = document.createElement('div');
  live.className = 'vh';
  live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  function announce(t) { live.textContent = ''; setTimeout(function () { live.textContent = t; }, 30); }

  /* ========== Свайп колоды: 1:1, импульс, пружина, отмена, прерывание ========== */

  function project(v) { var d = 0.998; return (v / 1000) * d / (1 - d); }

  function bindSwipe(card) {
    var x = 0, v = 0, raf = 0, drag = null, gone = false;
    var tagLike = card.querySelector('.swipe-tag.like'), tagDis = card.querySelector('.swipe-tag.dislike');
    function width() { return card.offsetWidth || 320; }
    function apply() {
      card.style.transform = x ? 'translateX(' + x.toFixed(1) + 'px) rotate(' + (x * 0.03).toFixed(2) + 'deg)' : '';
      if (gone) card.style.opacity = String(Math.max(0, 1 - Math.abs(x) / (width() * 1.4)));
      tagLike.style.opacity = String(Math.min(1, Math.max(0, x / 90)));
      tagDis.style.opacity = String(Math.min(1, Math.max(0, -x / 90)));
    }
    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
    // Пружина: damping и response как у Apple, стартует от текущего положения и скорости
    function springTo(target, v0, damping, response, done) {
      stop();
      v = v0;
      var k = Math.pow(2 * Math.PI / response, 2), c = 4 * Math.PI * damping / response;
      var last = performance.now();
      function step(now) {
        var dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        v += (-k * (x - target) - c * v) * dt;
        x += v * dt;
        if (Math.abs(x - target) < 0.5 && Math.abs(v) < 20) {
          x = target; v = 0; apply(); raf = 0;
          if (done) done();
          return;
        }
        apply();
        raf = requestAnimationFrame(step);
      }
      raf = requestAnimationFrame(step);
    }
    function back(vel) {
      if (reduceMotion.matches) { stop(); x = 0; apply(); return; }
      springTo(0, vel, 0.8, 0.35);
    }
    function velocity(hist) {
      var now = hist[hist.length - 1];
      var from = hist[0];
      for (var i = hist.length - 1; i >= 0; i--) { if (now.t - hist[i].t > 100) break; from = hist[i]; }
      var dt = (now.t - from.t) / 1000;
      return dt > 0.008 ? (now.x - from.x) / dt : 0;
    }
    function remove() { if (card.parentNode) card.parentNode.removeChild(card); }

    card.addEventListener('pointerdown', function (e) {
      if (gone || (e.pointerType === 'mouse' && e.button !== 0)) return;
      stop(); // перехват на лету: продолжаем с текущего положения
      card.classList.add('touching');
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, base: x, lock: null, hist: [{ t: e.timeStamp, x: x }] };
    });
    card.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.lock) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          drag.lock = 'x';
          drag.sx = e.clientX; // без скачка после порога
          try { card.setPointerCapture(e.pointerId); } catch (err) { /* указатель уже отпущен */ }
          card.classList.add('dragging');
        } else if (Math.abs(dy) > 10) {
          drag = null; // вертикаль: отдаём жест прокрутке
          card.classList.remove('touching');
          if (x) back(0);
        }
        return;
      }
      x = drag.base + (e.clientX - drag.sx);
      drag.hist.push({ t: e.timeStamp, x: x });
      if (drag.hist.length > 12) drag.hist.shift();
      apply();
    });
    function release(e, cancelled) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      card.classList.remove('dragging', 'touching');
      if (d.lock !== 'x') { if (x) back(0); return; }
      // Пауза перед отпусканием гасит скорость последнего движения.
      d.hist.push({ t: e.timeStamp, x: x });
      var vel = velocity(d.hist);
      if (cancelled) { back(vel); return; }
      var W = width();
      var p = x + project(vel);
      var dir = p > W * 0.45 ? 1 : p < -W * 0.45 ? -1 : 0;
      // Решение по знаку скорости: бросок назад отменяет
      if (Math.abs(x) < 10 || (dir && Math.abs(vel) > 200 && (vel > 0 ? 1 : -1) !== (x > 0 ? 1 : -1))) dir = 0;
      if (!dir) { back(vel); return; }
      rateDeck(dir > 0 ? 'like' : 'dislike', vel);
    }
    card.addEventListener('pointerup', function (e) { release(e, false); });
    card.addEventListener('pointercancel', function (e) { release(e, true); });

    var ctl = {
      // Карточка улетает, а следующая уже на месте: ввод не блокируется
      fly: function (dir, vel) {
        gone = true;
        drag = null;
        card.classList.add('ghost');
        card.setAttribute('aria-hidden', 'true');
        card.removeAttribute('data-testid');
        if (!dir || reduceMotion.matches) {
          stop();
          requestAnimationFrame(function () { card.classList.add('fade'); });
          setTimeout(remove, 260);
          return;
        }
        springTo(dir * width() * 1.4, vel || dir * 1400, 1, 0.3, remove);
      },
      // Возврат отменой приходит с той стороны, куда ушёл
      enter: function (dir) {
        if (reduceMotion.matches || !dir) return;
        x = dir * width();
        apply();
        springTo(0, 0, 1, 0.35);
      }
    };
    card._ctl = ctl;
    return ctl;
  }

  function rateDeck(r, vel) {
    var card = $('deck').querySelector('.card:not(.ghost)');
    if (!card) return;
    var id = card.getAttribute('data-id');
    var dir = r === 'dislike' ? -1 : r === 'unknown' ? 0 : 1;
    card._ctl.fly(dir, vel);
    setRating(id, r, 'deck', { dir: dir });
  }

  /* ========== События ========== */

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('a, button') : null;
    if (!t) return;
    lastTrigger = t;
    var id = t.getAttribute('data-id');
    var act = t.getAttribute('data-act');
    if (act === 'open-add') return go('#/collection/add');
    if (act === 'open-examples') return go('#/collection/examples');
    if (act === 'restore') return restoreBackup();
    if (act === 'remove') return removeRating(id);
    if (act === 'save') return toggleSaved(id);
    if (act === 'sweet-off') return setSweet(false);
    if (t.hasAttribute('data-rate')) {
      var cur = state.ratings[id];
      if (cur && cur.r === t.getAttribute('data-rate')) return;
      return setRating(id, t.getAttribute('data-rate'), 'search');
    }
    if (t.hasAttribute('data-deck')) return rateDeck(t.getAttribute('data-deck'), 0);
    if (t.hasAttribute('data-ctx')) return setCtx(t.getAttribute('data-ctx'));
    if (t.hasAttribute('data-sweet')) return setSweet(!state.nosweet);
    if (t.hasAttribute('data-trial')) {
      var tr = state.ratings[id];
      if (tr && tr.src === 'trial' && tr.r === t.getAttribute('data-trial')) return;
      setRating(id, t.getAttribute('data-trial'), 'trial');
      if (!$('sheet-sample').open) showToast('Отклик учтён, карта вкуса обновилась.', true);
      return;
    }
    if (t.hasAttribute('data-example')) {
      applyExample(t.getAttribute('data-example'));
      return requestClose($('sheet-examples'));
    }
    if (t.hasAttribute('data-close')) return requestClose(t.closest('dialog'));
    if (t.id === 'more-btn') return openDialog($('sheet-more'), t);
    if (t.id === 'reset-open') {
      $('sheet-more').close();
      return openDialog($('sheet-confirm'), $('more-btn'));
    }
    if (t.id === 'reset-confirm') {
      resetAll();
      $('change').textContent = '';
      $('sheet-confirm').close();
      go('#/collection');
      return showToast('Всё сброшено.', false);
    }
    if (t.id === 'undo-btn' || t.id === 'toast-undo') return undo();
    // Повторное нажатие текущей вкладки поднимает экран наверх
    if (t.classList.contains('tab') && t.getAttribute('data-tab') === route.tab && !route.sheet) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
  });

  $('search').addEventListener('input', renderResults);
  // iOS включает :active только при наличии обработчика касаний
  document.addEventListener('touchstart', function () {}, { passive: true });
  window.addEventListener('hashchange', function () { applyRoute(false); });

  renderAll();
  applyRoute(true);
})();
