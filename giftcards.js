// ── GIFT CARDS ─────────────────────────────────────────────────
// Digital Wing-O gift cards, good at every store and online.
//
//   /gift-cards            buy a card (paid by card through Clover Ecommerce, Albert St keys), check a balance
//   /gift-cards/card?c=…   the recipient's card, with a QR code for the counter
//   /gift-card-pos         staff: look up a card and take an amount off it (kitchen password of the store)
//   /gift-cards-admin      owner: sales, outstanding balance, Christmas bonus settings, issue/resend/void cards
//
// Money: card balances are in cents. Every change is a row in giftcard_txns, so a card's history adds up.
// A purchased card never expires and has no fees. A bonus card (the "buy $50, get $10" promo) has its
// own dates. Selling a card charges the card (POST /v1/charges); it is not a food sale, so no Clover order.
// Online: a code at checkout takes min(balance, order total) off; the rest is paid at pickup. Staff ring
// the gift card part on the Clover POS with the Gift Card payment option (the ticket says how much).

module.exports = function setupGiftCards(ctx) {
  const { app, connectDB, LOCATIONS, isAdmin, checkKitchenAuth, sendEmail, alertOwner, escHtml, payReady, CLOVER_ECOMM, clientIp, fetch, ownerEmail } = ctx;
  const path = require('path'), crypto = require('crypto');
  const money = c => '$' + (Math.round(c) / 100).toFixed(2);
  const SELL_STORE = 'albert-st';   // whose Clover Ecommerce keys take the payment
  const SITE = 'https://wingorestaurants.com';

  // ── codes ──
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0/I/1
  function newCode() {
    const b = crypto.randomBytes(12); let s = '';
    for (let i = 0; i < 12; i++) s += ALPHA[b[i] % ALPHA.length];
    return `WGO-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
  function normCode(c) {
    let s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.startsWith('WGO')) s = s.slice(3);
    if (s.length !== 12 || /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/.test(s)) return null;
    return `WGO-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
  const mask = code => code ? '•••• ' + code.slice(-4) : '';

  // ── settings (Christmas bonus) ──
  const DEFAULTS = { promo: { enabled: true, every: 5000, bonus: 1000, endsAt: '2026-12-31', validFrom: '2027-01-01', validTo: '2027-03-31' }, sales: true };
  async function settings() {
    const db = await connectDB();
    const d = db ? await db.collection('settings').findOne({ key: 'giftcards' }) : null;
    return { promo: { ...DEFAULTS.promo, ...((d && d.promo) || {}) }, sales: d && typeof d.sales === 'boolean' ? d.sales : DEFAULTS.sales };
  }
  // A date string means that whole day in Regina (UTC−6, no daylight saving)
  const dayStart = d => new Date(d + 'T00:00:00-06:00'), dayEnd = d => new Date(d + 'T23:59:59-06:00');
  const fmtDay = d => new Date(d).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Regina' });
  const promoActive = p => p.enabled && Date.now() <= dayEnd(p.endsAt).getTime();
  const bonusFor = (p, cents) => promoActive(p) ? Math.floor(cents / p.every) * p.bonus : 0;
  function cardUsableNow(card) {
    if (card.status !== 'active') return 'This gift card has been cancelled.';
    if (card.validFrom && Date.now() < new Date(card.validFrom).getTime()) return `This bonus card can be used from ${fmtDay(card.validFrom)}.`;
    if (card.expiresAt && Date.now() > new Date(card.expiresAt).getTime()) return `This bonus card expired on ${fmtDay(card.expiresAt)}.`;
    return null;
  }
  const publicCard = c => ({ code: c.code, balance: c.balance, initial: c.initial, kind: c.kind, validFrom: c.validFrom || null, expiresAt: c.expiresAt || null,
    status: c.status, to: (c.recipient && c.recipient.name) || '', from: (c.buyer && c.buyer.name) || '', usable: !cardUsableNow(c), why: cardUsableNow(c) });

  let indexed = false;
  async function cols() {
    const db = await connectDB(); if (!db) throw new Error('Database unavailable');
    const cards = db.collection('giftcards'), txns = db.collection('giftcard_txns');
    if (!indexed) { try { await cards.createIndex({ code: 1 }, { unique: true }); await txns.createIndex({ code: 1, at: -1 }); } catch (e) {} indexed = true; }
    return { db, cards, txns };
  }
  async function createCard(fields) {
    const { cards, txns } = await cols();
    for (let i = 0; i < 5; i++) {
      const card = { code: newCode(), status: 'active', createdAt: new Date(), sentAt: null, ...fields, balance: fields.initial };
      try {
        await cards.insertOne(card);
        await txns.insertOne({ code: card.code, type: fields.kind === 'bonus' ? 'bonus-issue' : fields.kind === 'comp' ? 'comp-issue' : 'purchase', amount: card.initial, balanceAfter: card.initial, at: new Date(), ref: fields.purchaseId || null });
        return card;
      } catch (e) { if (!/duplicate|E11000/i.test(e.message)) throw e; }
    }
    throw new Error('Could not create a unique code');
  }
  // Take up to `cents` off a card in one step (never below zero). Returns the amount actually taken.
  async function debit(code, cents, meta) {
    const { cards, txns } = await cols();
    const card = await cards.findOne({ code });
    if (!card) return { error: 'We couldn\'t find that gift card. Check the code.' };
    const why = cardUsableNow(card); if (why) return { error: why };
    const take = Math.min(Math.max(0, Math.round(cents)), card.balance);
    if (take <= 0) return { error: 'This gift card has no balance left.' };
    const r = await cards.updateOne({ code, balance: { $gte: take }, status: 'active' }, { $inc: { balance: -take }, $set: { lastUsedAt: new Date() } });
    if (!r.modifiedCount) return { error: 'The balance just changed. Please try again.' };
    const after = card.balance - take;
    const t = { code, type: meta.type, amount: -take, balanceAfter: after, at: new Date(), store: meta.store || null, orderNum: meta.orderNum || null, note: meta.note || null };
    const ins = await txns.insertOne(t);
    return { taken: take, balance: after, txnId: ins.insertedId };
  }

  // ── emails ──
  const shell = (edition, inner) => `<div style="background:#F4EBD7;margin:0;padding:0;"><div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#F4EBD7;color:#1A1208;">
    <div style="border-top:4px double #1A1208;border-bottom:1px solid #1A1208;padding:6px 18px;font:12px 'Courier New',monospace;text-transform:uppercase;">The Sauce Boss Times · ${edition}</div>
    ${inner}
    <div style="border-top:1px solid #C8B89A;padding:14px 22px 22px;text-align:center;font:11px Arial,sans-serif;color:#7B6A55;line-height:1.6;">Wing-O Restaurants · #3 155 Albert St N, Regina, SK · wingorestaurants.com</div></div></div>`;
  const howTo = card => `<div style="font:14px/1.55 Arial,sans-serif;text-align:left;background:#fff;border:1px solid #C8B89A;padding:14px 18px;margin:18px 0 0;">
    <b>How to use it</b><br>• <b>Online:</b> enter the code at checkout on wingorestaurants.com.<br>• <b>In the store:</b> show this email (or the QR code) at the counter.<br>
    Good at every Wing-O: Albert St and East Regina in Regina, and Dakota St in Winnipeg.<br>
    ${card.kind === 'bonus' ? `<b>Bonus card:</b> use it from ${fmtDay(card.validFrom)} to ${fmtDay(card.expiresAt)}.` : '<b>No expiry date. No fees.</b>'}</div>`;
  function cardEmail(card) {
    const to = card.recipient || {}, from = card.buyer || {};
    const view = `${SITE}/gift-cards/card?c=${encodeURIComponent(card.code)}`;
    const html = shell(card.kind === 'bonus' ? 'Bonus Edition' : 'Holiday Edition', `<div style="padding:26px 22px 22px;text-align:center;">
      <div style="font:bold 12px Arial,sans-serif;letter-spacing:4px;color:#E8190A;">EXTRA! EXTRA!</div>
      <h1 style="font-size:38px;line-height:1.05;margin:10px 0 10px;">${card.kind === 'bonus' ? 'Your bonus card is here' : `You've got wings${to.name ? ', ' + escHtml(to.name.split(' ')[0]) : ''}!`}</h1>
      ${card.kind !== 'bonus' && from.name ? `<p style="font-size:17px;margin:0 0 12px;">A Wing-O gift card from <b>${escHtml(from.name)}</b></p>` : ''}
      ${card.message ? `<p style="font-size:17px;font-style:italic;line-height:1.5;margin:0 0 18px;">“${escHtml(card.message)}”</p>` : ''}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:8px auto 10px;border:3px solid #1A1208;border-radius:14px;border-collapse:separate;overflow:hidden;background:#140A05;">
        <tr><td style="padding:0;line-height:0;"><img src="${SITE}/images/email-wings-wide.jpg" width="474" alt="Wing-O wings" style="display:block;width:100%;height:auto;border:0;"></td></tr>
        <tr><td style="background:#E8190A;height:12px;line-height:12px;font-size:0;border-top:2px solid #A8120A;border-bottom:2px solid #A8120A;">&nbsp;</td></tr>
        <tr><td style="padding:18px 22px 20px;text-align:left;background:#140A05;">
          <div style="font:bold 12px Arial,sans-serif;letter-spacing:3px;color:#F5C044;">${card.kind === 'bonus' ? '★ BONUS CARD' : '🎄 HOLIDAY EDITION'}</div>
          <div style="font:bold 60px Arial,sans-serif;color:#FFF6E2;line-height:1.05;margin-top:4px;text-shadow:3px 3px 0 #E8190A;">${money(card.initial).replace('.00', '')}</div>
          <div style="font:bold 13px Arial,sans-serif;letter-spacing:4px;color:#F5C044;margin-top:4px;">WING-O ${card.kind === 'bonus' ? 'BONUS ' : ''}GIFT CARD</div>
          <div style="margin-top:16px;background:#F4EBD7;color:#1A1208;font:bold 21px 'Courier New',monospace;letter-spacing:2px;padding:11px 8px;text-align:center;border-radius:6px;">${card.code}</div>
        </td></tr></table>
      <p style="margin:22px 0 4px;"><a href="${view}" style="background:#E8190A;color:#fff;text-decoration:none;font:bold 16px Arial,sans-serif;letter-spacing:1px;padding:13px 26px;display:inline-block;">SHOW MY CARD &amp; QR CODE</a></p>
      <p style="margin:12px 0 0;"><a href="${SITE}/order?utm_source=giftcard&utm_medium=email" style="color:#E8190A;font:bold 14px Arial,sans-serif;">Order online now →</a></p>
      ${howTo(card)}</div>`);
    return { to: to.email, subject: card.kind === 'bonus' ? `🎁 Your ${money(card.initial)} Wing-O bonus card` : `🎁 ${from.name ? escHtml(from.name) + ' sent you' : 'You got'} a ${money(card.initial)} Wing-O gift card`, html };
  }
  function receiptEmail(p, card, bonus) {
    const when = card.deliverAt && new Date(card.deliverAt) > new Date() ? `on ${new Date(card.deliverAt).toLocaleString('en-CA', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Regina' })} (Regina time)` : 'right away';
    const html = shell('Receipt', `<div style="padding:24px 22px;">
      <h1 style="font-size:30px;margin:0 0 12px;">Thanks for the gift!</h1>
      <p style="font:15px/1.6 Arial,sans-serif;margin:0 0 12px;">You bought a <b>${money(card.initial)} Wing-O gift card</b> for <b>${escHtml(card.recipient.name || card.recipient.email)}</b> (${escHtml(card.recipient.email)}). We'll email it ${when}.</p>
      <table style="font:14px Arial,sans-serif;width:100%;border-collapse:collapse;background:#fff;border:1px solid #C8B89A;">
        <tr><td style="padding:8px 12px;color:#7B6A55;">Gift card</td><td style="padding:8px 12px;text-align:right;">${mask(card.code)}</td></tr>
        <tr><td style="padding:8px 12px;color:#7B6A55;">Charged</td><td style="padding:8px 12px;text-align:right;"><b>${money(p.amount)}</b>${p.last4 ? ` · ${escHtml(p.brand || 'card')} ••${escHtml(p.last4)}` : ''}</td></tr>
        <tr><td style="padding:8px 12px;color:#7B6A55;">Reference</td><td style="padding:8px 12px;text-align:right;">${escHtml(p.ref)}</td></tr></table>
      ${bonus ? `<div style="margin-top:18px;border:3px solid #1A1208;background:#fff;padding:16px 18px;box-shadow:6px 6px 0 #E8190A;text-align:center;">
        <div style="font:bold 12px Arial,sans-serif;letter-spacing:3px;color:#E8190A;">CHRISTMAS BONUS · FOR YOU</div>
        <div style="font:bold 40px Arial,sans-serif;color:#E8190A;margin:6px 0;">${money(bonus.initial)}</div>
        <div style="font:bold 20px 'Courier New',monospace;letter-spacing:2px;">${bonus.code}</div>
        <p style="font:13px Arial,sans-serif;margin:8px 0 0;">Use it from ${fmtDay(bonus.validFrom)} to ${fmtDay(bonus.expiresAt)}, online or in any Wing-O. <a href="${SITE}/gift-cards/card?c=${encodeURIComponent(bonus.code)}" style="color:#E8190A;">Show the QR code</a></p></div>` : ''}
      <p style="font:13px Arial,sans-serif;color:#7B6A55;margin-top:16px;">Questions? Reply to this email or call 639-997-0553.</p></div>`);
    return { to: p.buyerEmail, subject: `🧾 Your Wing-O gift card receipt (${money(p.amount)})`, html };
  }
  async function deliver(card) {
    const e = cardEmail(card);
    const ok = await sendEmail({ to: e.to, subject: e.subject, html: e.html, replyTo: ownerEmail });
    const { cards } = await cols();
    await cards.updateOne({ code: card.code }, { $set: { sentAt: new Date(), sendError: ok === false ? 'send failed' : null } });
  }
  // Scheduled cards (e.g. Christmas morning) go out when due
  async function deliverDue() {
    try {
      const { cards } = await cols();
      const due = await cards.find({ status: 'active', sentAt: null, deliverAt: { $lte: new Date() }, 'recipient.email': { $regex: '@' } }).limit(50).toArray();
      for (const c of due) await deliver(c);
      if (due.length) console.log(`🎁 Delivered ${due.length} scheduled gift card email(s)`);
    } catch (e) { console.warn('Gift card delivery:', e.message); }
  }
  setInterval(deliverDue, 2 * 60e3);

  // ── charge a card through Clover Ecommerce ──
  async function charge(cents, token, email, ip, description) {
    const loc = LOCATIONS[SELL_STORE];
    let r, d;
    try {
      r = await fetch(`${CLOVER_ECOMM.api}/v1/charges`, { method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${loc.cloverPrivateKey}`, 'idempotency-key': crypto.randomUUID(), ...(ip ? { 'x-forwarded-for': ip } : {}) },
        body: JSON.stringify({ amount: cents, currency: 'cad', source: token, ecomind: 'ecom', description, ...(email ? { receipt_email: email } : {}) }) });
      d = await r.json().catch(() => ({}));
    } catch (e) { return { ok: false, unknown: true, message: e.message }; }
    if (r.ok && (d.paid === true || d.status === 'succeeded')) { const s = d.source || {}; return { ok: true, id: d.id, amount: Number(d.amount) || cents, brand: s.brand || '', last4: s.last4 || '' }; }
    const err = d.error || {}; const message = err.message || d.message || `Clover answered ${r.status}`;
    console.warn(`🎁 Gift card charge not taken (${r.status}): ${JSON.stringify(d).slice(0, 300)}`);
    return { ok: false, unknown: r.status >= 500, message, declined: r.status === 402 || err.type === 'card_error' || /declin/i.test(message) };
  }

  // ── rate limit for public lookups ──
  const hits = new Map();
  function limited(req, max = 20) {
    const k = clientIp(req) || 'x', now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < 10 * 60e3);
    arr.push(now); hits.set(k, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length > max;
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // ══ PUBLIC ═══════════════════════════════════════════════════
  const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
  app.get('/gift-cards', page('gift-cards.html'));
  app.get('/gift-cards/card', page('gift-card.html'));
  app.get('/gift-card-pos', page('gift-card-pos.html'));
  app.get('/gift-cards-admin', page('gift-cards-admin.html'));

  app.get('/api/giftcards/config', async (req, res) => {
    const s = await settings(); const loc = LOCATIONS[SELL_STORE];
    res.set('Cache-Control', 'no-store').json({
      sales: s.sales && payReady(loc),
      pay: payReady(loc) ? { publicKey: loc.cloverPublicKey, merchantId: loc.merchantId, sdk: CLOVER_ECOMM.sdk } : null,
      promo: promoActive(s.promo) ? { every: s.promo.every, bonus: s.promo.bonus, endsAt: s.promo.endsAt, validFrom: s.promo.validFrom, validTo: s.promo.validTo } : null,
      christmas: Date.now() < dayStart('2026-12-25').getTime() + 8 * 3600e3 ? '2026-12-25T08:00:00-06:00' : null,
    });
  });

  app.post('/api/giftcards/balance', async (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
    const code = normCode((req.body || {}).code);
    if (!code) return res.status(400).json({ error: 'That doesn\'t look like a Wing-O gift card code (WGO-XXXX-XXXX-XXXX).' });
    try {
      const { cards } = await cols();
      const c = await cards.findOne({ code });
      if (!c) return res.status(404).json({ error: 'We couldn\'t find that gift card. Check the code.' });
      res.json({ card: publicCard(c) });
    } catch (e) { res.status(500).json({ error: 'Please try again.' }); }
  });

  app.post('/api/giftcards/buy', async (req, res) => {
    if (limited(req, 10)) return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
    const b = req.body || {}; const s = await settings(); const loc = LOCATIONS[SELL_STORE];
    if (!s.sales || !payReady(loc)) return res.status(503).json({ error: 'Gift card sales are paused right now. Please try again later or call 639-997-0553.' });
    const cents = Math.round(Number(b.amount) * 100);
    if (!(cents >= 1000 && cents <= 50000) || cents % 100) return res.status(400).json({ error: 'Pick an amount from $10 to $500, in whole dollars.' });
    const buyer = { name: String(b.buyerName || '').trim().slice(0, 60), email: String(b.buyerEmail || '').trim().slice(0, 120) };
    const toSelf = !!b.toSelf;
    const recipient = toSelf ? { ...buyer } : { name: String(b.recipientName || '').trim().slice(0, 60), email: String(b.recipientEmail || '').trim().slice(0, 120) };
    if (!buyer.name || !EMAIL_RE.test(buyer.email)) return res.status(400).json({ error: 'Please enter your name and email.' });
    if (!EMAIL_RE.test(recipient.email)) return res.status(400).json({ error: 'Please enter the email address to send the gift card to.' });
    const message = String(b.message || '').trim().slice(0, 300);
    let deliverAt = new Date();
    if (b.deliverAt) { const d = new Date(b.deliverAt); if (!isNaN(d) && d > new Date() && d < new Date(Date.now() + 90 * 86400e3)) deliverAt = d; }
    const token = typeof b.token === 'string' ? b.token.trim() : '';
    if (!token) return res.status(400).json({ error: 'Please enter your card details.' });

    const purchaseId = 'GC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const pay = await charge(cents, token, buyer.email, clientIp(req), `Wing-O gift card ${money(cents)} (${purchaseId})`);
    if (!pay.ok && pay.unknown) {
      alertOwner(`🎁 Gift card payment for ${buyer.name} needs checking`, `<p>${escHtml(buyer.name)} (${escHtml(buyer.email)}) tried to buy a <b>${money(cents)}</b> gift card (ref ${purchaseId}) for ${escHtml(recipient.email)}, but Clover didn't give a clear answer (${escHtml(pay.message)}).</p>
        <p><b>What to do:</b> check Clover's Transactions. If they were charged, issue the card from wingorestaurants.com/gift-cards-admin (“Issue a card”). If not, nothing is needed.</p>`);
      return res.status(502).json({ error: 'We couldn\'t confirm your payment. Please don\'t try again yet: we\'ll check and email you. Questions: 639-997-0553.' });
    }
    if (!pay.ok) return res.status(402).json({ error: `${pay.declined ? 'Your card was declined' : 'The payment didn\'t go through'}: ${pay.message}. Nothing was charged.` });

    try {
      const card = await createCard({ kind: 'purchased', initial: cents, buyer, recipient, message, deliverAt, purchaseId, chargeId: pay.id, card: { brand: pay.brand, last4: pay.last4 } });
      let bonus = null; const bc = bonusFor(s.promo, cents);
      if (bc > 0) bonus = await createCard({ kind: 'bonus', initial: bc, buyer, recipient: { ...buyer }, message: '', deliverAt: null, sentAt: new Date(), purchaseId,
        validFrom: dayStart(s.promo.validFrom), expiresAt: dayEnd(s.promo.validTo) });
      if (deliverAt <= new Date()) await deliver(card);
      const rc = receiptEmail({ amount: cents, buyerEmail: buyer.email, ref: purchaseId, brand: pay.brand, last4: pay.last4 }, card, bonus);
      sendEmail({ to: rc.to, subject: rc.subject, html: rc.html, replyTo: ownerEmail });
      sendEmail({ to: ownerEmail, subject: `🎁 Gift card sold: ${money(cents)}${bonus ? ' (+' + money(bonus.initial) + ' bonus)' : ''}`,
        html: `<p style="font-family:Arial,sans-serif;">${escHtml(buyer.name)} bought a ${money(cents)} gift card for ${escHtml(recipient.name || recipient.email)}. Ref ${purchaseId}, ${escHtml(pay.brand)} ••${escHtml(pay.last4)}.${bonus ? ` Bonus card ${money(bonus.initial)} issued.` : ''}</p>` });
      console.log(`🎁 Gift card sold ${money(cents)} (${purchaseId})${bonus ? ' + bonus ' + money(bonus.initial) : ''}`);
      res.json({ success: true, ref: purchaseId, amount: cents, deliverAt: card.deliverAt, recipient: recipient.email, bonus: bonus ? { amount: bonus.initial, code: bonus.code, validFrom: bonus.validFrom, validTo: bonus.expiresAt } : null });
    } catch (e) {
      console.error('Gift card create failed after payment:', e.message);
      alertOwner(`🎁 Gift card paid but not created (${purchaseId})`, `<p>${escHtml(buyer.name)} (${escHtml(buyer.email)}) paid <b>${money(cents)}</b> (Clover charge ${escHtml(pay.id)}), but the card couldn't be saved: ${escHtml(e.message)}.</p><p>Issue it by hand at wingorestaurants.com/gift-cards-admin.</p>`);
      res.status(500).json({ error: 'Your payment went through, but we hit a problem creating the card. We\'ve been alerted and will email it to you shortly.' });
    }
  });

  // ══ STAFF (in-store) ═════════════════════════════════════════
  const staffOk = b => b && LOCATIONS[b.loc] && checkKitchenAuth(b.loc, b.pw);
  app.post('/api/giftcards/pos/lookup', async (req, res) => {
    const b = req.body || {}; if (!staffOk(b)) return res.status(401).json({ error: 'Wrong store password' });
    const code = normCode(b.code); if (!code) return res.status(400).json({ error: 'That isn\'t a Wing-O gift card code.' });
    const { cards, txns } = await cols();
    const c = await cards.findOne({ code });
    if (!c) return res.status(404).json({ error: 'No gift card with that code.' });
    const history = (await txns.find({ code }).sort({ at: -1 }).limit(8).toArray()).map(t => ({ type: t.type, amount: t.amount, at: t.at, store: t.store, orderNum: t.orderNum }));
    res.json({ card: publicCard(c), history });
  });
  app.post('/api/giftcards/pos/redeem', async (req, res) => {
    const b = req.body || {}; if (!staffOk(b)) return res.status(401).json({ error: 'Wrong store password' });
    const code = normCode(b.code); const cents = Math.round(Number(b.amount) * 100);
    if (!code) return res.status(400).json({ error: 'That isn\'t a Wing-O gift card code.' });
    if (!(cents > 0 && cents <= 100000)) return res.status(400).json({ error: 'Enter the amount to take off.' });
    const r = await debit(code, cents, { type: 'redeem-store', store: b.loc, note: String(b.note || '').slice(0, 80) });
    if (r.error) return res.status(400).json({ error: r.error });
    console.log(`🎁 ${code.slice(-4)} used in store at ${b.loc}: ${money(r.taken)}`);
    res.json({ taken: r.taken, balance: r.balance, txnId: String(r.txnId), short: cents - r.taken });
  });
  // Undo a mistake within 15 minutes, at the same store
  app.post('/api/giftcards/pos/undo', async (req, res) => {
    const b = req.body || {}; if (!staffOk(b)) return res.status(401).json({ error: 'Wrong store password' });
    const { cards, txns } = await cols(); const { ObjectId } = require('mongodb');
    let id; try { id = new ObjectId(String(b.txnId)); } catch (e) { return res.status(400).json({ error: 'Bad id' }); }
    const t = await txns.findOne({ _id: id });
    if (!t || t.type !== 'redeem-store' || t.store !== b.loc || t.undone) return res.status(400).json({ error: 'That can\'t be undone here.' });
    if (Date.now() - new Date(t.at).getTime() > 15 * 60e3) return res.status(400).json({ error: 'Too late to undo here. Ask the owner to adjust the card.' });
    await cards.updateOne({ code: t.code }, { $inc: { balance: -t.amount } });
    await txns.updateOne({ _id: id }, { $set: { undone: true } });
    const c = await cards.findOne({ code: t.code });
    await txns.insertOne({ code: t.code, type: 'undo', amount: -t.amount, balanceAfter: c.balance, at: new Date(), store: b.loc });
    res.json({ balance: c.balance });
  });

  // ══ ONLINE CHECKOUT (used by /api/orders) ════════════════════
  async function check(codeIn) {
    const code = normCode(codeIn); if (!code) return { error: 'That doesn\'t look like a Wing-O gift card code.' };
    const { cards } = await cols(); const c = await cards.findOne({ code });
    if (!c) return { error: 'We couldn\'t find that gift card. Check the code.' };
    const why = cardUsableNow(c); if (why) return { error: why };
    if (c.balance <= 0) return { error: 'This gift card has no balance left.' };
    return { code, balance: c.balance };
  }
  async function redeemOnline(code, cents, orderNum, store) { return debit(code, cents, { type: 'redeem-online', orderNum, store }); }
  // Put money back (e.g. an order that was charged to a card but then failed)
  async function refund(code, cents, orderNum) {
    const { cards, txns } = await cols();
    await cards.updateOne({ code }, { $inc: { balance: cents } });
    const c = await cards.findOne({ code });
    await txns.insertOne({ code, type: 'refund', amount: cents, balanceAfter: c ? c.balance : null, at: new Date(), orderNum });
  }

  // ══ OWNER ════════════════════════════════════════════════════
  const ownerOk = (req, res) => { if (!isAdmin((req.body || {}).password)) { res.status(401).json({ error: 'Wrong password' }); return false; } return true; };
  app.post('/api/giftcards/admin/state', async (req, res) => {
    if (!ownerOk(req, res)) return;
    const { cards, txns } = await cols(); const s = await settings();
    const all = await cards.find({}, { projection: { kind: 1, initial: 1, balance: 1, status: 1, createdAt: 1 } }).toArray();
    const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
    const live = all.filter(c => c.status === 'active');
    const used = await txns.find({ type: { $in: ['redeem-store', 'redeem-online'] }, undone: { $ne: true } }, { projection: { amount: 1, store: 1, type: 1 } }).toArray();
    const byStore = {}; used.forEach(t => { const k = t.store || 'online'; byStore[k] = (byStore[k] || 0) - t.amount; });
    res.json({
      settings: s, salesReady: payReady(LOCATIONS[SELL_STORE]),
      stats: {
        soldCount: all.filter(c => c.kind === 'purchased').length, sold: sum(all.filter(c => c.kind === 'purchased'), c => c.initial),
        bonusIssued: sum(all.filter(c => c.kind === 'bonus'), c => c.initial), compIssued: sum(all.filter(c => c.kind === 'comp'), c => c.initial),
        redeemed: -sum(used, t => t.amount), outstandingPurchased: sum(live.filter(c => c.kind === 'purchased'), c => c.balance),
        outstandingBonus: sum(live.filter(c => c.kind !== 'purchased'), c => c.balance), redeemedByStore: byStore,
      },
      recent: (await cards.find({}).sort({ createdAt: -1 }).limit(30).toArray()).map(c => ({ code: c.code, kind: c.kind, initial: c.initial, balance: c.balance, status: c.status,
        buyer: c.buyer, recipient: c.recipient, createdAt: c.createdAt, deliverAt: c.deliverAt, sentAt: c.sentAt, ref: c.purchaseId })),
      stores: Object.entries(LOCATIONS).map(([id, l]) => ({ id, name: l.name })),
    });
  });
  app.post('/api/giftcards/admin/search', async (req, res) => {
    if (!ownerOk(req, res)) return;
    const q = String((req.body || {}).q || '').trim(); if (q.length < 3) return res.json({ results: [] });
    const { cards, txns } = await cols(); const code = normCode(q);
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = code ? await cards.find({ code }).toArray()
      : await cards.find({ $or: [{ code: { $regex: esc.toUpperCase() } }, { 'buyer.email': { $regex: esc, $options: 'i' } }, { 'recipient.email': { $regex: esc, $options: 'i' } }, { 'recipient.name': { $regex: esc, $options: 'i' } }, { purchaseId: { $regex: esc.toUpperCase() } }] }).limit(20).toArray();
    const results = [];
    for (const c of found) results.push({ code: c.code, kind: c.kind, initial: c.initial, balance: c.balance, status: c.status, buyer: c.buyer, recipient: c.recipient, message: c.message,
      createdAt: c.createdAt, deliverAt: c.deliverAt, sentAt: c.sentAt, ref: c.purchaseId, validFrom: c.validFrom, expiresAt: c.expiresAt,
      history: (await txns.find({ code: c.code }).sort({ at: -1 }).limit(20).toArray()).map(t => ({ type: t.type, amount: t.amount, at: t.at, store: t.store, orderNum: t.orderNum, undone: !!t.undone })) });
    res.json({ results });
  });
  app.post('/api/giftcards/admin/settings', async (req, res) => {
    if (!ownerOk(req, res)) return;
    const b = (req.body || {}); const cur = await settings(); const p = b.promo || {};
    const day = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
    const promo = { enabled: typeof p.enabled === 'boolean' ? p.enabled : cur.promo.enabled,
      every: Math.round(Number(p.every) * 100) >= 1000 ? Math.round(Number(p.every) * 100) : cur.promo.every,
      bonus: Math.round(Number(p.bonus) * 100) >= 100 ? Math.round(Number(p.bonus) * 100) : cur.promo.bonus,
      endsAt: day(p.endsAt) || cur.promo.endsAt, validFrom: day(p.validFrom) || cur.promo.validFrom, validTo: day(p.validTo) || cur.promo.validTo };
    if (promo.validTo < promo.validFrom) return res.status(400).json({ error: 'The bonus "valid to" date must be after "valid from".' });
    const sales = typeof b.sales === 'boolean' ? b.sales : cur.sales;
    const { db } = await cols();
    await db.collection('settings').updateOne({ key: 'giftcards' }, { $set: { key: 'giftcards', promo, sales, updatedAt: new Date() } }, { upsert: true });
    res.json({ settings: { promo, sales } });
  });
  app.post('/api/giftcards/admin/issue', async (req, res) => {
    if (!ownerOk(req, res)) return;
    const b = req.body || {}; const cents = Math.round(Number(b.amount) * 100);
    if (!(cents >= 100 && cents <= 100000)) return res.status(400).json({ error: 'Amount from $1 to $1000.' });
    const recipient = { name: String(b.name || '').trim().slice(0, 60), email: String(b.email || '').trim().slice(0, 120) };
    if (recipient.email && !EMAIL_RE.test(recipient.email)) return res.status(400).json({ error: 'That email doesn\'t look right.' });
    const kind = b.kind === 'purchased' ? 'purchased' : 'comp';   // "purchased": paid some other way (e.g. a payment that needed checking)
    const card = await createCard({ kind, initial: cents, buyer: { name: 'Wing-O', email: '' }, recipient, message: String(b.message || '').slice(0, 300), deliverAt: new Date(), note: String(b.note || '').slice(0, 120) });
    if (recipient.email) await deliver(card);
    res.json({ code: card.code, sent: !!recipient.email });
  });
  app.post('/api/giftcards/admin/resend', async (req, res) => {
    if (!ownerOk(req, res)) return;
    const code = normCode((req.body || {}).code); const email = String((req.body || {}).email || '').trim();
    const { cards } = await cols(); const c = code && await cards.findOne({ code });
    if (!c) return res.status(404).json({ error: 'Card not found' });
    if (email) { if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right.' }); await cards.updateOne({ code }, { $set: { 'recipient.email': email } }); c.recipient = { ...(c.recipient || {}), email }; }
    if (!c.recipient || !c.recipient.email) return res.status(400).json({ error: 'No email on this card. Enter one.' });
    await deliver(c); res.json({ sent: true, to: c.recipient.email });
  });
  app.post('/api/giftcards/admin/void', async (req, res) => {
    if (!ownerOk(req, res)) return;
    const code = normCode((req.body || {}).code); const { cards, txns } = await cols();
    const c = code && await cards.findOne({ code }); if (!c) return res.status(404).json({ error: 'Card not found' });
    await cards.updateOne({ code }, { $set: { status: 'void', balance: 0, voidedAt: new Date() } });
    await txns.insertOne({ code, type: 'void', amount: -c.balance, balanceAfter: 0, at: new Date(), note: String((req.body || {}).note || '').slice(0, 120) });
    res.json({ ok: true });
  });

  return { check, redeemOnline, refund, normCode, mask, _test: { newCode, normCode, bonusFor, promoActive, deliverDue } };
};
