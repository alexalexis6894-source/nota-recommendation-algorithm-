/* Компактный плеер: капсула раскрывается из значка ♫ и сворачивается обратно в него.
   Музыка начинается только после первого нажатия. */
(function () {
  'use strict';
  var button = document.getElementById('music-toggle');
  var audio = document.getElementById('nota-music');
  var panel = document.getElementById('music-panel');
  var play = document.getElementById('music-play');
  var notice = document.getElementById('music-status');
  var bar = document.getElementById('music-progress');
  var tracks = [
    { title: 'Ноты', artist: 'HammAli & Navai', src: './media/noty.mp3' },
    { title: 'Запах моей женщины', artist: 'Адлер Коцба & Timran', src: './media/zapakh.mp3' }
  ];
  var index = 0, started = false, request = 0, motion = null, open = false;
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Сдвиг и масштаб, при которых капсула совпадает со значком ♫.
  function toButton() {
    var p = panel.getBoundingClientRect(), b = button.getBoundingClientRect();
    var dx = (b.left + b.width / 2) - (p.left + p.width / 2);
    var dy = (b.top + b.height / 2) - (p.top + p.height / 2);
    return 'translate(' + dx + 'px,' + dy + 'px) scale(' + (b.width / p.width) + ',' + (b.height / p.height) + ')';
  }
  function animate(opening, done) {
    if (motion) { motion.cancel(); motion = null; }
    // В фоновой вкладке анимации стоят, поэтому там переключаем сразу.
    if (still || document.hidden || !panel.animate) { done && done(); return; }
    var folded = { transform: toButton(), borderRadius: '22px', opacity: 0.35 };
    var full = { transform: 'none', borderRadius: '30px', opacity: 1 };
    motion = panel.animate(opening ? [folded, full] : [full, folded], {
      duration: opening ? 280 : 240,
      easing: opening ? 'cubic-bezier(.2,.9,.25,1.15)' : 'cubic-bezier(.5,0,.75,.2)'
    });
    // Содержимое проявляется после того, как капсула почти раскрылась.
    Array.prototype.forEach.call(panel.children, function (child) {
      child.animate(opening ? [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], { duration: opening ? 280 : 240 });
    });
    motion.onfinish = function () { motion = null; done && done(); };
  }
  function show() {
    if (open) return;
    open = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    animate(true);
  }
  function close(returnFocus) {
    if (!open) return;
    open = false;
    button.setAttribute('aria-expanded', 'false');
    animate(false, function () {
      if (open) return;
      panel.hidden = true;
      // Значок отзывается коротким толчком, как будто принял капсулу.
      if (!still && button.animate) button.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
    });
    if (returnFocus) button.focus({ preventScroll: true });
  }
  function update() {
    var playing = !audio.paused && !audio.ended;
    button.dataset.playing = String(playing);
    button.setAttribute('aria-label', playing ? 'Музыка играет, открыть плеер' : 'Открыть музыкальный плеер');
    play.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
    play.dataset.playing = String(playing);
    document.getElementById('music-title').textContent = tracks[index].title;
    document.getElementById('music-artist').textContent = tracks[index].artist;
    var share = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    bar.style.transform = 'scaleX(' + share + ')';
  }
  function start() {
    var current = ++request;
    notice.textContent = '';
    audio.play().catch(function () {
      if (current !== request) return;
      notice.textContent = 'Не удалось включить трек';
      update();
    });
  }
  function select(i) {
    index = (i + tracks.length) % tracks.length;
    ++request;
    audio.src = tracks[index].src;
    update();
    start();
  }
  button.addEventListener('click', function () {
    if (open) { close(false); return; }
    show();
    if (!started) { started = true; select(index); }
    play.focus({ preventScroll: true });
  });
  play.addEventListener('click', function () {
    if (!audio.paused) { ++request; audio.pause(); }
    else start();
  });
  document.getElementById('music-prev').addEventListener('click', function () { select(index - 1); });
  document.getElementById('music-next').addEventListener('click', function () { select(index + 1); });
  function outside(e) { if (open && !panel.contains(e.target) && !button.contains(e.target)) close(false); }
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
  document.addEventListener('scroll', function (e) { if (!panel.contains(e.target)) close(false); }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) { e.preventDefault(); close(true); }
  });
  window.addEventListener('hashchange', function () { close(false); });
  window.addEventListener('pagehide', function () { ++request; audio.pause(); open = false; panel.hidden = true; });
  ['play', 'pause', 'timeupdate', 'loadedmetadata', 'emptied'].forEach(function (event) { audio.addEventListener(event, update); });
  audio.addEventListener('ended', function () { select(index + 1); });
  audio.addEventListener('error', function () {
    ++request; audio.pause(); notice.textContent = 'Трек не загрузился'; update();
  });
  update();
})();
