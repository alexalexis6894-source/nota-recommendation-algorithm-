/* НОТА: публичная страница группы (/nota/g/<slug>/). Страница готовая, этот код только считает
   открытие и переход в приложение. Для гостя ни одного запроса к Python. */
(function () {
  'use strict';
  var data = {};
  try { data = JSON.parse(document.getElementById('nota-public').textContent || '{}'); } catch (e) { data = {}; }
  var slug = /^[A-Za-z0-9]{10}$/.test(data.slug || '') ? data.slug : '';
  if (!window.notaTrack || !slug) return;
  window.notaTrack('public_opened', { slug: slug, ref: document.referrer ? 'link' : 'direct' });
  document.querySelectorAll('[data-track="public_to_app"]').forEach(function (a) {
    a.addEventListener('click', function () {
      window.notaTrack('public_to_app', { slug: slug });
      // Пачка уходит маяком до перехода: страница сейчас закроется.
      window.notaTrack.flush();
    });
  });
})();
