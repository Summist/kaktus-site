/**
 * scroll.js — прогресс секций, параллакс и переход по ссылкам на секции.
 *
 * Каждая секция получает две переменные:
 *   --enter  0..1  вход в кадр: 0 — верх секции на нижней кромке, 1 — прижат к верху
 *   --q     -1..1  непрерывный прогресс через экран (0 — центр секции в центре экрана)
 *
 * --enter крутит скругление и тень листа (наезд одной секции на другую),
 * --q двигает контент с разной скоростью: слои внутри секции едут
 * по-разному, отсюда параллакс. Всё в CSS, скрипт только пишет числа.
 */
(function () {
  'use strict';

  var nodes = [].slice.call(document.querySelectorAll('[data-section]'));
  if (!nodes.length) return;

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var raf = 0;
  var vh = window.innerHeight;
  var last = 0;

  function measure() {
    vh = window.innerHeight || 1;
    markTall();
  }

  /* Секция выше экрана не может прилипать верхом: низ никогда не покажется.
     Меряем натуральную высоту .wrap, а не самого листа — иначе класс
     .is-tall снимал бы сам себя. Высокий лист прилипает низом, и CSS для
     этого нужна его высота: пишем её в --sec-h. Читаем всё, потом пишем —
     иначе каждая секция заставляет браузер пересчитывать раскладку.

     У hero .wrap растянут на высоту листа (flex:1), поэтому его offsetHeight
     ничего не говорит о содержимом: натуральную высоту даёт scrollHeight
     самой секции. Это спасает альбомную ориентацию телефона, где текст
     выше экрана и кнопка с мета-строкой иначе срезались бы навсегда. */
  function markTall() {
    var i, el, inner, tall = [];
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (el.classList.contains('hero')) {
        /* нижний отступ tall-режима входит в scrollHeight — вычитаем его,
           иначе лист не смог бы снять с себя класс */
        var padBottom = el.classList.contains('is-tall') ? parseFloat(getComputedStyle(el).paddingBottom) || 0 : 0;
        tall.push(el.scrollHeight - padBottom > vh + 2);
        continue;
      }
      inner = el.classList.contains('sec') ? el.querySelector('.wrap') : null;
      tall.push(Boolean(inner) && inner.offsetHeight > vh - 96);
    }
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (el.classList.contains('sec') || el.classList.contains('hero')) el.classList.toggle('is-tall', tall[i]);
    }
    for (i = 0; i < nodes.length; i++) {
      el = nodes[i];
      if (tall[i]) el.style.setProperty('--sec-h', el.offsetHeight + 'px');
      else el.style.removeProperty('--sec-h');
    }
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 8) return;   /* 120 Гц не нужны, хватает 60 */
    last = now;
    if (reduced.matches) return;

    var list = [];
    for (var i = 0; i < nodes.length; i++) {
      list.push(nodes[i].getBoundingClientRect());
    }
    for (var j = 0; j < nodes.length; j++) {
      var r = list[j];
      var enter = 1 - r.top / vh;
      enter = enter < 0 ? 0 : enter > 1 ? 1 : enter;

      var half = (vh + r.height) * 0.5 || 1;
      var q = (r.top + r.height * 0.5 - vh * 0.5) / half;
      q = q < -1 ? -1 : q > 1 ? 1 : q;

      var el = nodes[j];
      el.style.setProperty('--enter', enter.toFixed(4));
      el.style.setProperty('--q', q.toFixed(4));
      /* прогресс второй секции = насколько накрыт герой */
      if (j === 1) document.documentElement.style.setProperty('--cover', enter.toFixed(4));
    }
  }

  /* ---------- переход по ссылкам на секции ---------- */
  /* Листы стоят липким стеком, и у залипшего листа getBoundingClientRect()
     всегда отдаёт 0: браузеру нечего взять — он целится в видимое (нулевое)
     положение. Отсюда промахи: переход останавливается на высоту шапки выше
     листа, а если лист уже «в кадре», страница вообще не двигается.
     Поэтому место листа в потоке читаем сами: на один синхронный проход
     снимаем sticky со всех листов (paint между чтениями не случается) и
     запоминаем их tops. Цель перехода — верх листа на кромке экрана: лист
     накрывает предыдущий целиком, а контент начинается под шапкой, потому
     что padding-top секции уже включает --nav-h. Для высокого листа это
     начало его текста, а не низ, до которого он доезжает потом. */
  function flowTop(el) {
    var i, saved = [], top = -1;
    for (i = 0; i < nodes.length; i++) {
      saved[i] = nodes[i].style.getPropertyValue('position');
      nodes[i].style.setProperty('position', 'static', 'important');
    }
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] === el) top = nodes[i].getBoundingClientRect().top + window.pageYOffset;
    }
    for (i = 0; i < nodes.length; i++) {
      if (saved[i]) nodes[i].style.setProperty('position', saved[i]);
      else nodes[i].style.removeProperty('position');
    }
    return top;
  }

  /* В живых макетах один и тот же лист может стоять в документе несколько
     раз с тем же id — id берём у видимого экземпляра. */
  function sectionEl(id) {
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id && nodes[i].getBoundingClientRect().height) return nodes[i];
    }
    return null;
  }

  /* Возвращает false, если якорь ведёт не на лист стека: такой переход
     оставляем браузеру (#main, сноски и т. п.). */
  function jumpTo(id) {
    var el = sectionEl(id);
    if (!el) return false;
    var top = flowTop(el);
    if (top < 0) return false;
    var max = Math.max(0, document.documentElement.scrollHeight - (window.innerHeight || 0));
    top = Math.round(top);
    window.scrollTo(0, top > max ? max : top);
    return true;
  }

  function hashId(hash) {
    if (!hash || hash.length < 2) return '';
    try { return decodeURIComponent(hash.slice(1)); } catch (err) { return hash.slice(1); }
  }

  var pendingId = hashId(window.location.hash);

  /* Высоты листов меняют шрифты, портреты и класс .is-tall: после каждого
     такого события поправляем позицию. Как только человек начал листать
     сам — перестаём, иначе переход будет выдёргивать страницу из-под него. */
  function settle() {
    if (!pendingId) return;
    if (!jumpTo(pendingId)) { pendingId = ''; return; }
    requestAnimationFrame(function () { if (pendingId) jumpTo(pendingId); });
  }

  function release() { pendingId = ''; }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    var id = hashId(a.getAttribute('href'));
    if (!id || !jumpTo(id)) return;
    e.preventDefault();
    release();
    if (window.history && history.pushState && window.location.hash !== '#' + id) {
      history.pushState(null, '', '#' + id);
    }
  }, false);

  window.addEventListener('wheel', release, { passive: true });
  window.addEventListener('touchstart', release, { passive: true });
  window.addEventListener('keydown', release);
  document.addEventListener('DOMContentLoaded', settle);

  window.addEventListener('resize', measure);
  window.addEventListener('orientationchange', measure);
  window.addEventListener('load', function () { measure(); settle(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { measure(); settle(); });
  if (reduced.addEventListener) reduced.addEventListener('change', measure);

  /* Ошибки формы, подгрузка фото и шрифты меняют высоту листа — от неё зависит
     точка прилипания, поэтому пересчитываем на любое изменение размера. */
  if (window.ResizeObserver) {
    var roFrame = 0;
    var ro = new ResizeObserver(function () {
      if (roFrame) return;
      roFrame = requestAnimationFrame(function () { roFrame = 0; measure(); });
    });
    for (var n = 0; n < nodes.length; n++) ro.observe(nodes[n]);
  }

  measure();
  settle();
  raf = requestAnimationFrame(frame);

  window.addEventListener('pagehide', function () { cancelAnimationFrame(raf); });
})();
