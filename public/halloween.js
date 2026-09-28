// ═══════════════════════════════════════════════════════════════
// 🎃 WING-O HALLOWEEN MODE — "Spooky Szn"
// ───────────────────────────────────────────────────────────────
// Self-contained seasonal layer. Loaded from index.html with one
// <script> tag. Nothing here touches ordering, cart or checkout —
// every effect sits on a pointer-events:none layer.
//
//  • 3D haunted graveyard in the hero (Three.js): moon, glowing
//    jack-o'-lanterns, floating ghosts, a shambling zombie, zombie
//    hands clawing out of graves, bats, rolling fog, lightning.
//  • Site-wide: ghost fly-bys, a bat swarm, a dangling spider,
//    a zombie that shuffles along the bottom of the screen,
//    a little ghost that follows your cursor, spooky banner.
//  • 👻 GHOST HUNT: 5 clickable ghosts hide around the page. Catch
//    them all → FREE small fries on a $30+ order (checked by the
//    server in index.js, once per phone number per season).
//  • A 🎃 button (bottom-left) lets customers switch it off.
//
// SEASON: turns itself on between SEASON_START and SEASON_END.
// Preview any time with ?halloween=1, force off with ?halloween=0.
// To remove completely: delete the halloween.js <script> tag.
// ═══════════════════════════════════════════════════════════════
(function(){
  'use strict';

  var SEASON_START = { month: 9, day: 25 };  // Sep 25 (months are 1-based here)
  var SEASON_END   = { month: 11, day: 2 };  // Nov 2 (inclusive)
  var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
  var PREF_KEY = 'wingo_spooky_off';

  // ── Season / preference gate ────────────────────────────────
  function inSeason(){
    var now = new Date();
    var md = (now.getMonth() + 1) * 100 + now.getDate();
    return md >= SEASON_START.month * 100 + SEASON_START.day &&
           md <= SEASON_END.month * 100 + SEASON_END.day;
  }
  var force = null;
  try { force = new URLSearchParams(location.search).get('halloween'); } catch(e){}
  if (force === '0') return;
  if (force !== '1' && !inSeason()) return;

  function prefOff(){ try { return localStorage.getItem(PREF_KEY) === '1'; } catch(e){ return false; } }
  function setPrefOff(v){ try { v ? localStorage.setItem(PREF_KEY, '1') : localStorage.removeItem(PREF_KEY); } catch(e){} }

  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var isMobile = window.matchMedia ? window.matchMedia('(max-width: 768px)').matches : window.innerWidth < 768;
  var finePointer = !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);

  // Things to undo when the customer switches spooky mode off.
  var cleanups = [];
  function onCleanup(fn){ cleanups.push(fn); }
  function every(fn, minMs, maxMs, firstMs){
    var t, alive = true;
    function schedule(ms){ t = setTimeout(function(){ if(!alive) return; if(!document.hidden) fn(); schedule(minMs + Math.random() * (maxMs - minMs)); }, ms); }
    schedule(firstMs != null ? firstMs : minMs + Math.random() * (maxMs - minMs));
    onCleanup(function(){ alive = false; clearTimeout(t); });
  }

  // ── Fonts + styles ──────────────────────────────────────────
  var CSS = [
    '.hw-font{font-family:"Creepster","Bebas Neue",cursive;}',
    // Top banner
    '#hw-banner{position:relative;overflow:hidden;background:linear-gradient(90deg,#12061f,#2b0b3d 30%,#3d1602 50%,#2b0b3d 70%,#12061f);background-size:200% 100%;animation:hw-shimmer 8s linear infinite;color:#FFB347;text-align:center;padding:.55rem 2.5rem;font-size:1.05rem;letter-spacing:2px;border-bottom:2px solid #FF7518;text-shadow:0 0 10px rgba(255,117,24,.7);}',
    '@media (max-width:600px){#hw-banner .hw-long{display:none;}#hw-banner{padding:.5rem 1rem;}}',
    '#hw-banner b{color:#B8F28B;font-weight:400;text-shadow:0 0 10px rgba(124,252,0,.6);}',
    '#hw-banner .hw-drip{position:absolute;top:100%;width:6px;border-radius:0 0 6px 6px;background:#FF7518;animation:hw-drip 3.5s ease-in infinite;}',
    '@keyframes hw-shimmer{0%{background-position:0% 0}100%{background-position:200% 0}}',
    '@keyframes hw-drip{0%{height:0;opacity:1}70%{height:14px;opacity:1}100%{height:18px;opacity:0}}',
    // Hero re-skin
    '.hw-on .hero{background:radial-gradient(ellipse at 50% 120%,#3a1405 0%,rgba(58,20,5,0) 55%),radial-gradient(ellipse at 80% 0%,#2a0f45 0%,rgba(42,15,69,0) 60%),linear-gradient(180deg,#07030d 0%,#140822 55%,#1a0a05 100%);}',
    '.hw-on .hero .float-emoji,.hw-on .hero .glow-orb{display:none!important;}',
    '.hw-on .hero .hero-3d-bg{z-index:0;}',
    '#hw-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
    '#hw-flash{position:absolute;inset:0;background:radial-gradient(ellipse at 70% 10%,rgba(210,220,255,.55),rgba(160,170,255,.12) 60%,transparent);opacity:0;pointer-events:none;z-index:0;}',
    '#hw-flash.go{animation:hw-flash 1.1s ease-out;}',
    '@keyframes hw-flash{0%{opacity:0}4%{opacity:1}10%{opacity:.1}16%{opacity:.85}40%{opacity:0}100%{opacity:0}}',
    '#hw-hero-title{font-size:clamp(1.7rem,5vw,3.1rem);letter-spacing:3px;line-height:1.05;color:#FF7518;margin:-.4rem 0 1.4rem;text-shadow:0 0 18px rgba(255,117,24,.55),0 3px 0 #5a1d00;animation:hw-flicker 5s infinite;}',
    '#hw-hero-title span{color:#B8F28B;text-shadow:0 0 16px rgba(124,252,0,.55),0 3px 0 #1d3b00;}',
    '@keyframes hw-flicker{0%,100%{opacity:1}46%{opacity:1}47%{opacity:.55}48%{opacity:1}49%{opacity:.7}50%{opacity:1}}',
    '.hw-on .hero .btn-red{box-shadow:0 0 22px rgba(255,117,24,.55);}',
    '.hw-web{position:absolute;top:0;width:clamp(90px,14vw,190px);height:auto;opacity:.55;pointer-events:none;z-index:1;}',
    '.hw-web.l{left:0;}.hw-web.r{right:0;transform:scaleX(-1);}',
    // Site-wide overlay layer — below nav (999), bottom bar (998) and every modal
    '#hw-layer{position:fixed;inset:0;pointer-events:none;z-index:997;overflow:hidden;}',
    '#hw-layer *{pointer-events:none;}',
    // Ghost fly-by
    '.hw-ghost{position:absolute;left:0;width:90px;will-change:transform;filter:drop-shadow(0 0 14px rgba(200,220,255,.55));}',
    '.hw-ghost .bob{animation:hw-bob 1.6s ease-in-out infinite alternate;}',
    '.hw-ghost .tail{animation:hw-tail .5s ease-in-out infinite alternate;transform-origin:50% 0;}',
    '@keyframes hw-bob{from{transform:translateY(-10px) rotate(-6deg)}to{transform:translateY(10px) rotate(6deg)}}',
    '@keyframes hw-tail{from{transform:skewX(-8deg)}to{transform:skewX(8deg)}}',
    // Bats
    '.hw-bat{position:absolute;left:0;width:46px;will-change:transform;}',
    '.hw-bat .wl,.hw-bat .wr{animation:hw-flap .18s ease-in-out infinite alternate;}',
    '.hw-bat .wl{transform-origin:50% 50%;}.hw-bat .wr{transform-origin:50% 50%;}',
    '@keyframes hw-flap{from{transform:scaleY(1)}to{transform:scaleY(-.35)}}',
    // Spider
    '.hw-spider{position:absolute;top:0;width:40px;margin-left:-20px;transform:translateY(-120%);transition:transform 2.6s cubic-bezier(.3,1.5,.5,1);}',
    '.hw-spider.down{transform:translateY(var(--drop,260px));}',
    '.hw-spider.up{transition:transform 1.8s ease-in;transform:translateY(-120%);}',
    '.hw-spider .thread{position:absolute;bottom:80%;left:50%;width:1px;height:2000px;background:linear-gradient(transparent,rgba(220,220,220,.7));}',
    '.hw-spider svg{animation:hw-dangle 2.2s ease-in-out infinite alternate;transform-origin:50% -300px;}',
    '.hw-spider .legs{animation:hw-wiggle .4s ease-in-out infinite alternate;transform-origin:50% 45%;}',
    '@keyframes hw-dangle{from{transform:rotate(-2.5deg)}to{transform:rotate(2.5deg)}}',
    '@keyframes hw-wiggle{from{transform:scaleX(.92)}to{transform:scaleX(1.06)}}',
    // Zombie walker
    '.hw-zombie{position:absolute;left:0;bottom:-4px;width:92px;will-change:transform;}',
    '@media (max-width:768px){.hw-zombie{bottom:calc(76px + env(safe-area-inset-bottom));width:70px;}}',
    '.hw-zombie .walk{animation:hw-shamble 1.1s ease-in-out infinite;transform-origin:50% 100%;}',
    '.hw-zombie .legL{animation:hw-legL 1.1s ease-in-out infinite;transform-origin:44px 118px;}',
    '.hw-zombie .legR{animation:hw-legR 1.1s ease-in-out infinite;transform-origin:56px 118px;}',
    '.hw-zombie .arms{animation:hw-arms 1.1s ease-in-out infinite;transform-origin:50px 80px;}',
    '.hw-zombie .head{animation:hw-head 2.2s ease-in-out infinite;transform-origin:50px 62px;}',
    '.hw-zombie.flip{transform-origin:center;}',
    '.hw-zombie.flip svg{transform:scaleX(-1);}',
    '@keyframes hw-shamble{0%,100%{transform:rotate(-3deg) translateY(0)}50%{transform:rotate(3deg) translateY(-3px)}}',
    '@keyframes hw-legL{0%,100%{transform:rotate(18deg)}50%{transform:rotate(-14deg)}}',
    '@keyframes hw-legR{0%,100%{transform:rotate(-14deg)}50%{transform:rotate(18deg)}}',
    '@keyframes hw-arms{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(5deg)}}',
    '@keyframes hw-head{0%,100%{transform:rotate(14deg)}50%{transform:rotate(24deg)}}',
    '.hw-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-30%);white-space:nowrap;background:#0d0d0d;color:#B8F28B;border:1.5px solid #6fae3a;border-radius:10px;padding:.25rem .6rem;font-size:.95rem;letter-spacing:1px;opacity:0;transition:opacity .4s;}',
    '.hw-bubble.show{opacity:1;}',
    // Cursor ghost
    '#hw-cursor-ghost{position:fixed;left:0;top:0;width:34px;opacity:.75;z-index:997;pointer-events:none;will-change:transform;filter:drop-shadow(0 0 8px rgba(200,220,255,.8));transition:opacity .3s;}',
    // Toggle
    '#hw-toggle{position:fixed;left:1rem;bottom:4.9rem;z-index:998;width:46px;height:46px;border-radius:50%;border:2px solid #FF7518;background:#12061f;color:#fff;font-size:1.4rem;line-height:1;cursor:pointer;box-shadow:0 0 16px rgba(255,117,24,.5);display:flex;align-items:center;justify-content:center;transition:transform .2s;}',
    '#hw-toggle:hover{transform:scale(1.1) rotate(-8deg);}',
    '#hw-toggle.off{border-color:#555;box-shadow:none;filter:grayscale(1);opacity:.7;}',
    '@media (max-width:768px){#hw-toggle{width:40px;height:40px;font-size:1.15rem;}body.cart-open #hw-toggle,body.checkout-open #hw-toggle,body.modal-open #hw-toggle{display:none;}}',
    '@media (max-width:600px){#hw-toggle{left:.6rem;bottom:8.4rem;}}',  // stacks above the Gauntlet button
    '@media (prefers-reduced-motion:reduce){#hw-banner,#hw-hero-title,.hw-ghost .bob,.hw-ghost .tail{animation:none!important;}}'
  ].join('\n');

  var styleEl = null, fontEl = null;
  function injectStyles(){
    if (!fontEl) {
      fontEl = document.createElement('link');
      fontEl.rel = 'stylesheet';
      fontEl.href = 'https://fonts.googleapis.com/css2?family=Creepster&display=swap';
      document.head.appendChild(fontEl);
    }
    styleEl = document.createElement('style');
    styleEl.id = 'hw-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    onCleanup(function(){ styleEl && styleEl.remove(); styleEl = null; });
  }

  // ── SVG art ─────────────────────────────────────────────────
  var SVG_GHOST = '<svg viewBox="0 0 100 120" xmlns="http://www.w3.org/2000/svg"><g class="bob"><defs><radialGradient id="hwgG" cx="45%" cy="30%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#cfd8ff" stop-opacity=".85"/></radialGradient></defs>' +
    '<path class="tail" fill="url(#hwgG)" d="M50 4C24 4 12 24 12 50v58l10-9 9 11 9-11 10 11 10-11 9 11 9-11 10 9V50C88 24 76 4 50 4z"/>' +
    '<ellipse cx="37" cy="44" rx="6" ry="9" fill="#111"/><ellipse cx="63" cy="44" rx="6" ry="9" fill="#111"/>' +
    '<circle cx="39" cy="41" r="2" fill="#fff"/><circle cx="65" cy="41" r="2" fill="#fff"/>' +
    '<ellipse cx="50" cy="66" rx="8" ry="10" fill="#111"/>' +
    '<path d="M12 60c-8 2-12 10-10 16M88 60c8 2 12 10 10 16" stroke="#e8edff" stroke-width="7" stroke-linecap="round" fill="none"/></g></svg>';

  var SVG_BAT = '<svg viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg" fill="#0b0610">' +
    '<path class="wl" d="M50 22C40 6 22 4 2 12c8 2 12 8 12 14 6-4 12-2 14 4 4-6 12-6 16 0z"/>' +
    '<path class="wr" d="M50 22c10-16 28-18 48-10-8 2-12 8-12 14-6-4-12-2-14 4-4-6-12-6-16 0z"/>' +
    '<ellipse cx="50" cy="26" rx="7" ry="11"/><path d="M44 17l2-8 4 6 4-6 2 8z"/>' +
    '<circle cx="47" cy="22" r="1.6" fill="#ff3b1f"/><circle cx="53" cy="22" r="1.6" fill="#ff3b1f"/></svg>';

  var SVG_SPIDER = '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg"><g class="legs" stroke="#0d0d0d" stroke-width="3" fill="none" stroke-linecap="round">' +
    '<path d="M24 28L10 16 4 24M24 32L6 30 2 40M26 36L12 44 10 56M28 38L22 50 22 58"/>' +
    '<path d="M36 28l14-12 6 8M36 32l18-2 4 10M34 36l14 8 2 12M32 38l6 12v8"/></g>' +
    '<ellipse cx="30" cy="36" rx="10" ry="12" fill="#0d0d0d"/><circle cx="30" cy="22" r="7" fill="#0d0d0d"/>' +
    '<path d="M26 33h8l-4 7z" fill="#E8190A"/>' +
    '<circle cx="27" cy="21" r="2" fill="#FF7518"/><circle cx="33" cy="21" r="2" fill="#FF7518"/></svg>';

  var SVG_ZOMBIE = '<svg viewBox="0 0 100 170" xmlns="http://www.w3.org/2000/svg"><g class="walk">' +
    '<g class="legL"><path d="M40 116l-6 44h12l4-44z" fill="#3a3f5c"/><path d="M33 158h16v8H30z" fill="#2a1a10"/></g>' +
    '<g class="legR"><path d="M52 116l2 44h12l-4-44z" fill="#454b6e"/><path d="M53 158h16l2 8H53z" fill="#2a1a10"/></g>' +
    '<path d="M34 72h32l4 48H30z" fill="#6b4f2e"/><path d="M34 72h32l-3 16-6-6-5 10-6-8-6 8z" fill="#7d5d37"/>' +
    '<path d="M36 104l6 8 5-6 6 8 5-7 6 7v6H32z" fill="#6b4f2e"/><path d="M48 84l3 20" stroke="#4a3520" stroke-width="2"/>' +
    '<g class="arms"><path d="M60 78l34-2v10l-34 4z" fill="#6b4f2e"/><path d="M40 80l44 6v10l-44-6z" fill="#7d5d37"/>' +
    '<path d="M92 74h6l2 4-2 2 2 4-8 2z" fill="#8fbf6a"/><path d="M82 86h6l2 4-2 2 2 4-8 2z" fill="#7dab5a"/></g>' +
    '<g class="head"><rect x="36" y="38" width="28" height="30" rx="9" fill="#8fbf6a"/>' +
    '<path d="M36 46c0-10 6-12 14-12s14 2 14 10l-6-4-4 5-4-6-4 6-5-4z" fill="#2b2b2b"/>' +
    '<circle cx="45" cy="52" r="4.5" fill="#fff9c4"/><circle cx="57" cy="52" r="3.5" fill="#fff9c4"/>' +
    '<circle cx="46" cy="53" r="1.6" fill="#b30000"/><circle cx="57" cy="52.5" r="1.3" fill="#b30000"/>' +
    '<path d="M42 62q8 4 16-1" stroke="#2b3b1e" stroke-width="2.5" fill="none"/><path d="M47 62v3M52 62.5v3" stroke="#eee" stroke-width="1.5"/>' +
    '<path d="M60 42l4 6" stroke="#b30000" stroke-width="1.5"/><path d="M38 58l4 2" stroke="#5d8a3f" stroke-width="2"/></g>' +
    '</g></svg>';

  var SVG_WEB = '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="rgba(230,230,240,.8)" stroke-width="1.2">' +
    '<path d="M0 0L200 0M0 0L190 70M0 0L140 140M0 0L70 190M0 0L0 200"/>' +
    '<path d="M40 0Q34 12 38 14Q30 24 28 28Q20 30 14 38Q12 34 0 40"/>' +
    '<path d="M85 0Q72 22 76 30Q62 50 57 57Q42 62 30 76Q22 72 0 85"/>' +
    '<path d="M130 0Q112 34 118 46Q96 76 88 88Q66 96 46 118Q34 112 0 130"/>' +
    '<path d="M178 0Q152 46 160 62Q130 102 118 118Q90 128 62 160Q46 152 0 178"/></svg>';

  function el(tag, cls, html){
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }
  function rand(a, b){ return a + Math.random() * (b - a); }

  // ── Banner, hero title, cobwebs ─────────────────────────────
  function decorate(){
    var nav = document.querySelector('nav');
    var banner = el('div', 'hw-font');
    banner.id = 'hw-banner';
    banner.innerHTML = '🎃 Happy Hallowing<span class="hw-long"> from Wing-O</span> · <b>Spooky Szn</b><span class="hw-long"> is here · 135+ flavours to die for</span> 👻';
    for (var i = 0; i < 7; i++) {
      var d = el('span', 'hw-drip');
      d.style.left = (8 + i * 14 + rand(-4, 4)) + '%';
      d.style.animationDelay = rand(0, 3.5).toFixed(2) + 's';
      banner.appendChild(d);
    }
    if (nav && nav.parentNode) nav.parentNode.insertBefore(banner, nav);
    else document.body.insertBefore(banner, document.body.firstChild);
    onCleanup(function(){ banner.remove(); });

    var hero = document.querySelector('.hero');
    if (!hero) return;
    var btns = hero.querySelector('.hero-btns');
    if (btns) {
      var title = el('div', 'hw-font');
      title.id = 'hw-hero-title';
      title.innerHTML = 'Trick or Treat? <span>Wings.</span>';
      btns.parentNode.insertBefore(title, btns);
      onCleanup(function(){ title.remove(); });
    }
    var wl = el('div', 'hw-web l', SVG_WEB), wr = el('div', 'hw-web r', SVG_WEB);
    hero.appendChild(wl); hero.appendChild(wr);
    onCleanup(function(){ wl.remove(); wr.remove(); });
  }

  // ── Site-wide overlay critters ──────────────────────────────
  function critters(){
    var layer = el('div');
    layer.id = 'hw-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    onCleanup(function(){ layer.remove(); });
    if (reduceMotion) return;

    var W = function(){ return window.innerWidth; }, H = function(){ return window.innerHeight; };

    // Animate an element along a path using rAF; removes itself when done.
    function fly(node, dur, pathFn){
      layer.appendChild(node);
      var t0 = performance.now();
      function step(now){
        if (!node.isConnected) return;
        var p = (now - t0) / dur;
        if (p >= 1) { node.remove(); return; }
        node.style.transform = pathFn(p);
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }

    function ghostFlyBy(){
      var g = el('div', 'hw-ghost', SVG_GHOST);
      var ltr = Math.random() < .5, y0 = rand(.12, .6) * H(), amp = rand(30, 90), size = rand(.6, 1.15);
      g.style.opacity = rand(.55, .85).toFixed(2);
      var w = W();
      fly(g, rand(9000, 14000), function(p){
        var x = ltr ? -120 + p * (w + 240) : w + 120 - p * (w + 240);
        var y = y0 + Math.sin(p * Math.PI * 3) * amp;
        return 'translate(' + x + 'px,' + y + 'px) scale(' + (ltr ? -size : size) + ',' + size + ')';
      });
    }

    function batSwarm(){
      var n = isMobile ? 4 : 7, ltr = Math.random() < .5, w = W();
      for (var i = 0; i < n; i++) (function(i){
        var b = el('div', 'hw-bat', SVG_BAT);
        var y0 = rand(.05, .45) * H(), amp = rand(20, 60), freq = rand(4, 8), size = rand(.6, 1.2), delay = i * rand(120, 260);
        b.style.opacity = '0';
        setTimeout(function(){
          b.style.opacity = '1';
          fly(b, rand(4500, 6500), function(p){
            var x = ltr ? -80 + p * (w + 160) : w + 80 - p * (w + 160);
            var y = y0 + Math.sin(p * Math.PI * freq) * amp - p * 60;
            return 'translate(' + x + 'px,' + y + 'px) scale(' + size + ')';
          });
        }, delay);
      })(i);
    }

    function spiderDrop(){
      var s = el('div', 'hw-spider', '<div class="thread"></div>' + SVG_SPIDER);
      s.style.left = rand(8, 92) + '%';
      s.style.setProperty('--drop', Math.round(rand(.25, .5) * H()) + 'px');
      layer.appendChild(s);
      requestAnimationFrame(function(){ requestAnimationFrame(function(){ s.classList.add('down'); }); });
      setTimeout(function(){ s.classList.remove('down'); s.classList.add('up'); }, rand(6000, 9000));
      setTimeout(function(){ s.remove(); }, 12000);
    }

    var LINES = ['Braaains… or wings?', 'Wiiiiings…', 'Need… Devil\'s Kiss…', 'More… than… wings…', 'Order… now…'];
    function zombieWalk(){
      var z = el('div', 'hw-zombie', SVG_ZOMBIE);
      var bubble = el('div', 'hw-bubble hw-font');
      bubble.textContent = LINES[Math.floor(Math.random() * LINES.length)];
      z.appendChild(bubble);
      var ltr = Math.random() < .5, w = W();
      if (!ltr) z.classList.add('flip');
      setTimeout(function(){ bubble.classList.add('show'); }, 3500);
      setTimeout(function(){ bubble.classList.remove('show'); }, 8000);
      fly(z, isMobile ? 16000 : 26000, function(p){
        var x = ltr ? -110 + p * (w + 220) : w + 110 - p * (w + 220);
        return 'translateX(' + x + 'px)';
      });
    }

    every(ghostFlyBy, 14000, 26000, 2500);
    every(batSwarm, 22000, 38000, 9000);
    every(spiderDrop, 30000, 50000, 15000);
    every(zombieWalk, 40000, 70000, 6000);

    // Little ghost that trails the mouse (desktop only)
    if (finePointer) {
      var cg = el('div', '', SVG_GHOST);
      cg.id = 'hw-cursor-ghost';
      cg.style.opacity = '0';
      document.body.appendChild(cg);
      var tx = -100, ty = -100, cx = -100, cy = -100, raf = 0, lastMove = 0;
      function onMove(e){ tx = e.clientX + 18; ty = e.clientY + 14; lastMove = performance.now(); cg.style.opacity = '.75'; if (!raf) raf = requestAnimationFrame(loop); }
      function loop(now){
        cx += (tx - cx) * .08; cy += (ty - cy) * .08;
        var tilt = Math.max(-20, Math.min(20, (tx - cx) * .4));
        cg.style.transform = 'translate(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px) rotate(' + tilt.toFixed(1) + 'deg)';
        if (now - lastMove > 2500) cg.style.opacity = '0';
        raf = (Math.abs(tx - cx) + Math.abs(ty - cy) > .3 || now - lastMove < 2600) ? requestAnimationFrame(loop) : 0;
      }
      window.addEventListener('mousemove', onMove, { passive: true });
      onCleanup(function(){ window.removeEventListener('mousemove', onMove); cancelAnimationFrame(raf); cg.remove(); });
    }
  }

  // ── 3D haunted graveyard in the hero ────────────────────────
  var THREE_PROMISE = null;
  function hero3D(){
    var host = document.querySelector('.hero .hero-3d-bg');
    var hero = document.querySelector('.hero');
    if (!host || !hero) return;

    var flash = el('div'); flash.id = 'hw-flash';
    hero.insertBefore(flash, hero.firstChild);
    onCleanup(function(){ flash.remove(); });

    var cancelled = false;
    onCleanup(function(){ cancelled = true; });

    if (!THREE_PROMISE) THREE_PROMISE = import(THREE_URL);
    THREE_PROMISE.then(function(THREE){
      if (cancelled) return;
      try { buildScene(THREE, host, hero, flash); }
      catch(e){ console.warn('[Halloween] 3D scene failed:', e); }
    }).catch(function(e){ console.warn('[Halloween] could not load Three.js:', e); });
  }

  function buildScene(THREE, host, hero, flash){
    var canvas = document.createElement('canvas');
    canvas.id = 'hw-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: !isMobile, powerPreference: 'low-power' });
    } catch(e) { canvas.remove(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    var scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x160a24, 0.045);
    var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 1.2, 11);
    var lookAt = new THREE.Vector3(0, 0.4, 0);

    var disposables = [];
    function track(o){ disposables.push(o); return o; }

    // Lights
    var ambient = new THREE.AmbientLight(0x5a3f8a, 0.55);
    scene.add(ambient);
    var moonLight = new THREE.DirectionalLight(0xaab8ff, 0.9);
    moonLight.position.set(6, 8, -4);
    scene.add(moonLight);
    var rim = new THREE.DirectionalLight(0xff7518, 0.35);
    rim.position.set(-5, 1, 6);
    scene.add(rim);

    // Soft round sprite texture (moon glow, fog puffs)
    function radialTexture(inner, outer, size){
      var c = document.createElement('canvas'); c.width = c.height = size || 128;
      var g = c.getContext('2d'), r = c.width / 2;
      var grd = g.createRadialGradient(r, r, 0, r, r, r);
      grd.addColorStop(0, inner); grd.addColorStop(1, outer);
      g.fillStyle = grd; g.fillRect(0, 0, c.width, c.width);
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return track(t);
    }

    // Moon
    var moon = new THREE.Group();
    var moonMesh = new THREE.Mesh(track(new THREE.SphereGeometry(1.3, 32, 32)),
      track(new THREE.MeshBasicMaterial({ color: 0xfff2c4, fog: false })));
    moon.add(moonMesh);
    var craterMat = track(new THREE.MeshBasicMaterial({ color: 0xe6d49a, fog: false }));
    [[-.4, .3, .25], [.35, -.2, .32], [.1, .55, .15], [-.2, -.5, .18]].forEach(function(c){
      var cr = new THREE.Mesh(track(new THREE.CircleGeometry(c[2], 20)), craterMat);
      cr.position.set(c[0], c[1], 1.27);
      moon.add(cr);
    });
    var glow = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: radialTexture('rgba(255,236,170,.75)', 'rgba(255,200,120,0)'), transparent: true, depthWrite: false, fog: false })));
    glow.scale.set(7, 7, 1);
    moon.add(glow);
    moon.position.set(5, 4.6, -14);
    scene.add(moon);

    // Ground
    var groundMat = track(new THREE.MeshStandardMaterial({ color: 0x1a0f1f, roughness: 1 }));
    var ground = new THREE.Mesh(track(new THREE.PlaneGeometry(80, 40, 40, 20)), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -3;
    var gp = ground.geometry.attributes.position;
    for (var gi = 0; gi < gp.count; gi++) gp.setZ(gi, Math.sin(gp.getX(gi) * .35) * .25 + Math.cos(gp.getY(gi) * .5) * .2);
    ground.geometry.computeVertexNormals();
    scene.add(ground);

    // Graveyard: tombstones and crosses
    var stoneMat = track(new THREE.MeshStandardMaterial({ color: 0x4b4658, roughness: .95 }));
    var mossMat = track(new THREE.MeshStandardMaterial({ color: 0x33452c, roughness: 1 }));
    function tombstone(){
      var g = new THREE.Group();
      var slab = new THREE.Mesh(track(new THREE.BoxGeometry(1, 1.1, .25)), stoneMat);
      var top = new THREE.Mesh(track(new THREE.CylinderGeometry(.5, .5, .25, 20, 1, false, 0, Math.PI)), stoneMat);
      top.rotation.set(Math.PI / 2, Math.PI / 2, 0); top.position.y = .55;
      var moss = new THREE.Mesh(track(new THREE.BoxGeometry(1.05, .12, .3)), mossMat); moss.position.y = -.5;
      g.add(slab, top, moss);
      return g;
    }
    function cross(){
      var g = new THREE.Group();
      var v = new THREE.Mesh(track(new THREE.BoxGeometry(.2, 1.5, .2)), stoneMat);
      var h = new THREE.Mesh(track(new THREE.BoxGeometry(.9, .2, .2)), stoneMat); h.position.y = .3;
      g.add(v, h);
      return g;
    }
    var graves = [];
    var GRAVE_SPOTS = [[-7.5, -6], [-4.5, -8], [-1.5, -9], [2, -8.5], [5, -7], [8, -8], [-9.5, -3], [9.5, -3.5], [-6, -2], [6.5, -1.5]];
    GRAVE_SPOTS.forEach(function(p, i){
      var g = (i % 3 === 1) ? cross() : tombstone();
      g.position.set(p[0], -2.45, p[1]);
      g.rotation.set(rand(-.08, .08), rand(-.4, .4), rand(-.14, .14));
      g.scale.setScalar(rand(.8, 1.2));
      scene.add(g);
      graves.push(g);
    });

    // Dead trees on the flanks
    var barkMat = track(new THREE.MeshStandardMaterial({ color: 0x140b10, roughness: 1 }));
    function branch(parent, len, rad, depth){
      var m = new THREE.Mesh(track(new THREE.CylinderGeometry(rad * .6, rad, len, 6)), barkMat);
      m.position.y = len / 2;
      var pivot = new THREE.Group();
      pivot.add(m);
      parent.add(pivot);
      if (depth > 0) {
        for (var k = 0; k < 2; k++) {
          var child = new THREE.Group();
          child.position.y = len * rand(.65, .95);
          child.rotation.set(rand(-.3, .3), rand(0, Math.PI * 2), (k ? 1 : -1) * rand(.45, .9));
          pivot.add(child);
          branch(child, len * .68, rad * .6, depth - 1);
        }
      }
      return pivot;
    }
    var trees = [];
    [[-1, -4], [1, -5]].forEach(function(p){
      var t = new THREE.Group();
      branch(t, 2.6, .22, 3);
      t.position.set(p[0], -2.9, p[1]);
      scene.add(t);
      trees.push(t);
    });

    // Jack-o'-lanterns
    function faceTexture(){
      var c = document.createElement('canvas'); c.width = 512; c.height = 256;
      var g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, 512, 256);
      g.fillStyle = '#fff';
      var cx = 128;  // u = .25 faces +z on a Three.js sphere
      g.beginPath(); g.moveTo(cx - 44, 108); g.lineTo(cx - 14, 108); g.lineTo(cx - 30, 78); g.fill();
      g.beginPath(); g.moveTo(cx + 14, 108); g.lineTo(cx + 44, 108); g.lineTo(cx + 30, 78); g.fill();
      g.beginPath(); g.moveTo(cx - 7, 128); g.lineTo(cx + 7, 128); g.lineTo(cx, 116); g.fill();
      g.beginPath();
      g.moveTo(cx - 56, 140);
      g.quadraticCurveTo(cx, 158, cx + 56, 140);
      g.lineTo(cx + 44, 170); g.lineTo(cx + 30, 162); g.lineTo(cx + 18, 178); g.lineTo(cx + 4, 166);
      g.lineTo(cx - 10, 180); g.lineTo(cx - 22, 166); g.lineTo(cx - 36, 176); g.lineTo(cx - 46, 164);
      g.closePath(); g.fill();
      var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      return track(t);
    }
    var faceTex = faceTexture();
    var pumpkinGeo = track(new THREE.SphereGeometry(1, 48, 32));
    (function ridge(){
      var p = pumpkinGeo.attributes.position, v = new THREE.Vector3();
      for (var i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        var ang = Math.atan2(v.z, v.x);
        var k = 1 - .07 * Math.pow(Math.abs(Math.cos(ang * 4)), 3);
        p.setXYZ(i, v.x * k * 1.18, v.y * .82, v.z * k * 1.18);
      }
      pumpkinGeo.computeVertexNormals();
    })();
    var stemGeo = track(new THREE.CylinderGeometry(.08, .14, .45, 8));
    var stemMat = track(new THREE.MeshStandardMaterial({ color: 0x3d5a1e, roughness: .9 }));
    var pumpkins = [];
    function pumpkin(scale){
      var mat = track(new THREE.MeshStandardMaterial({
        color: 0xff7518, roughness: .6, emissive: 0xffb830, emissiveMap: faceTex, emissiveIntensity: 1.6
      }));
      var g = new THREE.Group();
      var body = new THREE.Mesh(pumpkinGeo, mat);
      var stem = new THREE.Mesh(stemGeo, stemMat); stem.position.y = .88; stem.rotation.z = .25;
      var light = new THREE.PointLight(0xff8a1c, 6, 7, 1.6); light.position.set(0, .1, 1.3);
      g.add(body, stem, light);
      g.scale.setScalar(scale);
      g.userData = { mat: mat, light: light, seed: Math.random() * 100 };
      scene.add(g);
      pumpkins.push(g);
      return g;
    }
    var pLeft = pumpkin(.95), pRight = pumpkin(.75), pBack = pumpkin(.55);

    // Ghosts — head + wavy skirt, vertex-animated
    var ghosts = [];
    var ghostMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f6ff, emissive: 0x8fa6ff, emissiveIntensity: .35, roughness: .5, transparent: true, opacity: .88, side: THREE.DoubleSide }));
    var eyeMat = track(new THREE.MeshBasicMaterial({ color: 0x0a0a12 }));
    function ghost(){
      var g = new THREE.Group();
      var head = new THREE.Mesh(track(new THREE.SphereGeometry(.7, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2)), ghostMat);
      var skirtGeo = track(new THREE.CylinderGeometry(.7, .85, 1.4, 32, 8, true));
      var skirt = new THREE.Mesh(skirtGeo, ghostMat); skirt.position.y = -.7;
      var base = Float32Array.from(skirtGeo.attributes.position.array);
      var eyeGeo = track(new THREE.SphereGeometry(.1, 12, 12));
      var eL = new THREE.Mesh(eyeGeo, eyeMat), eR = new THREE.Mesh(eyeGeo, eyeMat), mouth = new THREE.Mesh(eyeGeo, eyeMat);
      eL.scale.set(1, 1.5, .5); eR.scale.set(1, 1.5, .5); mouth.scale.set(1.3, 1.8, .5);
      eL.position.set(-.22, .18, .66); eR.position.set(.22, .18, .66); mouth.position.set(0, -.18, .69);
      var armGeo = track(new THREE.CapsuleGeometry(.12, .45, 4, 8));
      var aL = new THREE.Mesh(armGeo, ghostMat), aR = new THREE.Mesh(armGeo, ghostMat);
      aL.position.set(-.8, -.25, .1); aR.position.set(.8, -.25, .1);
      aL.rotation.z = -1.1; aR.rotation.z = 1.1;
      g.add(head, skirt, eL, eR, mouth, aL, aR);
      var halo = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: radialTexture('rgba(180,200,255,.35)', 'rgba(180,200,255,0)'), transparent: true, depthWrite: false })));
      halo.scale.set(3.4, 3.4, 1); halo.position.y = -.3;
      g.add(halo);
      g.userData = { skirt: skirtGeo, base: base, aL: aL, aR: aR, seed: Math.random() * 10 };
      scene.add(g);
      ghosts.push(g);
      return g;
    }
    var GHOST_COUNT = isMobile ? 2 : 3;
    for (var gh = 0; gh < GHOST_COUNT; gh++) ghost();

    // Zombie — boxy, green, arms out, limping across the graveyard
    var skin = track(new THREE.MeshStandardMaterial({ color: 0x7fae5a, roughness: .8 }));
    var shirt = track(new THREE.MeshStandardMaterial({ color: 0x5b4127, roughness: 1 }));
    var pants = track(new THREE.MeshStandardMaterial({ color: 0x323857, roughness: 1 }));
    var eyeGlow = track(new THREE.MeshBasicMaterial({ color: 0xff2a00 }));
    var hairMat = track(new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1 }));
    function limb(w, h, d, mat){
      var pivot = new THREE.Group();
      var m = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.y = -h / 2;
      pivot.add(m);
      return pivot;
    }
    var zombie = new THREE.Group();
    var zTorso = new THREE.Mesh(track(new THREE.BoxGeometry(.9, 1.1, .5)), shirt); zTorso.position.y = 1.55;
    var zHead = new THREE.Group(); zHead.position.y = 2.15;
    var zHeadMesh = new THREE.Mesh(track(new THREE.BoxGeometry(.62, .66, .6)), skin); zHeadMesh.position.y = .33;
    var zHair = new THREE.Mesh(track(new THREE.BoxGeometry(.66, .16, .64)), hairMat); zHair.position.y = .68;
    var zeGeo = track(new THREE.BoxGeometry(.1, .1, .04));
    var zeL = new THREE.Mesh(zeGeo, eyeGlow), zeR = new THREE.Mesh(zeGeo, eyeGlow);
    zeL.position.set(-.14, .4, .31); zeR.position.set(.15, .38, .31);
    var zMouth = new THREE.Mesh(track(new THREE.BoxGeometry(.3, .07, .04)), hairMat); zMouth.position.set(0, .16, .31);
    zHead.add(zHeadMesh, zHair, zeL, zeR, zMouth);
    zHead.rotation.z = .3;
    var zArmL = limb(.24, .95, .24, skin), zArmR = limb(.24, .95, .24, skin);
    zArmL.position.set(-.56, 2.0, 0); zArmR.position.set(.56, 2.0, 0);
    var zSleeveL = new THREE.Mesh(track(new THREE.BoxGeometry(.28, .35, .28)), shirt); zSleeveL.position.y = -.17; zArmL.add(zSleeveL);
    var zSleeveR = zSleeveL.clone(); zArmR.add(zSleeveR);
    var zLegL = limb(.32, 1, .32, pants), zLegR = limb(.32, 1, .32, pants);
    zLegL.position.set(-.22, 1.0, 0); zLegR.position.set(.22, 1.0, 0);
    zombie.add(zTorso, zHead, zArmL, zArmR, zLegL, zLegR);
    zombie.scale.setScalar(.85);
    zombie.position.set(-10, -3, -1.5);
    scene.add(zombie);
    var zombieLight = new THREE.PointLight(0x7cfc00, .6, 4); zombieLight.position.set(0, 2.4, 1); zombie.add(zombieLight);

    // Zombie hands clawing out of the ground
    var hands = [];
    function zombieHand(){
      var h = new THREE.Group();
      var arm = new THREE.Mesh(track(new THREE.CylinderGeometry(.13, .16, 1.1, 8)), skin); arm.position.y = .55;
      var palm = new THREE.Mesh(track(new THREE.BoxGeometry(.36, .36, .14)), skin); palm.position.y = 1.25;
      h.add(arm, palm);
      var fGeo = track(new THREE.CylinderGeometry(.035, .045, .32, 6));
      var fingers = [];
      for (var f = 0; f < 4; f++) {
        var fp = new THREE.Group(); fp.position.set(-.13 + f * .087, 1.43, 0);
        var fm = new THREE.Mesh(fGeo, skin); fm.position.y = .16; fp.add(fm);
        h.add(fp); fingers.push(fp);
      }
      var thumb = new THREE.Group(); thumb.position.set(.2, 1.2, 0); thumb.rotation.z = -.9;
      var tm = new THREE.Mesh(fGeo, skin); tm.position.y = .14; thumb.add(tm); h.add(thumb);
      var dirt = new THREE.Mesh(track(new THREE.CylinderGeometry(.5, .7, .15, 10)), track(new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 1 })));
      var mound = new THREE.Group(); mound.add(dirt);
      h.userData = { fingers: fingers, phase: Math.random() * 20, period: rand(11, 16), mound: mound };
      scene.add(h); scene.add(mound);
      hands.push(h);
    }
    var HAND_COUNT = isMobile ? 2 : 3;
    for (var hi = 0; hi < HAND_COUNT; hi++) zombieHand();

    // Bats circling the moon
    var bats = [];
    var batMat = track(new THREE.MeshBasicMaterial({ color: 0x07030b, side: THREE.DoubleSide }));
    var wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0); wingShape.lineTo(.9, .35); wingShape.lineTo(.75, .05); wingShape.lineTo(.55, .12);
    wingShape.lineTo(.45, -.08); wingShape.lineTo(.25, 0); wingShape.lineTo(.12, -.12); wingShape.lineTo(0, 0);
    var wingGeo = track(new THREE.ShapeGeometry(wingShape));
    var batBodyGeo = track(new THREE.SphereGeometry(.12, 8, 8));
    var BAT_COUNT = isMobile ? 5 : 10;
    for (var b = 0; b < BAT_COUNT; b++) {
      var bat = new THREE.Group();
      var wl = new THREE.Mesh(wingGeo, batMat), wr = new THREE.Mesh(wingGeo, batMat);
      wr.scale.x = -1;
      var bw = new THREE.Group(), bwr = new THREE.Group(); bw.add(wl); bwr.add(wr);
      bat.add(new THREE.Mesh(batBodyGeo, batMat), bw, bwr);
      bat.userData = { wl: bw, wr: bwr, r: rand(2.5, 6), speed: rand(.25, .5) * (Math.random() < .5 ? -1 : 1), phase: rand(0, Math.PI * 2), y: rand(-1, 2.5), flap: rand(14, 20) };
      bat.scale.setScalar(rand(.6, 1.1));
      scene.add(bat);
      bats.push(bat);
    }

    // Rolling ground fog
    var fogTex = radialTexture('rgba(190,170,230,.28)', 'rgba(190,170,230,0)', 64);
    var fogs = [];
    var FOG_COUNT = isMobile ? 14 : 28;
    for (var fi = 0; fi < FOG_COUNT; fi++) {
      var fs = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: fogTex, transparent: true, depthWrite: false, opacity: rand(.5, 1) })));
      var sc = rand(4, 8);
      fs.scale.set(sc * 1.8, sc, 1);
      fs.position.set(rand(-16, 16), rand(-2.9, -1.6), rand(-9, 3));
      fs.userData = { speed: rand(.15, .4) * (Math.random() < .5 ? -1 : 1) };
      scene.add(fs);
      fogs.push(fs);
    }

    // Embers / will-o'-wisps
    var EMBERS = isMobile ? 40 : 90;
    var eGeo = track(new THREE.BufferGeometry());
    var ePos = new Float32Array(EMBERS * 3), eSeed = new Float32Array(EMBERS);
    for (var ei = 0; ei < EMBERS; ei++) {
      ePos[ei * 3] = rand(-12, 12); ePos[ei * 3 + 1] = rand(-3, 5); ePos[ei * 3 + 2] = rand(-8, 3);
      eSeed[ei] = Math.random() * 100;
    }
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    var embers = new THREE.Points(eGeo, track(new THREE.PointsMaterial({
      size: .12, map: radialTexture('rgba(255,200,90,1)', 'rgba(255,120,20,0)', 32), color: 0xffa040,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    })));
    scene.add(embers);

    // ── Layout: keep pumpkins/ghosts framing the hero text ─────
    var halfW = 8, halfH = 4;
    function layout(){
      var w = hero.clientWidth, h = hero.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = camera.aspect < .8 ? 62 : 50;
      camera.updateProjectionMatrix();
      var dist = camera.position.z;
      halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
      halfW = halfH * camera.aspect;
      var narrow = camera.aspect < .8;
      pLeft.position.set(-halfW * (narrow ? .55 : .72), -2.3, narrow ? 1 : 0.5);
      pRight.position.set(halfW * (narrow ? .6 : .78), -2.4, narrow ? 1.5 : 1.2);
      pBack.position.set(halfW * .35, -2.55, -3.5);
      trees[0].position.x = -halfW * 1.05; trees[1].position.x = halfW * 1.05;
      var moonHalfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (dist - moon.position.z);
      moon.position.x = moonHalfH * camera.aspect * .5;
      moon.position.y = lookAt.y + moonHalfH * (narrow ? .72 : .35);
      hands.forEach(function(hd, i){
        var slots = narrow ? [-.5, .45, .05] : [-.5, .52, -.18];
        hd.position.set(halfW * slots[i % slots.length], -3.1, -1 - i * .8);
        hd.userData.mound.position.set(hd.position.x, -3.02, hd.position.z);
      });
    }
    layout();
    var ro = ('ResizeObserver' in window) ? new ResizeObserver(layout) : null;
    if (ro) ro.observe(hero); else window.addEventListener('resize', layout);

    // Pointer / tilt parallax
    var px = 0, py = 0, tpx = 0, tpy = 0;
    function onPointer(e){ tpx = (e.clientX / window.innerWidth - .5) * 2; tpy = (e.clientY / window.innerHeight - .5) * 2; }
    function onTilt(e){ if (e.gamma == null) return; tpx = Math.max(-1, Math.min(1, e.gamma / 30)); tpy = Math.max(-1, Math.min(1, (e.beta - 45) / 30)); }
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('deviceorientation', onTilt, { passive: true });

    // Lightning
    var strike = 0;
    function lightning(){
      strike = performance.now();
      flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
    }

    // ── Animation loop ─────────────────────────────────────────
    var clock = new THREE.Clock();
    var running = false, visible = true, rafId = 0;
    var zombieDir = 1;
    function frame(){
      rafId = 0;
      if (!running) return;
      var dt = Math.min(clock.getDelta(), .05), t = clock.elapsedTime;

      px += (tpx - px) * .04; py += (tpy - py) * .04;
      camera.position.x = px * .8;
      camera.position.y = 1.2 - py * .4;
      camera.lookAt(lookAt);

      // Lightning ambient spike
      var since = (performance.now() - strike) / 1000;
      var bolt = since < 1 ? Math.max(0, (since < .06 ? 1 : since < .16 ? .1 : since < .3 ? .8 : 0) * (1 - since)) : 0;
      ambient.intensity = .55 + bolt * 3;
      moonLight.intensity = .9 + bolt * 4;

      // Pumpkins flicker + wobble
      pumpkins.forEach(function(p){
        var s = p.userData.seed;
        var flick = .75 + .25 * Math.sin(t * 9 + s) * Math.sin(t * 13.7 + s * 2) + (Math.random() - .5) * .15;
        p.userData.mat.emissiveIntensity = 1.3 * flick + .3;
        p.userData.light.intensity = 6 * flick;
        p.rotation.y = Math.sin(t * .6 + s) * .25;
        p.rotation.z = Math.sin(t * 1.3 + s) * .03;
      });

      // Ghosts haunt the flanks (never parked behind the headline);
      // a third one wanders high across the back of the graveyard.
      ghosts.forEach(function(g, i){
        var u = g.userData, s = u.seed, ph = t * .3 + s;
        var narrow = camera.aspect < .8;
        if (i < 2) {
          var side = i ? 1 : -1;
          g.position.set(side * halfW * ((narrow ? .7 : .62) + Math.sin(ph) * (narrow ? .12 : .2)),
            .8 + Math.sin(ph * 1.3) * 1.3 + Math.sin(t * 1.4 + s) * .25,
            -1.5 + Math.cos(ph * .7) * 1.8);
          g.rotation.y = -side * .35 + Math.cos(ph) * .3;
          g.rotation.z = -Math.cos(ph) * .15;
        } else {
          var sweep = Math.sin(t * .09 + s);
          g.position.set(sweep * halfW * 1.6, halfH * .62 + Math.sin(t * 1.1 + s) * .4, -8);
          g.rotation.y = Math.cos(t * .09 + s) > 0 ? .7 : -.7;
          g.rotation.z = -Math.cos(t * .09 + s) * .2;
        }
        var sk = u.skirt.attributes.position, base = u.base;
        for (var vi = 0; vi < sk.count; vi++) {
          var bx = base[vi * 3], by = base[vi * 3 + 1], bz = base[vi * 3 + 2];
          var depth = (.7 - by) / 1.4;  // 0 at top, 1 at hem
          var ang = Math.atan2(bz, bx);
          var wave = Math.sin(ang * 6 + t * 5 + s) * .09 * depth + Math.sin(t * 2.2 + by * 3 + s) * .06 * depth;
          sk.setXYZ(vi, bx * (1 + wave), by + (depth > .95 ? Math.sin(ang * 8 + t * 6) * .12 : 0), bz * (1 + wave));
        }
        sk.needsUpdate = true;
        u.aL.rotation.z = -1.1 + Math.sin(t * 3 + s) * .35;
        u.aR.rotation.z = 1.1 - Math.sin(t * 3 + s + 1) * .35;
      });

      // Zombie shamble: limp gait, swaying torso, lolling head
      var gait = t * 3.2;
      zombie.position.x += zombieDir * dt * .55;
      var edge = halfW + 2;
      if (zombie.position.x > edge) { zombieDir = -1; }
      if (zombie.position.x < -edge) { zombieDir = 1; }
      zombie.rotation.y += ((zombieDir > 0 ? Math.PI / 2 - .5 : -Math.PI / 2 + .5) - zombie.rotation.y) * .05;
      zLegL.rotation.x = Math.sin(gait) * .55;
      zLegR.rotation.x = -Math.sin(gait) * .35;  // the bad leg
      zArmL.rotation.x = -Math.PI / 2 + Math.sin(gait * .5) * .15;
      zArmR.rotation.x = -Math.PI / 2 + .2 + Math.sin(gait * .5 + 1) * .2;
      zombie.position.y = -3 + Math.abs(Math.sin(gait)) * .08;
      zombie.rotation.z = Math.sin(gait) * .08;
      zHead.rotation.z = .3 + Math.sin(gait * .5) * .15;
      zHead.rotation.x = Math.sin(gait * .25) * .2;
      zeL.material.color.setHSL(.02, 1, .45 + .1 * Math.sin(t * 6));

      // Hands claw up, twitch, sink back down
      hands.forEach(function(hd){
        var u = hd.userData;
        var cyc = ((t + u.phase) % u.period) / u.period;
        var rise = cyc < .2 ? cyc / .2 : cyc < .6 ? 1 : cyc < .75 ? 1 - (cyc - .6) / .15 : 0;
        rise = rise * rise * (3 - 2 * rise);
        hd.position.y = -3.1 - 1.7 * (1 - rise) + Math.sin(t * 7) * .02 * rise;
        hd.rotation.z = Math.sin(t * 2 + u.phase) * .2 * rise;
        u.fingers.forEach(function(f, k){ f.rotation.x = .25 + Math.sin(t * 8 + k * .8) * .5 * rise; });
        u.mound.scale.setScalar(.6 + rise * .5);
      });

      // Bats circle the moon
      bats.forEach(function(b){
        var u = b.userData, a = t * u.speed + u.phase;
        b.position.set(moon.position.x * .45 + Math.cos(a) * u.r, moon.position.y * .45 + u.y + Math.sin(a * 2) * .5, -6 + Math.sin(a) * u.r * .6);
        b.rotation.y = -a + (u.speed > 0 ? 0 : Math.PI);
        var flap = Math.sin(t * u.flap + u.phase) * .9;
        u.wl.rotation.y = flap; u.wr.rotation.y = -flap;
      });

      // Fog drift
      fogs.forEach(function(f){
        f.position.x += f.userData.speed * dt;
        if (f.position.x > 17) f.position.x = -17;
        if (f.position.x < -17) f.position.x = 17;
      });

      // Embers float upward
      var ep = eGeo.attributes.position;
      for (var k = 0; k < EMBERS; k++) {
        var yv = ep.getY(k) + dt * (.25 + (eSeed[k] % 1) * .4);
        if (yv > 5) yv = -3;
        ep.setY(k, yv);
        ep.setX(k, ep.getX(k) + Math.sin(t + eSeed[k]) * dt * .15);
      }
      ep.needsUpdate = true;

      moon.rotation.z = Math.sin(t * .1) * .05;

      renderer.render(scene, camera);
      rafId = requestAnimationFrame(frame);
    }

    function setRunning(on){
      on = on && visible && !document.hidden && !reduceMotion;
      if (on === running) return;
      running = on;
      if (on) { clock.getDelta(); rafId = requestAnimationFrame(frame); }
      else if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    // Only animate while the hero is on screen and the tab is visible
    var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function(entries){
      visible = entries[0].isIntersecting; setRunning(true);
    }) : null;
    if (io) io.observe(hero);
    function onVis(){ setRunning(true); }
    document.addEventListener('visibilitychange', onVis);

    if (reduceMotion) {
      // One still frame for motion-sensitive visitors
      camera.lookAt(lookAt);
      hands.forEach(function(hd){ hd.position.y = -3.1; });
      renderer.render(scene, camera);
    } else {
      setRunning(true);
      every(lightning, 12000, 24000, 4000);
    }

    onCleanup(function(){
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (io) io.disconnect();
      if (ro) ro.disconnect(); else window.removeEventListener('resize', layout);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('deviceorientation', onTilt);
      disposables.forEach(function(d){ try { d.dispose(); } catch(e){} });
      renderer.dispose();
      canvas.remove();
    });
  }

  // ═════════════════════════════════════════════════════════════
  // 👻 GHOST HUNT — catch 5 hidden ghosts → FREE fries on $30+
  // ─────────────────────────────────────────────────────────────
  // Progress lives in this browser (localStorage). The reward is
  // requested at checkout and validated by the server (/api/orders):
  // in season, subtotal ≥ $30, once per phone number per year.
  // ═════════════════════════════════════════════════════════════
  var HUNT_KEY = 'wingo_ghost_hunt';
  var HUNT_MIN = 30;
  // Where the ghosts hide. The footer one is small and shy on purpose.
  var HUNT_SPOTS = [
    { id: 'hero',    sel: '.hero',        css: 'left:5%;top:34%;',     size: 50 },
    { id: 'deals',   sel: '.promo-bar',   css: 'right:1.5%;top:-18px;', size: 44 },
    { id: 'menu',    sel: '#cat-section', css: 'right:3%;top:1.2rem;',  size: 46 },
    { id: 'reviews', sel: '#reviews',     css: 'left:2%;top:1.4rem;', size: 44 },
    { id: 'footer',  sel: 'footer',       css: 'right:6%;top:1.2rem;', size: 34, shy: true }
  ];

  function huntState(){
    var s = null;
    try { s = JSON.parse(localStorage.getItem(HUNT_KEY) || 'null'); } catch(e){}
    s = s || {};
    s.caught = Array.isArray(s.caught) ? s.caught : [];
    return s;
  }
  function saveHunt(s){ try { localStorage.setItem(HUNT_KEY, JSON.stringify(s)); } catch(e){} }
  function analytics(name, params){ if (window.trackEvent) try { window.trackEvent(name, params || {}); } catch(e){} }

  var HUNT_CSS = [
    // Hidden ghosts
    '.hw-hunt{position:absolute;z-index:5;padding:0;border:0;background:none;cursor:pointer;pointer-events:auto;-webkit-tap-highlight-color:transparent;filter:drop-shadow(0 0 10px rgba(124,252,0,.7)) drop-shadow(0 0 3px rgba(255,255,255,.9));animation:hw-peek 5s ease-in-out infinite;}',
    '.hw-hunt.shy{animation:hw-shy 7s ease-in-out infinite;}',
    '.hw-hunt svg{display:block;width:100%;height:auto;}',
    '.hw-hunt:hover,.hw-hunt:focus-visible{outline:none;animation-play-state:paused;transform:scale(1.15);opacity:1;}',
    '.hw-hunt::after{content:"";position:absolute;inset:-14px;}',  // bigger tap target
    '@keyframes hw-peek{0%,100%{transform:translateY(0) rotate(-6deg);opacity:.95}50%{transform:translateY(-8px) rotate(6deg);opacity:.75}}',
    '@keyframes hw-shy{0%,100%{opacity:.15;transform:translateY(6px)}35%,65%{opacity:.9;transform:translateY(-4px)}}',
    '.hw-poof{position:absolute;z-index:6;pointer-events:none;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:#dfffc8;box-shadow:0 0 12px #7CFC00;animation:hw-poof .7s ease-out forwards;}',
    '@keyframes hw-poof{to{transform:translate(var(--dx),var(--dy)) scale(.2);opacity:0}}',
    '.hw-caught{animation:hw-caught .5s ease-in forwards!important;pointer-events:none;}',
    '@keyframes hw-caught{0%{transform:scale(1)}40%{transform:scale(1.5) rotate(20deg)}100%{transform:scale(0) rotate(-40deg);opacity:0}}',
    // Progress pill (sits right of the pumpkin toggle)
    '#hw-hud{position:fixed;left:calc(1rem + 56px);bottom:5.2rem;z-index:998;display:flex;align-items:center;gap:.4rem;padding:.4rem .8rem;border-radius:40px;border:2px solid #7CFC00;background:#12061f;color:#fff;font-family:"Creepster","Bebas Neue",cursive;font-size:1.05rem;letter-spacing:1.5px;cursor:pointer;box-shadow:0 0 14px rgba(124,252,0,.35);}',
    '#hw-hud .dots{display:flex;gap:3px;}#hw-hud .dots i{width:8px;height:8px;border-radius:50%;background:#3a2a4a;}#hw-hud .dots i.on{background:#7CFC00;box-shadow:0 0 6px #7CFC00;}',
    '#hw-hud.bump{animation:hw-bump .5s;}@keyframes hw-bump{50%{transform:scale(1.2)}}',
    '#hw-hud.won{border-color:#FF7518;box-shadow:0 0 14px rgba(255,117,24,.5);}',
    '@media (max-width:768px){#hw-hud{left:calc(.6rem + 48px);font-size:.95rem;padding:.35rem .7rem;}body.cart-open #hw-hud,body.checkout-open #hw-hud,body.modal-open #hw-hud,body.cart-open #hw-intro,body.checkout-open #hw-intro,body.modal-open #hw-intro{display:none;}}',
    '@media (max-width:600px){#hw-hud{bottom:8.6rem;}}',
    // Intro card
    '#hw-intro{position:fixed;left:1rem;bottom:8.6rem;z-index:998;width:min(330px,calc(100vw - 2rem));background:linear-gradient(160deg,#1c0a2e,#0d0614);color:#eee;border:2px solid #7CFC00;border-radius:14px;padding:1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.6),0 0 24px rgba(124,252,0,.25);font-family:var(--font-body,Inter,sans-serif);transform:translateY(20px);opacity:0;transition:all .45s cubic-bezier(.3,1.4,.5,1);}',
    '#hw-intro.show{transform:none;opacity:1;}',
    '@media (max-width:600px){#hw-intro{left:.6rem;bottom:11.6rem;}}',
    '#hw-intro h4{margin:0 0 .35rem;font-family:"Creepster","Bebas Neue",cursive;font-weight:400;font-size:1.5rem;letter-spacing:2px;color:#B8F28B;}',
    '#hw-intro p{margin:0 0 .8rem;font-size:.88rem;line-height:1.45;}#hw-intro p b{color:#FFB347;}',
    '#hw-intro .x{position:absolute;top:.4rem;right:.6rem;background:none;border:0;color:#999;font-size:1.3rem;cursor:pointer;}',
    '.hw-btn{display:inline-block;border:0;border-radius:8px;padding:.7rem 1.1rem;font-family:var(--font-head,Oswald,sans-serif);font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-size:.85rem;cursor:pointer;background:#FF7518;color:#12061f;box-shadow:0 3px 0 #8a3300;}',
    '.hw-btn.alt{background:transparent;color:#B8F28B;border:1.5px solid #7CFC00;box-shadow:none;}',
    // Toast
    '#hw-toast{position:fixed;left:50%;top:84px;z-index:100001;transform:translate(-50%,-20px);opacity:0;background:#12061f;color:#fff;border:2px solid #7CFC00;border-radius:40px;padding:.6rem 1.2rem;font-family:"Creepster","Bebas Neue",cursive;font-size:1.15rem;letter-spacing:1.5px;white-space:nowrap;box-shadow:0 0 20px rgba(124,252,0,.4);transition:all .35s;pointer-events:none;}',
    '#hw-toast.show{opacity:1;transform:translate(-50%,0);}',
    // Win modal
    '#hw-win{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:1rem;background:radial-gradient(ellipse at center,rgba(40,10,60,.92),rgba(5,2,10,.97));animation:hw-fadein .4s;}',
    '@keyframes hw-fadein{from{opacity:0}}',
    '#hw-win .card{position:relative;max-width:420px;width:100%;text-align:center;color:#eee;background:linear-gradient(170deg,#1c0a2e,#0d0614);border:2px solid #FF7518;border-radius:18px;padding:1.6rem 1.4rem 1.4rem;box-shadow:0 0 50px rgba(255,117,24,.45);animation:hw-rise .6s cubic-bezier(.3,1.5,.5,1);}',
    '@keyframes hw-rise{from{transform:translateY(40px) scale(.9);opacity:0}}',
    '#hw-win .big{width:110px;margin:-4.2rem auto .4rem;filter:drop-shadow(0 0 20px rgba(200,220,255,.9));animation:hw-peek 2.4s ease-in-out infinite;}',
    '#hw-win h3{margin:0;font-family:"Creepster","Bebas Neue",cursive;font-weight:400;font-size:2.1rem;letter-spacing:2px;color:#B8F28B;line-height:1.05;text-shadow:0 0 16px rgba(124,252,0,.5);}',
    '#hw-win .prize{margin:.7rem 0 .3rem;font-family:"Creepster","Bebas Neue",cursive;font-size:1.7rem;color:#FF7518;letter-spacing:1.5px;}',
    '#hw-win p{font-size:.9rem;line-height:1.5;margin:0 0 1.1rem;color:#ccc;}#hw-win p b{color:#FFB347;}',
    '#hw-win .row{display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;}',
    '#hw-win .x{position:absolute;top:.5rem;right:.8rem;background:none;border:0;color:#999;font-size:1.5rem;cursor:pointer;}',
    '.hw-confetti{position:fixed;top:-40px;z-index:100001;pointer-events:none;font-size:1.6rem;animation:hw-fall linear forwards;}',
    '@keyframes hw-fall{to{transform:translateY(110vh) rotate(720deg)}}',
    // Checkout badge
    '.hw-co{border-radius:8px;padding:.7rem .9rem;margin:.5rem 0;font-family:var(--font-head,Oswald,sans-serif);font-size:.85rem;font-weight:700;letter-spacing:.5px;display:flex;justify-content:space-between;align-items:center;gap:.5rem;}',
    '.hw-co.ok{background:linear-gradient(90deg,#1c0a2e,#2b0b3d);color:#FFB347;border:1.5px solid #FF7518;}',
    '.hw-co.ok span:last-child{color:#B8F28B;}',
    '.hw-co.need{background:rgba(124,252,0,.07);color:#3d6b12;border:1.5px dashed #6fae3a;justify-content:center;text-align:center;}'
  ].join('\n');

  var huntStyle = null;
  function huntStyles(){
    if (huntStyle) return;
    huntStyle = document.createElement('style');
    huntStyle.textContent = HUNT_CSS;
    document.head.appendChild(huntStyle);
  }

  var toastTimer;
  function huntToast(msg){
    var t = document.getElementById('hw-toast');
    if (!t) { t = el('div', ''); t.id = 'hw-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove('show'); }, 2600);
  }

  function goToMenu(){
    var home = document.getElementById('home-page');
    if (home && home.style.display === 'none' && typeof window.showHome === 'function') window.showHome();
    setTimeout(function(){
      var m = document.getElementById('cat-section');
      if (m) m.scrollIntoView({ behavior: 'smooth' });
    }, 150);
  }

  function shareHunt(btn){
    var url = location.origin + '/?halloween=1';
    var text = 'I survived the Wing-O Ghost Hunt 👻🎃 and scored FREE fries! Can you find all 5 ghosts?';
    if (navigator.share) {
      navigator.share({ title: 'Wing-O Ghost Hunt', text: text, url: url }).then(function(){ analytics('ghost_hunt_share', { method: 'native' }); }).catch(function(){});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text + ' ' + url).then(function(){ btn.textContent = 'Link copied! ✅'; analytics('ghost_hunt_share', { method: 'copy' }); });
    }
  }

  function confetti(){
    if (reduceMotion) return;
    var bits = ['🎃', '👻', '🍟', '🦇', '🍬', '🍗'];
    for (var i = 0; i < 36; i++) {
      var c = el('div', 'hw-confetti');
      c.textContent = bits[i % bits.length];
      c.style.left = rand(0, 100) + 'vw';
      c.style.animationDuration = rand(2.2, 4.2) + 's';
      c.style.animationDelay = rand(0, 1.2) + 's';
      document.body.appendChild(c);
      (function(c){ setTimeout(function(){ c.remove(); }, 6000); })(c);
    }
  }

  function winModal(){
    var s = huntState();
    var m = el('div', '');
    m.id = 'hw-win';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'Ghost Hunt complete');
    var body = s.redeemed
      ? '<p>You already claimed your free fries this season. Thanks for playing — see you next Halloween! 👻</p>'
      : '<p>Your <b>FREE small fries</b> are unlocked for any order of <b>$' + HUNT_MIN + '+</b>. They\'re added automatically at checkout — just order on this device. One per customer; can\'t be combined with the 15% first-order discount.</p>';
    m.innerHTML = '<div class="card"><button class="x" aria-label="Close">×</button>' +
      '<div class="big">' + SVG_GHOST + '</div>' +
      '<h3>You survived the Ghost Hunt!</h3>' +
      '<div class="prize">🍟 Free fries are yours</div>' + body +
      '<div class="row">' + (s.redeemed ? '' : '<button class="hw-btn" data-a="order">Order now 🍗</button>') +
      '<button class="hw-btn alt" data-a="share">Dare a friend 📣</button></div></div>';
    function close(){ m.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e){ if (e.key === 'Escape') close(); }
    m.addEventListener('click', function(e){
      var a = e.target.closest('[data-a]');
      if (e.target === m || e.target.classList.contains('x')) close();
      else if (a && a.dataset.a === 'order') { close(); goToMenu(); analytics('ghost_hunt_order_click'); }
      else if (a && a.dataset.a === 'share') shareHunt(a);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(m);
    var first = m.querySelector('.hw-btn'); if (first) first.focus();
  }

  function infoModalOrIntro(){
    var s = huntState();
    if (s.won) return winModal();
    showIntro(true);
  }

  function showIntro(force){
    var s = huntState();
    if (document.getElementById('hw-intro') || s.won || (!force && s.intro)) return;
    var n = s.caught.length;
    var card = el('div', '');
    card.id = 'hw-intro';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Ghost Hunt');
    card.innerHTML = '<button class="x" aria-label="Close">×</button><h4>👻 Ghost Hunt</h4>' +
      '<p>5 ghosts are hiding around this page. Catch them all and get <b>FREE fries</b> on your $' + HUNT_MIN + '+ order!' +
      (n ? ' You\'ve caught <b>' + n + '/5</b> so far.' : '') + '</p>' +
      '<button class="hw-btn">' + (n ? 'Keep hunting' : 'Start hunting') + ' 🔦</button>';
    function close(){ card.classList.remove('show'); setTimeout(function(){ card.remove(); }, 400); var st = huntState(); st.intro = true; saveHunt(st); }
    card.querySelector('.x').addEventListener('click', close);
    card.querySelector('.hw-btn').addEventListener('click', function(){ close(); analytics('ghost_hunt_start'); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(card);
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ card.classList.add('show'); }); });
    onCleanup(function(){ card.remove(); });
  }

  function hunt(){
    huntStyles();
    var s = huntState();

    // Progress pill
    var hud = el('button', '');
    hud.id = 'hw-hud';
    hud.type = 'button';
    function paintHud(){
      var st = huntState(), n = Math.min(st.caught.length, HUNT_SPOTS.length);
      hud.classList.toggle('won', !!st.won);
      hud.innerHTML = st.won ? '🍟 Free fries!' : '👻 ' + n + '/5 <span class="dots">' +
        HUNT_SPOTS.map(function(sp){ return '<i class="' + (st.caught.indexOf(sp.id) !== -1 ? 'on' : '') + '"></i>'; }).join('') + '</span>';
      hud.setAttribute('aria-label', st.won ? 'Ghost Hunt complete — free fries unlocked' : 'Ghost Hunt: ' + n + ' of 5 ghosts caught');
    }
    paintHud();
    hud.addEventListener('click', infoModalOrIntro);
    document.body.appendChild(hud);
    onCleanup(function(){ hud.remove(); });

    if (!s.won) {
      var introT = setTimeout(function(){ showIntro(false); }, 6000);
      onCleanup(function(){ clearTimeout(introT); });
    }

    // Place the uncaught ghosts
    HUNT_SPOTS.forEach(function(sp){
      if (s.won || s.caught.indexOf(sp.id) !== -1) return;
      var host = document.querySelector(sp.sel);
      if (!host) return;
      var restorePos = null;
      if (getComputedStyle(host).position === 'static') { restorePos = host.style.position; host.style.position = 'relative'; }
      var g = el('button', 'hw-hunt' + (sp.shy ? ' shy' : ''), SVG_GHOST);
      g.type = 'button';
      g.setAttribute('aria-label', 'Catch the hidden ghost');
      g.style.cssText = sp.css + 'width:' + sp.size + 'px;animation-delay:-' + rand(0, 4).toFixed(1) + 's;';
      g.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        catchGhost(sp.id, g, host);
      });
      host.appendChild(g);
      onCleanup(function(){ g.remove(); if (restorePos !== null) host.style.position = restorePos; });
    });

    function catchGhost(id, g, host){
      var st = huntState();
      if (st.caught.indexOf(id) === -1) st.caught.push(id);
      var n = st.caught.length;
      // Burst of ecto-sparks
      var r = g.getBoundingClientRect(), hr = host.getBoundingClientRect();
      for (var i = 0; i < 12; i++) {
        var p = el('div', 'hw-poof'), a = i / 12 * Math.PI * 2, d = rand(30, 60);
        p.style.left = (r.left - hr.left + r.width / 2) + 'px';
        p.style.top = (r.top - hr.top + r.height / 2) + 'px';
        p.style.setProperty('--dx', Math.cos(a) * d + 'px');
        p.style.setProperty('--dy', Math.sin(a) * d + 'px');
        host.appendChild(p);
        (function(p){ setTimeout(function(){ p.remove(); }, 800); })(p);
      }
      g.classList.add('hw-caught');
      setTimeout(function(){ g.remove(); }, 520);
      analytics('ghost_caught', { ghost: id, count: n });
      if (n >= HUNT_SPOTS.length && !st.won) {
        st.won = true;
        saveHunt(st);
        analytics('ghost_hunt_won');
        huntToast('👻 5/5 — You caught them all!');
        setTimeout(function(){ confetti(); winModal(); }, 700);
      } else {
        saveHunt(st);
        var left = HUNT_SPOTS.length - n;
        huntToast(['👻 Gotcha!', '👻 Boo-yah!', '👻 Caught one!', '👻 Spooky skills!'][n % 4] + ' ' + n + '/5 — ' + left + ' more hiding…');
      }
      var intro = document.getElementById('hw-intro'); if (intro) intro.remove();
      hud.classList.remove('bump'); void hud.offsetWidth; hud.classList.add('bump');
      paintHud();
    }
  }

  // Checkout: show the reward and ask the server for it (runs even if
  // spooky visuals are switched off, so a winner never loses the prize).
  function installCheckoutHooks(){
    huntStyles();
    function eligible(){ var s = huntState(); return s.won && !s.redeemed; }
    // Doesn't stack with the 15% first-order discount (set by that wrapper)
    function firstOrderDiscount(){ return (window._foDiscount || 0) > 0; }
    function cartSubtotal(){ return (window.cart || []).reduce(function(t, i){ return t + i.price * i.qty; }, 0); }

    (function wrapRender(){
      if (typeof window.renderCheckoutForm !== 'function') return setTimeout(wrapRender, 250);
      if (window._ghostHuntWrapped) return;
      window._ghostHuntWrapped = true;
      var orig = window.renderCheckoutForm;
      window.renderCheckoutForm = function(){
        var out = orig.apply(this, arguments);
        try {
          var old = document.getElementById('hw-co-badge'); if (old) old.remove();
          if (!eligible()) return out;
          var osBox = document.querySelector('#mbd .os-box');
          if (!osBox) return out;
          var sub = cartSubtotal(), b = el('div', '');
          b.id = 'hw-co-badge';
          if (firstOrderDiscount()) {
            b.className = 'hw-co need';
            b.textContent = '👻 Your 15% first-order discount applies today — your FREE Ghost Hunt fries are saved for your next $' + HUNT_MIN + '+ order!';
          } else if (sub >= HUNT_MIN) {
            b.className = 'hw-co ok';
            b.innerHTML = '<span>🎃 Ghost Hunt reward: FREE small fries 🍟</span><span>$0.00</span>';
          } else if (sub > 0) {
            b.className = 'hw-co need';
            b.textContent = '👻 Add $' + (HUNT_MIN - sub).toFixed(2) + ' more to claim your FREE Ghost Hunt fries!';
          } else return out;
          osBox.parentNode.insertBefore(b, osBox);
        } catch(e){ console.warn('[Halloween] checkout badge:', e); }
        return out;
      };
    })();

    var origFetch = window.fetch;
    window.fetch = function(url, options){
      var isOrder = typeof url === 'string' && url.indexOf('/api/orders') !== -1 && options && options.method === 'POST';
      var asked = false;
      if (isOrder && eligible()) {
        try {
          var body = JSON.parse(options.body);
          if ((Number(body.subtotal) || 0) >= HUNT_MIN && !firstOrderDiscount()) {
            body.ghostHunt = 'fries';
            options.body = JSON.stringify(body);
            asked = true;
          }
        } catch(e){ console.warn('[Halloween] order intercept failed:', e); }
      }
      var p = origFetch.apply(this, arguments);
      if (!asked) return p;
      return p.then(function(resp){
        resp.clone().json().then(function(d){
          if (d && (d.ghostHuntFries || d.ghostHuntDenied === 'already-redeemed')) {
            var s = huntState(); s.redeemed = true; saveHunt(s);
            if (d.ghostHuntFries) analytics('ghost_hunt_redeemed');
          }
        }).catch(function(){});
        return resp;
      });
    };
  }

  // ── On / off ────────────────────────────────────────────────
  var active = false;
  function start(){
    if (active) return;
    active = true;
    document.documentElement.classList.add('hw-on');
    injectStyles();
    decorate();
    critters();
    hero3D();
    hunt();
  }
  function stop(){
    if (!active) return;
    active = false;
    document.documentElement.classList.remove('hw-on');
    while (cleanups.length) { try { cleanups.pop()(); } catch(e){} }
  }

  function toggleButton(){
    var btn = el('button');
    btn.id = 'hw-toggle';
    btn.type = 'button';
    function paint(){
      btn.textContent = active ? '🎃' : '👻';
      btn.classList.toggle('off', !active);
      btn.title = active ? 'Turn off spooky mode' : 'Turn on spooky mode';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    btn.addEventListener('click', function(){
      if (active) { stop(); setPrefOff(true); } else { setPrefOff(false); start(); }
      paint();
      if (window.trackEvent) window.trackEvent('halloween_toggle', { on: active });
    });
    // Toggle needs its own base styles even while effects are off
    var s = document.createElement('style');
    s.textContent = CSS.split('\n').filter(function(r){ return r.indexOf('#hw-toggle') !== -1; }).join('\n');
    document.head.appendChild(s);
    document.body.appendChild(btn);
    paint();
  }

  function init(){
    installCheckoutHooks();
    if (!prefOff()) start();
    toggleButton();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
