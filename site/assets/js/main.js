/* Кактус — шапка, меню, появление секций, форма заказа, фильтр каталога */

(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  /* ---------- header ---------- */
  var hdr = $('#hdr');
  if (hdr && !hdr.classList.contains('hdr--solid')) {
    var onScroll = function () { hdr.classList.toggle('is-scrolled', window.scrollY > 40); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- mobile menu (нативный popover) ---------- */
  var menuBtn = $('#menuBtn');
  var menuPanel = $('#menuPanel');
  if (menuBtn && menuPanel) {
    var setMenu = function (open) {
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    };
    menuPanel.addEventListener('toggle', function (e) {
      setMenu(e.newState === 'open');
    });
    menuPanel.addEventListener('click', function (e) {
      if (e.target.closest('a')) menuPanel.hidePopover();
    });
  }

  /* ---------- hero scene: pinned-переход ---------- */
  /* Переход делает сам sticky-layout: коллекция поднимается поверх hero.
     JS нужен только для редкого случая, когда содержимое hero выше экрана;
     scroll-linked transforms убраны, чтобы не было рассинхрона замеров. */

  var heroStage = $('#heroStage');
  var heroScene = heroStage ? {
    stage: heroStage,
    hero: $('.hero', heroStage),
    height: 0
  } : null;

  if (heroScene && heroScene.hero && !reduceMotion) {
    var measureStage = function () {
      var h = heroScene.hero.offsetHeight;
      if (!h) return;
      var viewport = window.innerHeight || document.documentElement.clientHeight;
      if (h > viewport + 2) {
        if (h !== heroScene.height) {
          heroScene.height = h;
          document.documentElement.style.setProperty('--hero-real', h + 'px');
        }
      } else if (heroScene.height) {
        heroScene.height = 0;
        document.documentElement.style.removeProperty('--hero-real');
      }
    };

    window.addEventListener('resize', measureStage, { passive: true });
    window.addEventListener('pageshow', measureStage);

    if ('ResizeObserver' in window) {
      new ResizeObserver(measureStage).observe(heroScene.hero);
    }

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measureStage);
    }

    measureStage();
  }

  /* ---------- footer: наезд на последнюю секцию ---------- */
  /* Подвал последний, поэтому у него нет запаса прокрутки, чтобы прилипнуть
     над секцией: main заканчивается ровно на нём. Резервируем высоту подвала
     в main (.home main::after) и поднимаем его самого на ту же высоту —
     визит остаётся на месте, подвал въезжает поверх. Высота зависит от
     шрифта и ширины, поэтому мерим её и обновляем при resize. */
  var foot = $('.foot');
  if (foot && document.body.classList.contains('home')) {
    var measureFoot = function () {
      var h = foot.offsetHeight;
      if (!h) return;
      document.documentElement.style.setProperty('--foot-h', h + 'px');
    };
    window.addEventListener('resize', measureFoot, { passive: true });
    window.addEventListener('pageshow', measureFoot);
    if ('ResizeObserver' in window) {
      new ResizeObserver(measureFoot).observe(foot);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measureFoot);
    }
    measureFoot();
  }

  /* ---------- cursor trail reveal ---------- */
  /* Движок переехал в assets/js/trail.js: буфер следа на WebGL2.
     Контракт с разметкой (data-trail-*) остался прежним. */

  /* ---------- reveal ---------- */
  var revealEls = $$('.reveal');
  if (revealEls.length) {
    var revealObserver = null;
    var revealFrame = 0;
    var showReveal = function (el) {
      el.classList.add('in');
      if (revealObserver) revealObserver.unobserve(el);
    };
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach(showReveal);
    } else {
      revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) showReveal(entry.target);
        });
      }, { threshold: 0.01, rootMargin: '0px 0px 12% 0px' });
      revealEls.forEach(function (el) { revealObserver.observe(el); });
      var revealVisible = function () {
        if (revealFrame) return;
        revealFrame = requestAnimationFrame(function () {
          revealFrame = 0;
          var vh = window.innerHeight || document.documentElement.clientHeight;
          revealEls.forEach(function (el) {
            if (el.classList.contains('in')) return;
            var rect = el.getBoundingClientRect();
            if (rect.bottom > 0 && rect.top < vh) showReveal(el);
          });
        });
      };
      window.addEventListener('scroll', revealVisible, { passive: true });
      window.addEventListener('resize', revealVisible, { passive: true });
      revealVisible();
    }
  }

  /* ---------- order form ---------- */
  var form = $('#orderForm');
  if (form) {
    var status = $('#formStatus');
    var nameInput = $('#f-name');
    var phoneInput = $('#f-phone');
    var bouquetSelect = $('#f-bouquet');
    var submitBtn = form.querySelector('button[type="submit"]');
    var formEndpoint = form.getAttribute('data-endpoint') || form.getAttribute('action');

    var bouquets = {
      'nochnoy-sad': 'Ночной сад',
      'pudrovaya-korobka': 'Пудровая коробка',
      'belyy-pion': 'Белый пион',
      'bordo': 'Бордо',
      'rumyanets': 'Румянец',
      'yantarnyy': 'Янтарный',
      'klassika': 'Классика',
      'goluboe-utro': 'Голубое утро',
      'vecherniy-svet': 'Вечерний свет',
      'temnyy-sad': 'Тёмный сад',
      'suhotsvety': 'Сухоцветы',
      'osennyaya-korzina': 'Осенняя корзина'
    };

    try {
      var slug = new URLSearchParams(window.location.search).get('bouquet');
      if (slug && bouquets[slug] && bouquetSelect) {
        bouquetSelect.value = bouquets[slug];
      }
    } catch (err) { /* old browser: ignore */ }

    var setError = function (input, message) {
      var field = input.closest('.field');
      if (!field) return;
      field.classList.toggle('invalid', Boolean(message));
      var err = field.querySelector('.field__err');
      if (err) err.textContent = message || '';
      input.setAttribute('aria-invalid', message ? 'true' : 'false');
    };

    var digits = function (value) { return (value.match(/\d/g) || []).length; };

    var validate = function () {
      var ok = true;
      if (nameInput.value.trim().length < 2) {
        setError(nameInput, 'Напишите, как к вам обращаться');
        ok = false;
      } else {
        setError(nameInput, '');
      }
      if (digits(phoneInput.value) < 10) {
        setError(phoneInput, 'Нужен телефон из 10–11 цифр');
        ok = false;
      } else {
        setError(phoneInput, '');
      }
      return ok;
    };

    [nameInput, phoneInput].forEach(function (input) {
      input.addEventListener('input', function () {
        var field = input.closest('.field');
        if (field && field.classList.contains('invalid')) setError(input, '');
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      status.className = 'form__status';
      status.textContent = '';

      if (!validate()) {
        status.classList.add('bad');
        status.textContent = 'Проверьте имя и телефон — без них не сможем ответить.';
        var firstInvalid = form.querySelector('.field.invalid input');
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      var data = {
        _subject: 'Заявка с сайта «Кактус»',
        _template: 'table',
        _captcha: 'false',
        bouquet: bouquetSelect ? bouquetSelect.value : 'Подберём под бюджет',
        name: nameInput.value.trim(),
        phone: phoneInput.value.trim(),
        date: $('#f-date') ? $('#f-date').value.trim() : '',
        address: $('#f-address') ? $('#f-address').value.trim() : '',
        comment: $('#f-comment') ? $('#f-comment').value.trim() : ''
      };

      var fail = function (message) {
        status.classList.remove('ok');
        status.classList.add('bad');
        status.innerHTML = message || 'Не удалось отправить заявку. Позвоните <a href="tel:+79227754852">+7 922 775-48-52</a> — примем заказ по телефону.';
      };

      if (!formEndpoint || typeof window.fetch !== 'function') {
        fail();
        return;
      }

      if (submitBtn) submitBtn.disabled = true;
      status.classList.remove('ok', 'bad');
      status.textContent = 'Отправляем заявку…';

      window.fetch(formEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(data)
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (res) {
        if (!res || (res.success !== true && res.success !== 'true')) {
          throw new Error(res && res.message ? res.message : 'rejected');
        }
        form.reset();
        status.classList.remove('bad');
        status.classList.add('ok');
        status.textContent = 'Заявка отправлена. Свяжемся с вами ежедневно с 08:00 до 21:00.';
      }).catch(function () {
        fail();
      }).then(function () {
        if (submitBtn) submitBtn.disabled = false;
      });
    });
  }

  /* ---------- catalog filter ---------- */
  var grid = $('#catGrid');
  if (grid) {
    var buttons = $$('.filter');
    var cards = $$('.cat-card', grid);
    var countEl = $('#catCount');
    var emptyEl = $('#catEmpty');

    var plural = function (n) {
      var last = n % 100;
      var d = n % 10;
      if (last >= 11 && last <= 14) return 'букетов';
      if (d === 1) return 'букет';
      if (d >= 2 && d <= 4) return 'букета';
      return 'букетов';
    };

    var apply = function (filter) {
      var shown = 0;
      cards.forEach(function (card) {
        var match = filter === 'all' || card.dataset.cat === filter;
        card.hidden = !match;
        if (match) shown++;
      });
      if (countEl) countEl.textContent = shown + ' ' + plural(shown);
      if (emptyEl) emptyEl.hidden = shown !== 0;
    };

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        apply(btn.dataset.filter || 'all');
      });
    });

    apply('all');
  }
})();
