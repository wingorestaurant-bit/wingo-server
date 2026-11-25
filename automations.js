// ── AUTOMATIONS ────────────────────────────────────────────────
// Jobs that run by themselves, managed at /automations (admin password):
//
// 1. Win-back emails: customers whose last website order was 30–180 days ago get one email with a
//    discount that comes off by itself on their next online order (matched by email or phone). Off
//    until switched on. Honours every Wing-O unsubscribe; never the same person more than once in 90 days.
// 2. Less manual updating:
//    • Auto wait time: the online "ready in" time follows how busy the kitchen is (Clover orders in
//      the last 20 minutes, all channels). The wait picked in /admin is the minimum.
//    • Clover sold-out sync: when staff mark an item "not available" in Clover, the matching website
//      items are sold out online and on the TVs; when it's available again they come back.
//
// Settings live in Mongo (settings key 'automations'); nothing here changes how an order is placed
// except the win-back discount, which is worked out on the server like the first-order discount.

module.exports = function setupAutomations(ctx) {
  const { app, connectDB, LOCATIONS, isAdmin, alertOwner, escHtml, locTz, SEASON_CLOSED, siteMenu,
    getLiveSettings, customerListCol, wpgSendBatch, WPG_FROM, fetch, ownerEmail, bulkEmailBudget } = ctx;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const round2 = n => Math.round(n * 100) / 100;
  const DAY = 86400000;
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const stores = () => Object.keys(LOCATIONS).filter(l => !SEASON_CLOSED.includes(l));
  const hasClover = l => !!(LOCATIONS[l] && LOCATIONS[l].merchantId && LOCATIONS[l].apiToken);

  // ── settings ──
  const DEFAULTS = {
    wait: { auto: {}, perOrder: 2, max: 60 },
    soldOutSync: {}, cloverMap: {},
    winback: { enabled: false, pct: 10, minSubtotal: 20, inactiveDays: 30, maxInactiveDays: 180, validDays: 14, repeatDays: 90, dailyLimit: 200 },
  };
  let settingsCache = null;
  async function settings(fresh) {
    if (!fresh && settingsCache && Date.now() - settingsCache.at < 30000) return settingsCache.v;
    const database = await connectDB();
    const d = database ? await database.collection('settings').findOne({ key: 'automations' }) : null;
    const v = JSON.parse(JSON.stringify(DEFAULTS));
    if (d) for (const k of Object.keys(DEFAULTS)) if (d[k] && typeof d[k] === 'object') v[k] = Object.assign(v[k], d[k]);
    settingsCache = { at: Date.now(), v };
    return v;
  }
  async function saveSettings(patch) {
    const database = await connectDB();
    const $set = {};
    for (const [k, v] of Object.entries(patch)) $set[k] = v;
    await database.collection('settings').updateOne({ key: 'automations' }, { $set: { key: 'automations', ...$set, updatedAt: new Date() } }, { upsert: true });
    return settings(true);
  }
  // Jobs run once per period even across restarts: remember the last run in settings
  async function onceEvery(name, periodKey) {
    const database = await connectDB(); if (!database) return false;
    const r = await database.collection('settings').updateOne({ key: 'automation_runs', [name]: { $ne: periodKey } },
      { $set: { key: 'automation_runs', [name]: periodKey } }, { upsert: false });
    if (r.modifiedCount) return true;
    const exists = await database.collection('settings').findOne({ key: 'automation_runs' });
    if (!exists) { await database.collection('settings').insertOne({ key: 'automation_runs', [name]: periodKey }); return true; }
    return false;
  }

  // ── Clover ──
  async function clover(loc, pathq) {
    const L = LOCATIONS[loc];
    if (!hasClover(loc)) { const e = new Error('Clover is not connected for this store'); e.status = 0; throw e; }
    const r = await fetch(`https://api.clover.com/v3/merchants/${L.merchantId}${pathq}`, { headers: { Authorization: `Bearer ${L.apiToken}` } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.message || `Clover answered ${r.status}`); e.status = r.status; throw e; }
    return d;
  }
  async function cloverAll(loc, base, maxPages = 80) {
    let out = [];
    for (let page = 0; page < maxPages; page++) {
      const d = await clover(loc, `${base}${base.includes('?') ? '&' : '?'}limit=1000&offset=${page * 1000}`);
      const el = Array.isArray(d.elements) ? d.elements : [];
      out = out.concat(el);
      if (el.length < 1000) break;
      await sleep(150);   // stay well under Clover's rate limit
    }
    return out;
  }
  const filterParam = (field, op, val) => `filter=${encodeURIComponent(field + op + val)}`;

  // ══ AUTO WAIT TIME ═════════════════════════════════════════
  const autoWaits = {};   // loc -> { mins, recent, at }
  async function refreshAutoWaits() {
    const st = await settings();
    const database = await connectDB(); if (!database) return;
    const w = await database.collection('settings').findOne({ key: 'wait_times' });
    for (const loc of stores()) {
      if (!st.wait.auto[loc]) { delete autoWaits[loc]; continue; }
      const base = Number(((w && w.wait) || {})[loc]) || 20;
      let recent = null;
      try {
        if (hasClover(loc)) recent = (await cloverAll(loc, `/orders?${filterParam('createdTime', '>=', Date.now() - 20 * 60e3)}`, 1)).filter(o => Number(o.total) > 0).length;
      } catch (e) { console.warn(`Auto wait ${loc}: Clover not read (${e.message}), using website orders`); }
      if (recent === null) recent = await database.collection('orders').countDocuments({ locationId: loc, createdAt: { $gte: new Date(Date.now() - 20 * 60e3) } });
      const max = Math.max(base, Number(st.wait.max) || 60);
      const mins = Math.min(max, Math.max(base, Math.ceil((base + recent * (Number(st.wait.perOrder) || 2)) / 5) * 5));
      autoWaits[loc] = { mins, recent, base, at: Date.now() };
    }
  }
  const waits = () => { const o = {}; for (const [l, v] of Object.entries(autoWaits)) if (Date.now() - v.at < 10 * 60e3) o[l] = v.mins; return o; };

  // ══ CLOVER SOLD-OUT SYNC ═══════════════════════════════════
  const cloverItemsCache = {};
  async function cloverItems(loc, fresh) {
    const c = cloverItemsCache[loc];
    if (!fresh && c && Date.now() - c.at < 90e3) return c.items;
    const items = (await cloverAll(loc, '/items', 10)).map(i => ({ id: i.id, name: i.name || '', available: i.available !== false, hidden: !!i.hidden }));
    cloverItemsCache[loc] = { at: Date.now(), items };
    return items;
  }
  const syncStatus = {};   // loc -> { at, out: [siteIds], error }
  async function syncSoldOut() {
    const st = await settings();
    const database = await connectDB(); if (!database) return;
    let changed = false;
    for (const loc of stores()) {
      const map = st.cloverMap[loc] || {};
      if (!st.soldOutSync[loc] || !Object.keys(map).length || !hasClover(loc)) continue;
      try {
        const byId = new Map((await cloverItems(loc, true)).map(i => [i.id, i]));
        const doc = await database.collection('settings').findOne({ key: 'sold_out' }) || {};
        const mine = ((doc.clover || {})[loc]) || {};
        const set = {}, unset = {}, out = [];
        for (const [siteId, cloverId] of Object.entries(map)) {
          const it = byId.get(cloverId);
          if (!it) continue;
          if (!it.available) { set[`items.${loc}.${siteId}`] = new Date(); set[`clover.${loc}.${siteId}`] = true; out.push(siteId); }
          else if (mine[siteId]) { unset[`items.${loc}.${siteId}`] = ''; unset[`clover.${loc}.${siteId}`] = ''; }
        }
        if (Object.keys(set).length || Object.keys(unset).length) {
          await database.collection('settings').updateOne({ key: 'sold_out' },
            { ...(Object.keys(set).length ? { $set: { ...set, updatedAt: new Date() } } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
          changed = true;
        }
        syncStatus[loc] = { at: new Date(), out, error: null };
      } catch (e) { syncStatus[loc] = { at: new Date(), out: [], error: e.message }; }
    }
    if (changed) await getLiveSettings(true);
  }
  // Suggest a Clover item for each website item by name
  const norm = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\borders?\b/g, 'order').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !['the', 'a', 'of', 'with'].includes(w));
  // Word overlap; a Clover name whose words all appear in the website name ("Wings" in "Half Order — Wings") counts as likely
  function similarity(a, b) {
    const A = new Set(norm(a)), B = new Set(norm(b)); if (!A.size || !B.size) return 0;
    const numsA = [...A].filter(w => /^\d+$/.test(w)), numsB = [...B].filter(w => /^\d+$/.test(w));
    if (numsA.length && numsB.length && !numsB.every(x => A.has(x))) return 0;   // "Combo for 2" is not "Combo for 1"
    let n = 0; A.forEach(x => { if (B.has(x)) n++; });
    const j = n / (A.size + B.size - n);
    return n === B.size ? Math.max(j, 0.55) : j;
  }
  function siteItems() {
    const M = siteMenu(); const out = [];
    Object.entries(M).forEach(([sec, arr]) => Array.isArray(arr) && arr.forEach(x => { if (x && x.id && x.name) out.push({ id: String(x.id), name: String(x.name), section: sec }); }));
    return out;
  }

  // ══ WIN-BACK EMAILS ═════════════════════════════════════════
  const emailNorm = e => String(e || '').trim().toLowerCase();
  const phoneNorm = p => String(p || '').replace(/\D/g, '').slice(-10);
  function winbackEmail(row, W, test) {
    const unsubUrl = test ? 'https://wingorestaurants.com/' : `https://wingorestaurants.com/api/customers/unsubscribe?t=${row.unsubscribe_token}`;
    const name = String(row.name || '').trim().split(/\s+/)[0];
    const until = new Date(Date.now() + W.validDays * DAY).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', timeZone: 'America/Regina' });
    const orderUrl = `https://wingorestaurants.com/order${row.store ? '?store=' + encodeURIComponent(row.store) : ''}${row.store ? '&' : '?'}utm_source=email&utm_medium=winback`;
    const html = `<div style="background:#F4EBD7;padding:0;margin:0;"><div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#F4EBD7;color:#1A1208;">
      <div style="border-top:4px double #1A1208;border-bottom:1px solid #1A1208;padding:6px 18px;font:12px 'Courier New',monospace;text-transform:uppercase;display:flex;justify-content:space-between;">
        <span>The Sauce Boss Times</span><span>Special Edition</span></div>
      <div style="padding:26px 22px 8px;text-align:center;">
        <div style="font:bold 12px Arial,sans-serif;letter-spacing:4px;color:#E8190A;">EXTRA! EXTRA!</div>
        <h1 style="font-size:40px;line-height:1.05;margin:10px 0 12px;">We miss you${name ? ', ' + escHtml(name) : ''}.</h1>
        <p style="font-size:17px;line-height:1.5;margin:0 0 20px;">It's been a while since your last Wing-O order. Here's a little something to bring you back to the sauce.</p>
        <div style="display:inline-block;border:3px solid #1A1208;background:#fff;padding:16px 26px;box-shadow:8px 8px 0 #E8190A;">
          <div style="font:bold 54px Arial,sans-serif;color:#E8190A;line-height:1;">${W.pct}% OFF</div>
          <div style="font:bold 14px Arial,sans-serif;letter-spacing:2px;margin-top:6px;">YOUR NEXT ONLINE ORDER</div></div>
        <p style="font-size:15px;line-height:1.5;margin:24px 0 6px;">No code needed: it comes off automatically when you order online at <b>wingorestaurants.com</b> with this email or your phone number, by <b>${escHtml(until)}</b>.</p>
        <p style="margin:22px 0;"><a href="${orderUrl}" style="background:#E8190A;color:#fff;text-decoration:none;font:bold 17px Arial,sans-serif;letter-spacing:1px;padding:14px 30px;display:inline-block;">ORDER NOW 🍗</a></p>
        <p style="font:12px Arial,sans-serif;color:#6B5A45;line-height:1.5;">Minimum order $${W.minSubtotal} before tax. One order per customer. Can't be combined with other discounts. Online orders only.</p>
      </div>
      <div style="border-top:1px solid #C8B89A;padding:14px 22px 22px;text-align:center;font:11px Arial,sans-serif;color:#7B6A55;line-height:1.6;">
        Wing-O Restaurants · #3 155 Albert St N, Regina, SK<br>You're getting this because you ordered from Wing-O online.
        <a href="${unsubUrl}" style="color:#7B6A55;">Unsubscribe</a></div></div></div>`;
    return { from: WPG_FROM, to: [row.email], reply_to: ownerEmail, subject: (test ? '[TEST] ' : '') + `${name ? name + ', w' : 'W'}e miss you — ${W.pct}% off your next Wing-O order`,
      html, headers: { 'List-Unsubscribe': `<${unsubUrl}>` } };
  }
  let winbackRunning = false, winbackLast = null;
  async function winbackCandidates(database, W) {
    const now = Date.now();
    const from = new Date(now - W.maxInactiveDays * DAY), to = new Date(now - W.inactiveDays * DAY);
    // Last website order per email, among people who ordered in the window and not since
    const rows = await database.collection('orders').find({ 'customer.email': { $regex: '@' }, createdAt: { $gte: from } },
      { projection: { 'customer.email': 1, 'customer.firstName': 1, 'customer.phone': 1, createdAt: 1, locationId: 1 } }).toArray();
    const last = new Map();
    for (const o of rows) {
      const e = emailNorm(o.customer.email);
      const prev = last.get(e);
      if (!prev || new Date(o.createdAt) > new Date(prev.createdAt)) last.set(e, o);
    }
    const col = await customerListCol(database, true);   // honours every unsubscribe
    const recentSent = new Set((await database.collection('winbacks').find({ sentAt: { $gte: new Date(now - W.repeatDays * DAY) } }, { projection: { email_normalized: 1 } }).toArray()).map(x => x.email_normalized));
    const out = [];
    for (const [e, o] of last) {
      if (new Date(o.createdAt) > to || recentSent.has(e)) continue;
      const row = await col.findOne({ email_normalized: e, unsubscribed: { $ne: true }, unsubscribe_token: { $exists: true } });
      if (!row) continue;
      out.push({ email: row.email, email_normalized: e, name: o.customer.firstName || row.name || '', phone: phoneNorm(o.customer.phone), store: o.locationId, unsubscribe_token: row.unsubscribe_token, lastOrder: o.createdAt });
    }
    return out.sort((a, b) => new Date(b.lastOrder) - new Date(a.lastOrder));
  }
  async function runWinback(reason) {
    if (winbackRunning) return { error: 'Already sending' };
    const W = (await settings(true)).winback;
    if (!process.env.RESEND_API_KEY) return { error: 'Email is not set up (RESEND_API_KEY)' };
    const database = await connectDB(); if (!database) return { error: 'Database unavailable' };
    winbackRunning = true;
    const run = { started: new Date(), reason, sent: 0, failed: 0, error: null };
    winbackLast = run;
    try {
      // Never more than the daily email budget allows: order emails come first (see EMAIL_DAILY_LIMIT in index.js).
      // Whoever doesn't fit today is still eligible tomorrow.
      const budget = bulkEmailBudget ? await bulkEmailBudget() : Infinity;
      run.budget = Number.isFinite(budget) ? budget : null;
      const list = (await winbackCandidates(database, W)).slice(0, Math.min(budget, Math.max(1, Number(W.dailyLimit) || 200)));
      if (!list.length && budget === 0) run.error = 'Daily email budget used up: kept for order emails. Win-back will try again tomorrow.';
      for (let i = 0; i < list.length; i += 100) {
        const batch = list.slice(i, i + 100);
        try {
          await wpgSendBatch(batch.map(r => winbackEmail(r, W, false)));
          await database.collection('winbacks').insertMany(batch.map(r => ({ email_normalized: r.email_normalized, phone: r.phone, name: r.name, store: r.store,
            pct: W.pct, minSubtotal: W.minSubtotal, sentAt: new Date(), expiresAt: new Date(Date.now() + W.validDays * DAY), status: 'sent' })));
          run.sent += batch.length;
        } catch (e) { run.failed += batch.length; run.error = String(e.message).slice(0, 200); }
        await sleep(1100);
      }
    } catch (e) { run.error = String(e.message).slice(0, 200); }
    finally { winbackRunning = false; run.finished = new Date(); }
    console.log(`💌 Win-back emails (${reason}): ${run.sent} sent, ${run.failed} failed`);
    return run;
  }
  // Called while pricing an order: an unexpired win-back offer for this email or phone
  async function winbackDiscount(customer, subtotal) {
    const W = (await settings()).winback;
    const database = await connectDB(); if (!database) return null;
    const e = emailNorm(customer && customer.email), p = phoneNorm(customer && customer.phone);
    const or = []; if (e.includes('@')) or.push({ email_normalized: e }); if (p.length === 10) or.push({ phone: p });
    if (!or.length) return null;
    const offer = await database.collection('winbacks').findOne({ $or: or, status: 'sent', expiresAt: { $gt: new Date() } });
    if (!offer || subtotal < (offer.minSubtotal || W.minSubtotal)) return null;
    const amount = round2(subtotal * (offer.pct || W.pct) / 100);
    return amount > 0 ? { id: offer._id, name: `Welcome Back ${offer.pct || W.pct}% Off`, amount } : null;
  }
  async function winbackRedeemed(id, orderNum, total) {
    const database = await connectDB(); if (!database || !id) return;
    await database.collection('winbacks').updateOne({ _id: id, status: 'sent' }, { $set: { status: 'redeemed', redeemedAt: new Date(), orderNum, orderTotal: total } });
  }
  async function winbackStats(database) {
    const since = new Date(Date.now() - 30 * DAY);
    const [sent, redeemed] = await Promise.all([
      database.collection('winbacks').countDocuments({ sentAt: { $gte: since } }),
      database.collection('winbacks').find({ sentAt: { $gte: since }, status: 'redeemed' }, { projection: { orderTotal: 1 } }).toArray()]);
    return { sent30: sent, redeemed30: redeemed.length, revenue30: round2(redeemed.reduce((s, r) => s + (Number(r.orderTotal) || 0), 0)) };
  }

  // ══ SCHEDULER ══════════════════════════════════════════════════
  function reginaNow() {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Regina', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), min: Number(p.minute), dow: DAYS.indexOf(p.weekday) };
  }
  async function tick() {
    try {
      const n = reginaNow(), st = await settings();
      // Win-back emails once a day at 11 AM, if switched on
      if (st.winback.enabled && n.hour === 11 && await onceEvery('winback', n.date)) await runWinback('daily');
    } catch (e) { console.warn('Automation tick failed:', e.message); }
  }
  setInterval(tick, 5 * 60e3); setTimeout(tick, 30e3);
  setInterval(() => refreshAutoWaits().catch(e => console.warn('Auto wait:', e.message)), 2 * 60e3);
  setInterval(() => syncSoldOut().catch(e => console.warn('Sold-out sync:', e.message)), 2 * 60e3);
  setTimeout(() => { refreshAutoWaits().catch(() => {}); syncSoldOut().catch(() => {}); }, 15e3);

  // ══ ADMIN API (/automations page) ══════════════════════════════
  const guard = (req, res) => { if (!isAdmin((req.body || {}).password)) { res.status(401).json({ error: 'Wrong password' }); return false; } return true; };
  app.get('/automations', (req, res) => res.sendFile(require('path').join(__dirname, 'public', 'automations.html')));

  app.post('/api/auto/state', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const database = await connectDB();
      const st = await settings(true);
      const w = await database.collection('settings').findOne({ key: 'wait_times' });
      res.json({
        settings: st,
        stores: stores().map(l => ({ id: l, name: LOCATIONS[l].name, clover: hasClover(l), manualWait: Number(((w && w.wait) || {})[l]) || 20,
          autoWait: autoWaits[l] || null, sync: syncStatus[l] || null })),
        siteItems: siteItems(),
        winback: { ...(await winbackStats(database)), running: winbackRunning, last: winbackLast, emailReady: !!process.env.RESEND_API_KEY },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/auto/settings', async (req, res) => {
    if (!guard(req, res)) return;
    const b = (req.body || {}).patch || {}; const cur = await settings(true); const patch = {};
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    const bools = (o, keys) => { const r = {}; keys.forEach(k => { if (typeof (o || {})[k] === 'boolean') r[k] = o[k]; }); return r; };
    if (b.wait) patch.wait = { auto: { ...cur.wait.auto, ...bools(b.wait.auto, stores()) }, perOrder: num(b.wait.perOrder, 1, 10, cur.wait.perOrder), max: num(b.wait.max, 20, 120, cur.wait.max) };
    if (b.soldOutSync) patch.soldOutSync = { ...cur.soldOutSync, ...bools(b.soldOutSync, stores()) };
    if (b.cloverMap && LOCATIONS[b.cloverMap.loc]) {
      const ids = new Set(siteItems().map(i => i.id)); const m = {};
      Object.entries(b.cloverMap.map || {}).forEach(([k, v]) => { if (ids.has(k) && /^[A-Z0-9]{8,20}$/i.test(String(v))) m[k] = String(v); });
      patch.cloverMap = { ...cur.cloverMap, [b.cloverMap.loc]: m };
    }
    if (b.winback) {
      const W = cur.winback;
      patch.winback = { enabled: typeof b.winback.enabled === 'boolean' ? b.winback.enabled : W.enabled, pct: num(b.winback.pct, 5, 50, W.pct),
        minSubtotal: num(b.winback.minSubtotal, 0, 200, W.minSubtotal), inactiveDays: num(b.winback.inactiveDays, 14, 180, W.inactiveDays),
        maxInactiveDays: num(b.winback.maxInactiveDays, 30, 720, W.maxInactiveDays), validDays: num(b.winback.validDays, 3, 60, W.validDays),
        repeatDays: num(b.winback.repeatDays, 30, 365, W.repeatDays), dailyLimit: num(b.winback.dailyLimit, 1, 1000, W.dailyLimit) };
      if (patch.winback.maxInactiveDays <= patch.winback.inactiveDays) patch.winback.maxInactiveDays = patch.winback.inactiveDays + 30;
    }
    const v = await saveSettings(patch);
    if (patch.wait) refreshAutoWaits().catch(() => {});
    if (patch.soldOutSync || patch.cloverMap) syncSoldOut().catch(() => {});
    res.json({ settings: v });
  });

  app.post('/api/auto/clover-items', async (req, res) => {
    if (!guard(req, res)) return;
    const loc = String((req.body || {}).loc || '');
    if (!LOCATIONS[loc]) return res.status(400).json({ error: 'Unknown store' });
    try {
      const items = (await cloverItems(loc, true)).filter(i => !i.hidden).sort((a, b) => a.name.localeCompare(b.name));
      const suggest = {};
      siteItems().forEach(s => {
        let best = null, score = 0;
        items.forEach(c => { const sc = Math.max(similarity(s.name, c.name), similarity(s.name.split(' — ')[0] + ' ' + s.section, c.name)); if (sc > score) { score = sc; best = c; } });
        if (best && score >= 0.5) suggest[s.id] = best.id;
      });
      res.json({ items, suggest });
    } catch (e) { res.status(400).json({ error: e.status === 401 || e.status === 403 ? 'Clover didn\'t allow reading items. Check the Clover token has Inventory "read" permission.' : e.message }); }
  });

  app.post('/api/auto/winback/preview', async (req, res) => {
    if (!guard(req, res)) return;
    const W = (await settings(true)).winback;
    res.json({ html: winbackEmail({ email: 'x@example.com', name: 'Alex', store: 'albert-st', unsubscribe_token: '' }, W, true).html, subject: winbackEmail({ name: 'Alex' }, W, true).subject });
  });
  app.post('/api/auto/winback/count', async (req, res) => {
    if (!guard(req, res)) return;
    try { const database = await connectDB(); const W = (await settings(true)).winback; res.json({ eligible: (await winbackCandidates(database, W)).length }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/auto/winback/test', async (req, res) => {
    if (!guard(req, res)) return;
    const email = String((req.body || {}).email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email is not set up (RESEND_API_KEY).' });
    try { await wpgSendBatch([winbackEmail({ email, name: '', store: 'albert-st', unsubscribe_token: '' }, (await settings(true)).winback, true)], { test: true }); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: String(e.message).slice(0, 200) }); }
  });
  app.post('/api/auto/winback/run', async (req, res) => {
    if (!guard(req, res)) return;
    if ((req.body || {}).confirm !== 'SEND') return res.status(400).json({ error: 'Not confirmed.' });
    res.json(await runWinback('manual'));
  });

  return { waits, winbackDiscount, winbackRedeemed, _test: { refreshAutoWaits, syncSoldOut, runWinback, winbackCandidates, similarity, tick } };
};
