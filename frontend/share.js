/* НОТА: карточка для сторис «Мой вкус в 3 нотах», 1080x1920 PNG. Рисует браузер на canvas,
   процессор хостинга не тратится. Палитра Air, системный шрифт. Без цен и без призывов купить:
   это личный пост о вкусе, а не реклама (реклама в Instagram в России запрещена с 01.09.2025).
   Безопасные зоны Instagram: сверху 250 px и снизу 340 px закрыты интерфейсом, поэтому всё важное
   между y=250 и y=1580; полоса y=1400...1560 оставлена под стикер «Ссылка». */
(function () {
  'use strict';
  var W = 1080, H = 1920;
  var TONES = ['#eadfcc', '#e2e7d4', '#ead9d3', '#e3ddec', '#d8e5e2', '#eee7cc'];
  var FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

  // Тот же цвет метки, что в приложении (groups.js chip) и на публичной странице.
  function tone(key) {
    var h = 0; key = String(key || '');
    for (var i = 0; i < key.length; i++) h = ((h * 31) + key.charCodeAt(i)) >>> 0;
    return h % 6;
  }
  function font(weight, size) { return weight + ' ' + size + 'px ' + FONT; }
  // Уменьшает кегль до ширины, затем обрезает многоточием.
  function fit(ctx, text, weight, size, width, min) {
    text = String(text || '');
    for (; size > min; size -= 4) {
      ctx.font = font(weight, size);
      if (ctx.measureText(text).width <= width) return text;
    }
    ctx.font = font(weight, min);
    if (ctx.measureText(text).width <= width) return text;
    while (text.length && ctx.measureText(text + '…').width > width) text = text.slice(0, -1);
    return text.replace(/\s+$/, '') + '…';
  }
  // Перенос по словам, не больше lines строк.
  function wrap(ctx, text, width, lines) {
    var words = String(text || '').split(/\s+/), out = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var next = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(next).width <= width || !line) { line = next; continue; }
      out.push(line); line = words[i];
      if (out.length === lines) break;
    }
    if (out.length < lines && line) out.push(line);
    if (out.length === lines && words.join(' ').length > out.join(' ').length) {
      var last = out[lines - 1];
      while (last.length && ctx.measureText(last + '…').width > width) last = last.slice(0, -1);
      out[lines - 1] = last.replace(/[\s,]+$/, '') + '…';
    }
    return out;
  }
  function rounded(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function shortUrl(url) { return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, ''); }
  function joinNames(names) {
    if (names.length <= 2) return names.join(' и ');
    return names.slice(0, 2).join(', ') + ' и ещё ' + (names.length - 2);
  }

  /* opts: { tags: [{key,label}], items: [{name}], groupName, url } -> Promise<canvas> */
  function render(opts) {
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    return ready.then(function () {
      ctx.fillStyle = '#F1F2EF'; ctx.fillRect(0, 0, W, H);
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#1F2124';
      ctx.font = font(700, 48);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
      ctx.fillText('НОТА', 96, 318);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.fillText(fit(ctx, 'Так пахнет мой вкус', 700, 80, 888, 56), 96, 420);

      // Белая карточка Air с тремя метками-капсулами.
      ctx.fillStyle = '#FFFFFF'; rounded(ctx, 72, 476, 936, 664, 48); ctx.fill();
      var tags = (opts.tags || []).slice(0, 3);
      if (!tags.length) tags = (opts.items || []).slice(0, 3).map(function (x) { return { key: x.name, label: x.name }; });
      var top = 516, step = 204, h = 180;
      if (tags.length < 3) top += (3 - tags.length) * step / 2;
      var used = {};
      tags.forEach(function (t, i) {
        var y = top + i * step;
        // Цвет как у метки в приложении; если он уже занят соседней капсулой, берём следующий тон.
        var k = tone(t.key);
        for (var n = 0; n < 6 && used[k]; n++) k = (k + 1) % 6;
        used[k] = true;
        ctx.fillStyle = TONES[k]; rounded(ctx, 112, y, 856, h, 90); ctx.fill();
        ctx.fillStyle = '#34362E';
        var label = fit(ctx, t.label, 700, 88, 720, 52);
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 176, y + h / 2 + 4);
        ctx.textBaseline = 'alphabetic';
      });

      // Из каких ароматов сложился вкус: название группы и до двух ароматов.
      var names = (opts.items || []).map(function (x) { return x.name; }).filter(Boolean);
      ctx.fillStyle = '#1F2124';
      if (opts.groupName) ctx.fillText(fit(ctx, 'Группа «' + opts.groupName + '»', 650, 44, 888, 32), 96, 1222);
      ctx.fillStyle = '#5D5750'; ctx.font = font(500, 38);
      wrap(ctx, joinNames(names), 888, 2).forEach(function (line, i) { ctx.fillText(line, 96, 1282 + i * 50); });

      // Полоса под стикер «Ссылка»: мелкий адрес на случай, если стикер не добавят.
      ctx.textAlign = 'center';
      ctx.fillStyle = '#1F2124'; ctx.font = font(650, 44);
      ctx.fillText('Совпадём?', W / 2, 1478);
      ctx.fillStyle = '#5D5750';
      ctx.fillText(fit(ctx, opts.url ? shortUrl(opts.url) : 'nota.staytech.ru', 500, 34, 860, 24), W / 2, 1530);
      ctx.textAlign = 'left';
      return canvas;
    });
  }
  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Картинка не собралась')); }, 'image/png');
    });
  }
  window.NotaStory = { render: render, toBlob: toBlob, tone: tone, size: [W, H] };
})();
