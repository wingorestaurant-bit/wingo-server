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
    '#ios-guide .sheet{background:#F4EBD7;color:#1A1208;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px 20px calc(22px + env(safe-area-inset-bottom));font-family:Arial,sans-serif;box-shadow:0 -10px 40px rgba(0,0,0,.4);animation:iosup .25s ease;}' +
    '@keyframes iosup{from{transform:translateY(100%);}to{transform:none;}}' +
    '#ios-guide h3{font:900 22px Georgia,serif;margin:0 0 4px;}' +
    '#ios-guide .sub{color:#5A4A35;font-size:14px;margin-bottom:14px;}' +
    '#ios-guide ol{list-style:none;margin:0;padding:0;}' +
    '#ios-guide li{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px dashed #C8B89A;font-size:15px;line-height:1.4;}' +
    '#ios-guide li b.n{flex:none;width:26px;height:26px;border-radius:50%;background:#E8190A;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;}' +
    '#ios-guide .ico{display:inline-block;vertical-align:-4px;margin:0 2px;}' +
    '#ios-guide button.ok{margin-top:14px;width:100%;background:#1A1208;color:#fff;border:0;border-radius:8px;padding:13px;font:700 15px Arial,sans-serif;letter-spacing:1px;}';
  document.head.appendChild(css);
  var SHARE = '<svg class="ico" width="18" height="22" viewBox="0 0 18 22" aria-label="Share"><path d="M9 1v13M4.5 5.5L9 1l4.5 4.5" fill="none" stroke="#1F6FEB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 9H3.5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 3.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 14.5 9H12" fill="none" stroke="#1F6FEB" stroke-width="2" stroke-linecap="round"/></svg>';
  var ADD = '<svg class="ico" width="20" height="20" viewBox="0 0 20 20" aria-label="Add"><rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="none" stroke="#1A1208" stroke-width="1.8"/><path d="M10 6v8M6 10h8" stroke="#1A1208" stroke-width="1.8" stroke-linecap="round"/></svg>';
  function step(n, html) { return '<li><b class="n">' + n + '</b><span>' + html + '</span></li>'; }
  function guide() {
    if (document.getElementById('ios-guide')) return;
    var steps = '', n = 1;
    if (tooOld) steps += step(n++, 'Update your iPhone first: <b>Settings → General → Software Update</b> (alerts need iOS 16.4 or newer).');
    if (inApp) steps += step(n++, 'You\'re inside another app\'s browser. Tap <b>•••</b> (top right) and choose <b>Open in browser</b> / <b>Open in Safari</b>.');
    steps += step(n++, 'Tap the <b>Share</b> button ' + SHARE + ' in Safari\'s toolbar.');
    steps += step(n++, 'Scroll down and tap <b>Add to Home Screen</b> ' + ADD + ', then <b>Add</b>.');
    steps += step(n++, 'Open <b>Wing-O</b> from your Home Screen and tap <b>Enable</b>. That\'s it: deals land on your phone. 🍗');
    var d = document.createElement('div'); d.id = 'ios-guide';
    d.innerHTML = '<div class="sheet" role="dialog" aria-label="Get deal alerts on iPhone"><h3>🔔 Deal alerts on iPhone</h3>' +
      '<div class="sub">iPhones send alerts to apps on your Home Screen, so add Wing-O there first. It takes 10 seconds and it\'s free.</div>' +
      '<ol>' + steps + '</ol><button class="ok" type="button">GOT IT</button></div>';
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
