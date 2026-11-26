// Deal alerts on iPhone / iPad.
// iOS only allows web notifications for sites added to the Home Screen (iOS 16.4+). In Safari itself
// there is no PushManager at all, so "Enable" used to say "Your browser does not support notifications".
// Now, on iOS:
//  • In Safari (or inside Instagram / Facebook): "Enable" opens a short guide to add Wing-O to the
//    Home Screen (or to open the page in Safari first, or to update iOS).
//  • Opened from the Home Screen: the "Get deal alerts" banner shows by itself, and Enable subscribes
//    exactly like on Android (same server, Apple's push service is handled by web-push).
(function () {
  'use strict';
  var ua = navigator.userAgent || '';
  var isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  var inApp = /Instagram|FBAN|FBAV|FB_IAB|Snapchat|TikTok|musical_ly|Line\//i.test(ua);
  var m = /OS (\d+)_(\d+)/.exec(ua), ver = m ? Number(m[1]) + Number(m[2]) / 100 : 99;
  var tooOld = ver < 16.04;
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function banner() { return document.getElementById('notif-banner'); }
  // On iPhone the alerts banner is the Sauce Boss asking
  function bossBanner() {
    var bn = banner(); if (!bn || bn.getAttribute('data-boss')) return;
    bn.setAttribute('data-boss', '1');
    var divs = bn.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      if (divs[i].textContent.trim() === 'GET DEAL ALERTS') divs[i].textContent = 'THE SAUCE BOSS WANTS YOU IN';
      else if (/^Daily deals/i.test(divs[i].textContent.trim())) divs[i].textContent = 'Deals & free wings on your phone';
    }
    var icon = bn.firstElementChild;
    if (icon && /🔔/.test(icon.textContent)) icon.innerHTML = '<img src="/images/sauce-boss-avatar.png" alt="" style="width:40px;height:40px;border-radius:50%;border:2px solid #E8190A;background:#fff;display:block;">';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bossBanner); else bossBanner();

  // ── Opened from the Home Screen: alerts work, so ask (the tap on "Enable" is the gesture iOS needs) ──
  if (standalone) {
    if ('Notification' in window && Notification.permission === 'default' && Date.now() - Number(store('wingo_ios_alert_ask') || 0) > 3 * 86400e3) {
      setTimeout(function () { var b = banner(); if (b) { b.style.display = 'flex'; store('wingo_ios_alert_ask', String(Date.now())); } }, 2500);
    }
    return;
  }

  // ── In Safari: "Enable" explains how to get the alerts ──
  var css = document.createElement('style');
  css.textContent =
    '#ios-guide{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center;}' +
    '#ios-guide .sheet{background:#F4EBD7;color:#1A1208;width:100%;max-width:480px;border-radius:18px 18px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));font-family:Arial,sans-serif;box-shadow:0 -10px 40px rgba(0,0,0,.4);animation:iosup .25s ease;}' +
    '@keyframes iosup{from{transform:translateY(100%);}to{transform:none;}}' +
    '#ios-guide .boss{display:flex;gap:12px;align-items:center;}' +
    '#ios-guide .boss img{width:64px;height:64px;border-radius:50%;border:3px solid #E8190A;background:#fff;flex:none;object-fit:cover;}' +
    '#ios-guide .bubble{background:#fff;border:2px solid #1A1208;border-radius:14px;padding:9px 12px;position:relative;font-size:15px;line-height:1.35;}' +
    '#ios-guide .bubble:before{content:"";position:absolute;left:-9px;top:20px;border:8px solid transparent;border-right-color:#1A1208;border-left:0;}' +
    '#ios-guide .bubble b{display:block;font:900 19px Georgia,serif;margin-bottom:2px;}' +
    '#ios-guide .first{margin-top:12px;background:#1A1208;color:#FFD23F;border-radius:8px;padding:8px 10px;font-size:14px;font-weight:700;text-align:center;}' +
    '#ios-guide .tiles{display:flex;align-items:center;gap:8px;margin-top:14px;}' +
    '#ios-guide .tile{flex:1;background:#fff;border:2px solid #1A1208;border-radius:12px;padding:12px 6px 10px;text-align:center;font-size:14px;font-weight:700;box-shadow:3px 3px 0 #E8190A;}' +
    '#ios-guide .tile svg{display:block;margin:0 auto 6px;}' +
    '#ios-guide .tile small{display:block;font-weight:400;color:#7B6A55;font-size:11px;margin-top:3px;}' +
    '#ios-guide .to{font-size:22px;font-weight:900;color:#E8190A;}' +
    '#ios-guide .then{text-align:center;font-size:14px;margin-top:12px;color:#3A2C1A;}' +
    '#ios-guide button.ok{margin-top:12px;width:100%;background:#E8190A;color:#fff;border:0;border-radius:10px;padding:14px;font:700 16px Arial,sans-serif;letter-spacing:1.5px;box-shadow:0 3px 0 #A8120A;}';
  document.head.appendChild(css);
  var SHARE = '<svg width="30" height="36" viewBox="0 0 18 22" aria-hidden="true"><path d="M9 1v13M4.5 5.5L9 1l4.5 4.5" fill="none" stroke="#1F6FEB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9H3.5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 3.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 14.5 9H12" fill="none" stroke="#1F6FEB" stroke-width="2" stroke-linecap="round"/></svg>';
  var ADD = '<svg width="34" height="34" viewBox="0 0 20 20" aria-hidden="true"><rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="none" stroke="#1A1208" stroke-width="1.8"/><path d="M10 6v8M6 10h8" stroke="#1A1208" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function guide() {
    if (document.getElementById('ios-guide')) return;
    // Only one thing to fix first, if anything: an in-app browser or an old iPhone
    var first = inApp ? 'First: tap ••• and choose “Open in Safari”' : tooOld ? 'First: update your iPhone (Settings → General → Software Update)' : '';
    var d = document.createElement('div'); d.id = 'ios-guide';
    d.innerHTML = '<div class="sheet" role="dialog" aria-label="The Sauce Boss wants you on the list">' +
      '<div class="boss"><img src="/images/sauce-boss-avatar.png" alt="Sauce Boss"><div class="bubble"><b>The Sauce Boss wants you on the list.</b>Deals, free wings & new flavours, straight to your phone. 🍗</div></div>' +
      (first ? '<div class="first">' + first + '</div>' : '') +
      '<div class="tiles"><div class="tile">' + SHARE + 'Tap Share<small>or ••• then Share</small></div><div class="to">→</div>' +
        '<div class="tile">' + ADD + 'Add to Home Screen</div></div>' +
      '<div class="then">Then open <b>Wing-O</b> from your Home Screen and tap <b>Enable</b>.</div>' +
      '<button class="ok" type="button">OK, BOSS 👊</button></div>';
    d.addEventListener('click', function (e) { if (e.target === d || e.target.classList.contains('ok')) d.remove(); });
    document.body.appendChild(d);
  }
  // Every "Enable" button on the page calls enableNotifications(): outside the Home Screen app iOS won't
  // subscribe (even where a Safari tab reports push support), so show the guide instead
  window.enableNotifications = function () {
    var b = banner(); if (b) b.style.display = 'none';
    guide();
  };
  window.wingoIosAlertGuide = guide;

  // Nudge iPhone visitors once every 2 weeks, since the Android-only install prompt never shows on iOS
  if (Date.now() - Number(store('wingo_ios_nudge') || 0) > 14 * 86400e3) {
    setTimeout(function () {
      var b = banner(); if (!b || b.style.display === 'flex') return;
      b.style.display = 'flex'; store('wingo_ios_nudge', String(Date.now()));
    }, 25000);
  }
})();
