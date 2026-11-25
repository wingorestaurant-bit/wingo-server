// ═══════════════════════════════════════════════════════════════
// 🎄 WING-O CHRISTMAS MODE: "Holiday Edition"
// ───────────────────────────────────────────────────────────────
// Self-contained seasonal layer, loaded with one <script> tag on the
// home page (home.html) and the ordering page (index.html). Nothing
// here touches ordering, cart or checkout: every effect sits on a
// pointer-events:none layer or is a plain link.
//
//  • Everywhere: falling snow, a string of twinkling lights under the
//    nav bar, a Santa hat on the logo, and a ❄ button that lets a
//    customer switch the effects off.
//  • Home page: "Holiday Edition" masthead, a holiday headline and
//    forecast, holiday ticker items, and a gift-card ad in the side column
//    (only while gift cards are on sale, per /api/giftcards/config).
//  • Ordering page: a holiday strip at the top (gift cards while they are on
//    sale, otherwise catering), with the lights and the ❄ switch in it.
//
// SEASON: on from SEASON_START to SEASON_END (Regina time), off by itself
// after that. Preview any time with ?xmas=1, force off with ?xmas=0.
// ═══════════════════════════════════════════════════════════════
(function(){
  'use strict';

  var SEASON_START = { month: 11, day: 24 };  // Nov 24 (months are 1-based)
  var SEASON_END   = { month: 12, day: 31 };  // Dec 31 (inclusive)
  var PREF_KEY = 'wingo_xmas_off';

  function reginaMD(){
    try {
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Regina', month: 'numeric', day: 'numeric' }).formatToParts(new Date());
      var m = 0, d = 0;
      p.forEach(function(x){ if (x.type === 'month') m = +x.value; if (x.type === 'day') d = +x.value; });
      if (m && d) return m * 100 + d;
    } catch(e){}
    var n = new Date(); return (n.getMonth() + 1) * 100 + n.getDate();
  }
  function inSeason(){
    var md = reginaMD();
    return md >= SEASON_START.month * 100 + SEASON_START.day && md <= SEASON_END.month * 100 + SEASON_END.day;
  }
  var force = null;
  try { force = new URLSearchParams(location.search).get('xmas'); } catch(e){}
  if (force === '0') return;
  if (force !== '1' && !inSeason()) return;

  function store(k, v){ try { if (v === undefined) return localStorage.getItem(k); v ? localStorage.setItem(k, '1') : localStorage.removeItem(k); } catch(e){ return null; } }
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var isMobile = window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : window.innerWidth < 768;
  var isHome = !!document.getElementById('mast');
  var BULBS = ['#e3170a', '#ffc23c', '#2f9e5b', '#3d8bfd', '#ff7a1a'];

  // ── Styles ──────────────────────────────────────────────────
  var css = [
    ':root{--xm-pine:#1d5b38;--xm-pine2:#123f26;--xm-gold:#ffc23c;}',
    // String lights hanging under the nav
    '.xm-lights{position:absolute;left:0;right:0;top:100%;height:26px;pointer-events:none;z-index:3;overflow:hidden;}',
    '.xm-lights svg{display:block;width:100%;height:26px;}',
    '.xm-lights .b{animation:xmtw 2.4s ease-in-out infinite;}',
    '@keyframes xmtw{0%,100%{opacity:1;}50%{opacity:.35;}}',
    // Santa hat on the logo
    '.xm-hatwrap{position:relative;display:inline-block;}',
    '.xm-hat{position:absolute;left:-9px;top:-15px;width:34px;height:auto;transform:rotate(-22deg);pointer-events:none;z-index:2;filter:drop-shadow(0 2px 2px rgba(0,0,0,.3));}',
    // Snow layer
    '#xm-snow{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:40;}',
    // On / off button
    '#xm-toggle{position:fixed;left:14px;bottom:14px;z-index:60;width:44px;height:44px;border-radius:50%;border:2px solid #1b1512;background:#fff;color:#1d5b38;font-size:22px;line-height:1;cursor:pointer;box-shadow:3px 3px 0 #1b1512;display:flex;align-items:center;justify-content:center;}',
    '#xm-toggle.off{opacity:.55;color:#888;}',
    '#xm-toggle:focus-visible{outline:3px solid #ffc23c;outline-offset:2px;}',
    '@media (max-width:768px){#xm-toggle{bottom:96px;width:40px;height:40px;font-size:20px;}}',
    'html.xm-off #xm-snow,html.xm-off .xm-lights,html.xm-off .xm-hat{display:none !important;}',
    // Ordering page gift-card strip
    '#xm-strip{display:flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(90deg,#123f26,#1d5b38 50%,#123f26);color:#fff;padding:8px 52px 30px 14px;position:relative;font:700 13px/1.3 Oswald,Arial,sans-serif;letter-spacing:1.5px;text-transform:uppercase;text-align:center;border-bottom:2px solid #ffc23c;}',
    '#xm-strip a{color:#ffc23c;text-decoration:none;}',
    '#xm-strip a:hover{text-decoration:underline;}',
    '#xm-strip .xm-lights{top:auto;bottom:0;}',
    '#xm-strip #xm-toggle{position:absolute;left:auto;right:8px;top:5px;bottom:auto;width:30px;height:30px;font-size:16px;box-shadow:2px 2px 0 #1b1512;}',
    '#xm-strip a{display:inline-block;}'
  ];
  if (isHome) css = css.concat([
    // Masthead + ticker
    '#ticker{background:linear-gradient(90deg,#b40f05,#e3170a 50%,#b40f05) !important;}',
    '#ticker:before{content:"";position:absolute;left:0;right:0;top:0;height:7px;z-index:2;pointer-events:none;background:radial-gradient(circle at 6px 0,#fff 6px,transparent 6.5px) 0 0/18px 7px repeat-x,linear-gradient(#fff,#fff) 0 0/100% 2px no-repeat;}',
    '.xm-ed{color:var(--xm-pine);font-weight:700;}',
    '#mast .mh1 .xm-holly{position:absolute;right:-.42em;top:-.18em;width:.62em;height:auto;transform:rotate(14deg);pointer-events:none;}',
    '.xm-ribbon{display:inline-block;margin-bottom:10px !important;background:var(--xm-pine);color:#fff;font:700 12px/1 Oswald,Arial,sans-serif;letter-spacing:3px;text-transform:uppercase;padding:6px 14px 5px;margin-top:4px;border-radius:2px;box-shadow:2px 2px 0 var(--ink,#1b1512);transform:rotate(-1.5deg);}',
    '#lead .kicker.xm-k{color:var(--xm-pine) !important;}',
    '.weather.xm-w{border-color:var(--xm-pine);background:linear-gradient(#fff0,rgba(29,91,56,.06));}',
    '.weather.xm-w .t{color:var(--xm-pine) !important;}',
    // The gift-card ad in the side column
    '.xm-ad{display:block;text-decoration:none;color:#fff;background:var(--xm-pine);border:2px solid var(--ink,#1b1512);box-shadow:4px 4px 0 var(--ink,#1b1512);padding:14px 12px 12px;text-align:center;position:relative;overflow:hidden;margin-top:4px;transition:transform .15s;}',
    '.xm-ad:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 var(--ink,#1b1512);}',
    '.xm-ad:before{content:"";position:absolute;inset:5px;border:1.5px dashed rgba(255,194,60,.75);pointer-events:none;}',
    '.xm-ad > *{position:relative;}',
    '.xm-ad .k{font:700 11px Oswald,Arial,sans-serif;letter-spacing:3px;color:var(--xm-gold);}',
    '.xm-ad .h{font-family:"Playfair Display",Georgia,serif;font-weight:900;font-size:24px;line-height:1.05;margin:6px 0;text-shadow:0 2px 0 rgba(0,0,0,.35);}',
    '.xm-ad .p{font:13px/1.4 "Special Elite",monospace;color:#f2e8d3;background:rgba(18,63,38,.85);padding:6px 6px 5px;}',
    '.xm-ad .go{display:inline-block;margin-top:9px;background:var(--xm-gold);color:#1b1512;font:400 19px "Bebas Neue",Impact,sans-serif;letter-spacing:2px;padding:6px 14px 3px;border-radius:3px;box-shadow:2px 2px 0 #1b1512;}'
  ]);
  var st = document.createElement('style'); st.id = 'xm-css'; st.textContent = css.join('\n');
  (document.head || document.documentElement).appendChild(st);

  // ── Little SVGs ─────────────────────────────────────────────
  var HAT = '<svg class="xm-hat" viewBox="0 0 60 52" aria-hidden="true"><path d="M8 40 C14 18 30 4 46 8 C52 10 55 16 54 22 C48 18 42 18 38 24 C34 30 34 36 34 40 Z" fill="#e3170a" stroke="#7a0c06" stroke-width="1.5"/><path d="M38 24 C42 18 48 18 54 22" fill="none" stroke="#b40f05" stroke-width="1.5"/><rect x="4" y="37" width="36" height="10" rx="5" fill="#fff" stroke="#d9d2c4" stroke-width="1"/><circle cx="54" cy="24" r="6" fill="#fff" stroke="#d9d2c4" stroke-width="1"/></svg>';
  var HOLLY = '<svg class="xm-holly" viewBox="0 0 64 48" aria-hidden="true"><path d="M30 26 C22 12 8 10 2 14 C8 16 8 22 4 26 C10 26 12 32 10 36 C18 32 26 32 30 26Z" fill="#1d5b38" stroke="#0e3220" stroke-width="1.4"/><path d="M34 26 C42 12 56 10 62 14 C56 16 56 22 60 26 C54 26 52 32 54 36 C46 32 38 32 34 26Z" fill="#257a49" stroke="#0e3220" stroke-width="1.4"/><circle cx="28" cy="28" r="5" fill="#e3170a" stroke="#7a0c06"/><circle cx="36" cy="29" r="5" fill="#e3170a" stroke="#7a0c06"/><circle cx="32" cy="22" r="5" fill="#ff3b24" stroke="#7a0c06"/></svg>';

  function lightsSVG(){
    var n = isMobile ? 14 : 30, w = 1000, h = 26, parts = [];
    var wire = 'M0 4';
    for (var i = 0; i < n; i++){ var x0 = i * w / n, x1 = (i + 1) * w / n; wire += ' Q' + ((x0 + x1) / 2) + ' 16 ' + x1 + ' 4'; }
    parts.push('<path d="' + wire + '" fill="none" stroke="#1b1512" stroke-width="1.6" vector-effect="non-scaling-stroke"/>');
    for (var j = 0; j < n; j++){
      var cx = (j + .5) * w / n, c = BULBS[j % BULBS.length], d = ((j * 7) % 10) / 10 * 2.4;
      parts.push('<g class="b" style="animation-delay:-' + d.toFixed(2) + 's"><rect x="' + (cx - 3) + '" y="9" width="6" height="4" fill="#3a332c"/>' +
        '<ellipse cx="' + cx + '" cy="18" rx="4.2" ry="6.2" fill="' + c + '"/><ellipse cx="' + (cx - 1.3) + '" cy="16" rx="1.3" ry="2.4" fill="#fff" opacity=".55"/></g>');
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' + parts.join('') + '</svg>';
  }

  // ── Effects that the ❄ button switches on and off ─────────────
  function addLights(){
    var nav = isHome ? document.getElementById('nav') : document.getElementById('xm-strip');
    if (!nav || nav.querySelector('.xm-lights')) return;
    if (getComputedStyle(nav).position === 'static') nav.style.position = 'relative';
    var d = document.createElement('div'); d.className = 'xm-lights'; d.innerHTML = lightsSVG();
    if (reduceMotion) d.querySelectorAll('.b').forEach(function(b){ b.style.animation = 'none'; });
    nav.appendChild(d);
  }
  function addHat(){
    var nav = document.getElementById('nav') || document.querySelector('nav');
    var logo = nav && nav.querySelector('img');
    if (!logo || logo.parentNode.querySelector('.xm-hat')) return;
    var a = logo.parentNode;
    if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
    a.insertAdjacentHTML('beforeend', HAT);
  }

  var snow = null;
  function startSnow(){
    if (snow || reduceMotion) return;
    var cv = document.createElement('canvas'); cv.id = 'xm-snow'; cv.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cv);
    var ctx = cv.getContext('2d'), dpr = Math.min(window.devicePixelRatio || 1, 2), W = 0, H = 0, flakes = [], raf = 0, last = 0;
    function size(){ W = window.innerWidth; H = window.innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    function flake(top){ return { x: Math.random() * W, y: top ? -10 : Math.random() * H, r: .8 + Math.random() * 2.4, v: .35 + Math.random() * .9, s: Math.random() * 6.28, a: .45 + Math.random() * .5 }; }
    size();
    var count = Math.round(Math.min(isMobile ? 45 : 90, W * H / 14000));
    for (var i = 0; i < count; i++) flakes.push(flake(false));
    function tick(t){
      raf = requestAnimationFrame(tick);
      var dt = Math.min(50, t - (last || t)); last = t;
      if (document.hidden) return;
      ctx.clearRect(0, 0, W, H);
      for (var k = 0; k < flakes.length; k++){
        var f = flakes[k];
        f.y += f.v * dt / 16; f.s += .012 * dt / 16; f.x += Math.sin(f.s) * .35;
        if (f.y > H + 6) { flakes[k] = flake(true); continue; }
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 6.283);
        ctx.fillStyle = 'rgba(255,255,255,' + f.a + ')'; ctx.fill();
        ctx.lineWidth = .9; ctx.strokeStyle = 'rgba(120,140,165,' + (f.a * .8) + ')'; ctx.stroke();
      }
    }
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', size);
    snow = function(){ cancelAnimationFrame(raf); window.removeEventListener('resize', size); cv.remove(); snow = null; };
  }

  function setOn(on){
    document.documentElement.classList.toggle('xm-off', !on);
    if (on) startSnow(); else if (snow) snow();
    var b = document.getElementById('xm-toggle');
    if (b){ b.classList.toggle('off', !on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = on ? 'Turn off snow & lights' : 'Turn on snow & lights'; b.setAttribute('aria-label', b.title); }
  }
  function addToggle(){
    if (document.getElementById('xm-toggle')) return;
    var b = document.createElement('button'); b.id = 'xm-toggle'; b.type = 'button'; b.textContent = '❄';
    b.addEventListener('click', function(){ var off = !document.documentElement.classList.contains('xm-off'); store(PREF_KEY, off); setOn(!off); });
    (isHome ? document.body : (document.getElementById('xm-strip') || document.body)).appendChild(b);
  }

  // ── Gift-card promo (read from the live gift card settings) ────
  function money(c){ return '$' + (c / 100).toFixed(c % 100 ? 2 : 0); }
  function promoLine(cb){
    fetch('/api/giftcards/config').then(function(r){ return r.ok ? r.json() : null; }).then(function(d){
      if (!d || !d.sales) return cb(null);  // gift cards not on sale: show no gift-card ad
      var p = d.promo;
      cb(p && p.every && p.bonus ? 'Buy ' + money(p.every) + ', get a ' + money(p.bonus) + ' bonus card.' : 'Good at every Wing-O. No fees, no expiry.');
    }).catch(function(){ cb(null); });
  }

  // ── Home page (Sauce Boss Times) ─────────────────────────────
  function homeExtras(){
    var ed = document.querySelector('.edline span');
    if (ed && !ed.querySelector('.xm-ed')) ed.insertAdjacentHTML('beforeend', ' · <span class="xm-ed">Holiday Edition</span>');
    var mh = document.querySelector('#mast .mh1');
    if (mh && !mh.querySelector('.xm-holly')) mh.insertAdjacentHTML('beforeend', HOLLY);
    var tl = document.querySelector('#mast .edline2');
    if (tl && !document.querySelector('.xm-ribbon')) tl.insertAdjacentHTML('beforebegin', '<div class="xm-ribbon">🎄 Happy Holidays from the Sauce Boss 🎄</div>');

    // Lead story. The page splits the headline into words for its stamp-in effect, so rebuild it the same way.
    var k = document.querySelector('#lead .kicker'); if (k){ k.textContent = 'Holiday Extra!'; k.classList.add('xm-k'); }
    var hl = document.getElementById('hl');
    if (hl){
      var words = ['Santa', 'Caught', 'Ordering', 'Wings', 'At', '2\u00a0AM'];
      hl.innerHTML = words.map(function(w, i){ return '<span class="w" style="animation-delay:' + (.15 + i * .12) + 's">' + w + '</span>'; }).join(' ');
    }
    var sub = document.querySelector('#lead .sub');
    if (sub) sub.textContent = 'Witnesses in Regina and Winnipeg say he asked for “extra honey garlic for the reindeer.”';

    var w = document.querySelector('.weather');
    if (w){ w.classList.add('xm-w');
      var t = document.getElementById('fc-t'), s = document.getElementById('fc-s');
      if (t) t.textContent = 'SAUCY & SNOWY'; if (s) s.textContent = '100% chance of a white (meat) Christmas'; }

    var tr = document.getElementById('tr');
    if (tr){
      var extra = ['🎄 <b>HAPPY HOLIDAYS</b> FROM WING-O', 'SANTA\'S PICK: <b>HONEY GARLIC</b>', '❄ PARTY PLATTERS · <b>CATERING</b> FOR YOUR HOLIDAY CREW'];
      tr.innerHTML = extra.map(function(x){ return '<span>' + x + '</span><span>✦</span>'; }).join('') + tr.innerHTML.slice(0, tr.innerHTML.length / 2) +
        extra.map(function(x){ return '<span>' + x + '</span><span>✦</span>'; }).join('') + tr.innerHTML.slice(tr.innerHTML.length / 2);
    }

    // Gift-card ad at the top of the right-hand column
    var cols = document.querySelectorAll('#front > .col.side');
    var right = cols[cols.length - 1];
    if (right) promoLine(function(line){
      if (!line || right.querySelector('.xm-ad')) return;
      right.insertAdjacentHTML('afterbegin',
        '<a class="xm-ad" href="/gift-cards?utm_source=site&utm_medium=xmas_home"><div class="k">★ ADVERTISEMENT ★</div>' +
        '<div class="h">The Gift That Bites Back</div><div class="p" id="xm-ad-p"></div>' +
        '<span class="go">🎁 Give wings →</span></a><hr>');
      document.getElementById('xm-ad-p').textContent = 'Wing-O gift cards. ' + line;
    });
  }

  // ── Ordering page ─────────────────────────────────────────────
  function orderExtras(){
    if (document.getElementById('xm-strip')) return;
    var nav = document.querySelector('nav'); if (!nav) return;
    var d = document.createElement('div'); d.id = 'xm-strip';
    d.innerHTML = '<span id="xm-strip-t">🎄 Happy Holidays from Wing-O · <a href="/catering.html">party platters for your holiday crew →</a></span>';
    nav.parentNode.insertBefore(d, nav);
    promoLine(function(line){
      var t = document.getElementById('xm-strip-t'); if (!t || !line) return;
      t.innerHTML = '🎄 Holiday gift cards are here: <a href="/gift-cards?utm_source=site&utm_medium=xmas_order"></a>';
      t.querySelector('a').textContent = (line.indexOf('Buy') === 0 ? line.replace(/\.$/, '') : 'give wings') + ' →';
    });
  }

  function init(){
    if (isHome) homeExtras(); else orderExtras();
    addLights(); addHat(); addToggle();
    setOn(store(PREF_KEY) !== '1');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
