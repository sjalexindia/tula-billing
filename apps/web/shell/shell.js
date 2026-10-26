/*
 * Tula Android app: connect page, for a phone that opens Tula from the shop computer (the app's
 * other mode runs Tula on the phone itself, see src/local). It asks once for the shop computer's
 * address, checks GET <address>/api/health, remembers it, and then opens Tula from the shop
 * computer inside the app. The phone build copies it to connect/. No build step: plain script.
 */
(function () {
  'use strict';
  var KEY = 'tula.server';
  var OPENED = 'tula.opened';
  var DEFAULT_PORT = '5000';

  var TEXT = {
    en: {
      intro: 'Type the address of the shop computer. It is shown on that computer under Settings → Devices & sync → Open on a phone.',
      label: 'Shop computer address',
      hint: 'Example: http://192.168.1.20:5000 — or paste the link from the QR code.',
      connect: 'Connect',
      checking: 'Checking…',
      opening: 'Opening Tula from the shop computer…',
      change: 'Change address',
      unreachable: 'Cannot reach the shop computer',
      check1: 'Is the shop computer switched on, with Tula running?',
      check2: 'Is this phone on the shop Wi-Fi (not mobile data)?',
      check3: 'Has the computer\'s address changed? Check it on the Devices & sync screen.',
      retry: 'Try again',
      openTula: 'Open Tula',
      badAddress: 'This does not look like an address. Type it like http://192.168.1.20:5000',
      notTula: 'Something answered at this address, but it is not Tula. Check the address.',
      helpTitle: 'Where do I find the address?',
      help1: 'On the shop computer, open Tula and sign in as the owner.',
      help2: 'Go to Settings → Devices & sync.',
      help3: 'Under "Open on a phone", the address is written below the QR code.',
      ownPhone: 'Work on this phone instead (no shop computer needed)'
    },
    ta: {
      intro: 'கடைக் கணினியின் முகவரியை டைப் செய்யுங்கள். அந்தக் கணினியில் அமைப்புகள் → சாதனங்கள் & ஒத்திசைவு → போனில் திறக்க என்பதில் இது இருக்கும்.',
      label: 'கடைக் கணினி முகவரி',
      hint: 'உதாரணம்: http://192.168.1.20:5000 — அல்லது QR குறியீட்டு இணைப்பை ஒட்டுங்கள்.',
      connect: 'இணை',
      checking: 'சரிபார்க்கிறது…',
      opening: 'கடைக் கணினியிலிருந்து Tula திறக்கிறது…',
      change: 'முகவரி மாற்று',
      unreachable: 'கடைக் கணினியை அடைய முடியவில்லை',
      check1: 'கடைக் கணினி ஆன் ஆகி, Tula ஓடுகிறதா?',
      check2: 'இந்த போன் கடை Wi-Fi-இல் உள்ளதா (மொபைல் டேட்டா இல்லை)?',
      check3: 'கணினியின் முகவரி மாறிவிட்டதா? சாதனங்கள் & ஒத்திசைவு திரையில் பாருங்கள்.',
      retry: 'மீண்டும் முயல்',
      openTula: 'Tula திற',
      badAddress: 'இது முகவரி போல் இல்லை. http://192.168.1.20:5000 என்பது போல் டைப் செய்யுங்கள்.',
      notTula: 'இந்த முகவரியில் ஏதோ பதில் வருகிறது, ஆனால் அது Tula இல்லை. முகவரியைச் சரிபாருங்கள்.',
      helpTitle: 'முகவரி எங்கே கிடைக்கும்?',
      help1: 'கடைக் கணினியில் Tula திறந்து உரிமையாளராக உள்ளே செல்லுங்கள்.',
      help2: 'அமைப்புகள் → சாதனங்கள் & ஒத்திசைவு செல்லுங்கள்.',
      help3: '"போனில் திறக்க" பகுதியில் QR குறியீட்டின் கீழே முகவரி இருக்கும்.',
      ownPhone: 'பதிலாக இந்த போனிலேயே வேலை செய் (கடைக் கணினி தேவையில்லை)'
    }
  };

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  function get(kind, key) { var s = store(kind); try { return s ? s.getItem(key) : null; } catch (e) { return null; } }
  function set(kind, key, value) { var s = store(kind); try { if (s) s.setItem(key, value); } catch (e) { /* private mode */ } }

  var lang = get('localStorage', 'lang') || ((navigator.language || '').toLowerCase().indexOf('ta') === 0 ? 'ta' : 'en');
  var $ = function (id) { return document.getElementById(id); };
  var t = function (k) { return (TEXT[lang] && TEXT[lang][k]) || TEXT.en[k]; };

  function render() {
    document.documentElement.lang = lang;
    var nodes = document.querySelectorAll('[data-t]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-t'));
    var btns = document.querySelectorAll('[data-lang]');
    for (var j = 0; j < btns.length; j++) btns[j].setAttribute('aria-pressed', String(btns[j].getAttribute('data-lang') === lang));
  }

  /** "192.168.1.20", "192.168.1.20:5000", "http://192.168.1.20:5000/#/bills" → "http://192.168.1.20:5000" */
  function normalise(input) {
    var s = (input || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || /^[.-]|[.-]$/.test(u.hostname)) return null;
    if (/\s|%20/.test(s)) return null;
    var explicitPort = /^[a-z]+:\/\/[^/?#]*:\d+/i.test(s);
    var port = u.port || (u.protocol === 'http:' && !explicitPort ? DEFAULT_PORT : '');
    return u.protocol + '//' + u.hostname + (port ? ':' + port : '');
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  /**
   * Is Tula answering at this address? Resolves 'ok', 'not-tula' or 'unreachable'.
   * In the Android app the native HTTP plugin is used, so the browser's cross-origin
   * rules do not get in the way; in a desktop browser (for testing) plain fetch is tried.
   */
  function check(origin) {
    var url = origin + '/api/health';
    var cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;
    var attempt;
    if (cap) {
      attempt = cap.request({ url: url, method: 'GET', connectTimeout: 5000, readTimeout: 5000 }).then(function (r) {
        var data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
        return r.status === 200 && data && data.ok === true ? 'ok' : 'not-tula';
      });
    } else {
      attempt = fetch(url, { cache: 'no-store' }).then(function (r) {
        return r.json().then(function (d) { return r.ok && d && d.ok === true ? 'ok' : 'not-tula'; }, function () { return 'not-tula'; });
      }, function () {
        // Cross-origin without CORS headers: an opaque answer still proves the computer is there.
        return fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(function () { return 'ok'; });
      });
    }
    return withTimeout(attempt, 6000).catch(function () { return 'unreachable'; });
  }

  function show(id) {
    ['opening', 'form', 'failed', 'back'].forEach(function (s) { $(s).hidden = s !== id; });
  }

  function open(origin) {
    set('sessionStorage', OPENED, '1');
    location.href = origin + '/';
  }

  function tryOpen(origin) {
    show('opening');
    $('opening-addr').textContent = origin;
    check(origin).then(function (r) {
      if (r === 'ok') return open(origin);
      show('failed');
      $('failed-addr').textContent = origin;
    });
  }

  function showForm(prefill) {
    show('form');
    var input = $('addr');
    input.value = prefill || '';
    $('error').hidden = true;
    input.focus();
  }

  function onSubmit(e) {
    e.preventDefault();
    var origin = normalise($('addr').value);
    var err = $('error');
    if (!origin) { err.textContent = t('badAddress'); err.hidden = false; return; }
    var btn = $('connect-btn');
    btn.disabled = true;
    btn.textContent = t('checking');
    err.hidden = true;
    check(origin).then(function (r) {
      btn.disabled = false;
      btn.textContent = t('connect');
      if (r === 'ok') { set('localStorage', KEY, origin); return open(origin); }
      err.textContent = r === 'not-tula' ? t('notTula') : t('unreachable');
      err.hidden = false;
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    render();
    var langBtns = document.querySelectorAll('[data-lang]');
    for (var i = 0; i < langBtns.length; i++) {
      langBtns[i].addEventListener('click', function (ev) {
        lang = ev.currentTarget.getAttribute('data-lang');
        set('localStorage', 'lang', lang);
        render();
      });
    }
    $('connect').addEventListener('submit', onSubmit);
    var saved = get('localStorage', KEY);
    var change = function () { showForm(saved || ''); };
    $('change-1').addEventListener('click', change);
    $('change-2').addEventListener('click', change);
    $('change-3').addEventListener('click', change);
    $('retry').addEventListener('click', function () { tryOpen(saved); });
    $('reopen').addEventListener('click', function () { tryOpen(saved); });

    var hash = location.hash;
    if (hash === '#change' || !saved) return showForm(saved || '');
    // Came back with the Back button after opening Tula: wait for the person instead of re-opening at once.
    if (hash !== '#retry' && get('sessionStorage', OPENED)) {
      show('back');
      $('back-addr').textContent = saved;
      return;
    }
    tryOpen(saved);
  });

  window.tulaShell = { normalise: normalise };
})();
