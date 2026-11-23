const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
let webpush = null;
try {
  webpush = require('web-push');
  // ── VAPID PUSH NOTIFICATIONS ──────────────────────────────────
  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BE-f0tIsYd6Rd2Q8HWi9LRCv3rlHG8n6KlZ9MC3FdIrKqaBDi9vQakjJdmO41iioFFaOwWebU8QC41JkHGmMJBA';
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'mcxVGSZebPbBJhnhxWDoXWzyUPSS0ILxBtovaQ5XOM8';
  webpush.setVapidDetails('mailto:besaucy@wingorestaurants.com', VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('✅ web-push loaded');
} catch(e) {
  console.warn('⚠️ web-push not available:', e.message);
}

const app = express();
// Compress pages and data (the home page is ~4x smaller). Optional: the site still runs without it.
try { app.use(require('compression')()); } catch (e) { console.warn('⚠️ compression not available:', e.message); }
app.use(cors());
app.use(express.json());
// Home page = the Sauce Boss Times front page (home.html). Ordering (cart, checkout) lives at /order
// (index.html). Old links that carry app data in the URL (?card=, ?ref=, etc.) go straight to /order;
// ad/social tracking tags (utm_*, fbclid, ...) stay on the home page.
const HOME_KEEP_PARAMS = /^(utm_\w+|fbclid|gclid|igsh|igshid|mibextid|ttclid|msclkid)$/;
app.get('/', (req, res) => {
  const keys = Object.keys(req.query || {});
  if (keys.some(k => !HOME_KEEP_PARAMS.test(k))) {
    const q = req.originalUrl.indexOf('?');
    return res.redirect(302, '/order' + req.originalUrl.slice(q));
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});
app.get('/order', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// extensions: lets clean URLs like /regina-albert-st serve regina-albert-st.html (SEO pages)
// Photos and fonts: phones keep them for a week instead of re-checking every visit.
// Pages and the service worker: always re-checked, so site updates show up right away.
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (/\.(jpe?g|png|webp|gif|svg|ico|woff2?|ttf|mp4|webm)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else if (/(\.html|service-worker\.js|manifest\.json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ── MONGODB CONNECTION ────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;
let db = null;

async function connectDB() {
  if (db) return db;
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('wingo');
    console.log('✅ MongoDB connected — wingo database');
    await db.collection('loyalty').createIndex({ phone: 1 }, { unique: true });
    await db.collection('loyalty').createIndex({ email: 1 });
    await db.collection('loyalty').createIndex({ usedOrderNums: 1 });
    await db.collection('orders').createIndex({ locationId: 1, kitchenStatus: 1, createdAt: -1 });
    await db.collection('orders').createIndex({ orderNum: 1 });
    await db.collection('settings').createIndex({ key: 1 }, { unique: true });
    return db;
  } catch (e) {
    console.error('❌ MongoDB connection failed:', e.message);
    return null;
  }
}
connectDB();

const envTrim = name => String(process.env[name] || '').trim() || undefined;

// ── LOCATION CONFIG ────────────────────────────────────────────
const LOCATIONS = {
  "albert-st": {
    name: "Albert Street (Regina)",
    merchantId: envTrim('CLOVER_MERCHANT_ID_ALBERT') || "98YG45GQNN8X1",
    apiToken: envTrim('CLOVER_API_TOKEN_ALBERT'),
    address: "#3 - 155 Albert St N, Regina, SK",
    phone: "639-997-0553", // TEMP: Albert St line having technical issues. Revert to 306-522-2111.
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    // Card payments at checkout (Clover Ecommerce). On only once both Ecommerce keys are set on Railway.
    onlinePayments: true,
    cloverPublicKey: envTrim('CLOVER_PUBLIC_KEY_ALBERT'),
    cloverPrivateKey: envTrim('CLOVER_PRIVATE_KEY_ALBERT')
  },
  "east-regina": {
    name: "East Regina (Wing-O East)",
    merchantId: envTrim('CLOVER_MERCHANT_ID_EAST') || "4BB1SFERQNQF1",
    apiToken: envTrim('CLOVER_API_TOKEN_EAST'),
    address: "534 University Park Drive, Regina, SK",
    phone: "306-522-2114",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: false,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_EAST
  },
  "regina-beach": {
    name: "Regina Beach",
    merchantId: envTrim('CLOVER_MERCHANT_ID_BEACH') || "WSTB4D3E5RAG1",
    apiToken: envTrim('CLOVER_API_TOKEN_BEACH'),
    address: "110 Centre St, Regina Beach, SK",
    phone: "639-997-0553",
    hours: "Every Day 11am-10pm",
    onlinePayments: false,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_BEACH
  },
  // Manitoba: 7% PST (RST) and Central time with daylight saving.
  // Ordering and delivery start OFF until the store opens: turn them on in /admin.
  "winnipeg": {
    name: "Winnipeg (Dakota St)",
    merchantId: envTrim('CLOVER_MERCHANT_ID_WINNIPEG'),
    apiToken: envTrim('CLOVER_API_TOKEN_WINNIPEG'),
    address: "1530 Dakota St, Unit 4001, Winnipeg, MB",
    phone: process.env.WINNIPEG_PHONE || "204-255-4055",
    hours: process.env.WINNIPEG_HOURS || "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: false,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_WINNIPEG,
    pst: 0.07,
    timeZone: "America/Winnipeg",
    startsOff: true
  }
};
// PST rate and time zone per location (Saskatchewan: 6% PST, CST all year).
const locPst = loc => (loc && loc.pst) || 0.06;
const pstLabel = loc => `PST (${Math.round(locPst(loc) * 100)}%)`;
const locTz = loc => (loc && loc.timeZone) || 'America/Regina';
// Saved on/off switches (settings collection), with "starts off" locations treated as off until switched on.
function effectiveStatus(saved, flag) {
  const out = Object.assign({}, saved || {});
  Object.entries(LOCATIONS).forEach(([id, l]) => { if (l[flag] && out[id] === undefined) out[id] = false; });
  return out;
}

// ── KITCHEN AUTH ──────────────────────────────────────────────
function getKitchenPassword(loc) {
  switch(loc) {
    case 'albert-st':   return process.env.KITCHEN_PW_ALBERT;
    case 'east-regina': return process.env.KITCHEN_PW_EAST;
    case 'regina-beach': return process.env.KITCHEN_PW_BEACH;
    case 'winnipeg':    return process.env.KITCHEN_PW_WINNIPEG;
    default: return null;
  }
}
function checkKitchenAuth(loc, pw) {
  const expected = String(getKitchenPassword(loc) || '').trim();
  return !!expected && typeof pw === 'string' && pw.trim() === expected;
}

// ── EMAIL (Resend) ─────────────────────────────────────────────
async function sendEmail({ to, subject, html, replyTo }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('No RESEND_API_KEY'); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Wing-O Orders <orders@wingorestaurants.com>', to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    const d = await r.json();
    if (d.id) console.log(`✉️ Email sent: ${subject}`);
    else console.warn('Email error:', JSON.stringify(d));
  } catch (e) { console.warn('Email failed:', e.message); }
}

// ── AUTO STAMP ────────────────────────────────────────────────
// Stamp cards are matched on the 10-digit number, so "+1 (306) 555-0101" and "306-555-0101" are the same card.
// Older cards may have been saved with the leading 1, so lookups accept both forms.
function loyaltyPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 11 && d[0] === '1' ? d.slice(1) : d;
}
const loyaltyPhoneQuery = p => ({ phone: { $in: [p, '1' + p] } });

// Staff password: only the ADMIN_PASSWORD set on Railway works (no built-in fallback).
// Spaces or a newline pasted around the password (in Railway or the form) shouldn't lock the owner out.
function isAdmin(pw) {
  const expected = String(process.env.ADMIN_PASSWORD || '').trim();
  return !!expected && typeof pw === 'string' && pw.trim() === expected;
}

// Each stamp card gets a private token so the browser never needs the customer's full phone or email.
const newCardToken = () => require('crypto').randomBytes(12).toString('hex');
async function ensureCardToken(database, member) {
  if (!member.cardToken) {
    member.cardToken = newCardToken();
    await database.collection('loyalty').updateOne({ _id: member._id }, { $set: { cardToken: member.cardToken } });
  }
  return member;
}
// Free wings still owed to the customer. Cards from before redemptions were tracked count the latest
// reward as unused only while the card is still at 0 stamps (what the old card showed).
function freeAvailable(member) {
  const earned = member.freeEarned || 0;
  if (member.freeRedeemed === undefined) return (member.stamps || 0) === 0 && earned > 0 ? 1 : 0;
  return Math.max(0, earned - member.freeRedeemed);
}
// What a customer's browser is allowed to see: no email, no full phone number.
function publicCard(member) {
  const last4 = String(member.phone || '').slice(-4);
  const free = freeAvailable(member);
  return {
    name: String(member.name || '').split(' ')[0],
    phoneLast4: last4,
    token: member.cardToken,
    stamps: member.stamps || 0,
    totalOrders: member.totalOrders || 0,
    freeEarned: member.freeEarned || 0,
    freeAvailable: free,
    rewardCode: free > 0 ? 'SAUCY-' + last4 : null,
    referralCode: member.referralCode || null,
    referralCount: member.referralCount || 0,
    history: (member.history || []).map(h => ({ orderNum: h.orderNum, date: h.date, stamp: h.stamp, referral: !!h.referral, redeemed: !!h.redeemed }))
  };
}

async function autoAddStamp(phone, orderNum, customerName) {
  if (!phone || !orderNum) return null;
  const cleanPhone = loyaltyPhone(phone);
  try {
    const database = await connectDB();
    if (!database) return null;
    const member = await database.collection('loyalty').findOne(loyaltyPhoneQuery(cleanPhone));
    if (!member) return null;
    if (member.usedOrderNums && member.usedOrderNums.includes(orderNum)) {
      console.log(`⚠️ Stamp already given for order ${orderNum}`);
      return null;
    }
    const newStamps = (member.stamps || 0) + 1;
    const newTotalOrders = (member.totalOrders || 0) + 1;
    const gotFree = newStamps >= 10;
    const finalStamps = gotFree ? 0 : newStamps;
    const newFreeEarned = gotFree ? (member.freeEarned || 0) + 1 : (member.freeEarned || 0);
    const newHistory = [
      { orderNum, date: new Date().toLocaleDateString('en-CA'), stamp: newTotalOrders, auto: true },
      ...(member.history || [])
    ].slice(0, 50);
    await database.collection('loyalty').updateOne(
      { _id: member._id },
      {
        $set: { stamps: finalStamps, totalOrders: newTotalOrders, freeEarned: newFreeEarned, history: newHistory, updatedAt: new Date() },
        $push: { usedOrderNums: orderNum }
      }
    );
    console.log(`🍗 AUTO-STAMP: ${member.name} — Order ${orderNum} — Stamp ${newTotalOrders} — Free: ${gotFree}`);
    if (gotFree) {
      sendEmail({
        to: 'besaucy@wingorestaurants.com',
        subject: `🎉 FREE WINGS EARNED — ${member.name}`,
        html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;">
          <h2 style="color:#E8190A;margin:0 0 16px;">🎉 Free Wings Earned!</h2>
          <p style="color:#CCC;font-size:15px;margin-bottom:12px;"><strong style="color:white;">${member.name}</strong> just collected their 10th stamp!</p>
          <table style="width:100%;color:#CCC;font-size:14px;">
            <tr><td style="padding:6px 0;color:#888;">Phone</td><td>${cleanPhone}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Order</td><td>${orderNum}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Total Orders</td><td>${newTotalOrders}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Free Wings #</td><td style="color:#F5A800;font-weight:bold;">${newFreeEarned}</td></tr>
          </table>
          <div style="background:#E8190A;border-radius:6px;padding:12px;margin-top:16px;text-align:center;">
            <div style="color:white;font-size:13px;letter-spacing:1px;">REDEEM: Give customer one FREE half order of wings 🍗</div>
          </div>
        </div>`
      });
    }
    return { gotFree, stamps: finalStamps, totalOrders: newTotalOrders, memberName: member.name };
  } catch (e) {
    console.error('Auto-stamp error:', e.message);
    return null;
  }
}

// ── CREATE CLOVER ORDER ────────────────────────────────────────
// Emoji and the invisible characters that join them; printers show these as "?"
const noEmoji = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D\u20E3]/gu;
const printable = t => String(t || '').replace(noEmoji, '').replace(/\s+/g, ' ').trim();

// Ask Clover to print the order on the store's order printer as soon as it's complete,
// so staff don't have to open it and press print. Turn off with CLOVER_AUTO_PRINT=off on Railway.
async function printCloverOrder(loc, cloverId, orderNum) {
  if (String(process.env.CLOVER_AUTO_PRINT || '').toLowerCase() === 'off') return;
  let problem = null;
  try {
    const r = await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/print_event`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderRef: { id: cloverId } })
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok) console.log(`🖨️  Print sent for ${cloverId} (${loc.name}) — ${d.state || 'queued'}`);
    else { problem = `Clover answered ${r.status}`; console.warn(`Auto-print failed for ${cloverId} (${loc.name}): ${r.status} ${JSON.stringify(d).slice(0, 200)}`); }
  } catch (e) { problem = e.message; console.warn('Auto-print error:', e.message); }
  if (problem) alertOwner(`🖨️ Order ${orderNum || ''} did NOT auto-print at ${loc.name}`,
    `<p>Order <b>${escHtml(orderNum || cloverId)}</b> is in Clover at <b>${escHtml(loc.name)}</b>, but the automatic print did not go through (${escHtml(problem)}).</p>
     <p><b>What to do:</b> open the order in Clover on the POS and press Print, so the kitchen gets the ticket.</p>`);
}

// ── ALERTS TO THE OWNER ───────────────────────────────────────
// Emails the owner straight away when an online order needs a person: it didn't reach Clover,
// didn't print, or wasn't saved for the kitchen screen. ALERT_EMAIL on Railway sends them elsewhere.
const ALERT_TO = process.env.ALERT_EMAIL || 'besaucy@wingorestaurants.com';
function alertOwner(subject, body) {
  console.warn('🚨 ALERT:', subject);
  return sendEmail({
    to: ALERT_TO,
    subject: `🚨 ${subject}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:3px solid #E8190A;">
      <div style="background:#E8190A;color:#fff;padding:14px 18px;font-weight:bold;font-size:18px;">⚠️ Wing-O website alert</div>
      <div style="padding:18px;font-size:15px;line-height:1.5;color:#1A1208;">${body}
      <p style="color:#888;font-size:12px;margin-top:18px;">Sent automatically by wingorestaurants.com at ${new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' })} (Regina time).</p></div></div>`,
  });
}

// discounts: [{ name, amount }] in dollars (first-order 15%, late night 10%). They go on the Clover
// order as real discounts, and GST/PST are worked out on the discounted subtotal, so the POS total
// matches what the customer saw at checkout.
// ── CLOVER TAX ─────────────────────────────────────────────────
// GST/PST must be booked in Clover as TAX, not as sales items, or the accounting reports are wrong.
// So orders go in through Clover's atomic order API with the store's own GST/PST tax rates on each
// item; Clover works out the tax and the totals itself. If the rates aren't set up in Clover, the
// call fails, or Clover's total doesn't match ours, the order is removed and re-sent the old way
// (taxes as items) so no order or tax is ever lost. CLOVER_TAX_MODE=items on Railway forces the old way.
const cloverTaxCache = {};
async function cloverTaxRateIds(loc) {
  const c = cloverTaxCache[loc.merchantId];
  if (c && Date.now() - c.at < (c.ids ? 6 * 3600e3 : 10 * 60e3)) return c.ids;
  let ids = null;
  try {
    const r = await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/tax_rates?limit=100`, { headers: { 'Authorization': `Bearer ${loc.apiToken}` } });
    const d = await r.json();
    const rates = Array.isArray(d.elements) ? d.elements : [];
    // Clover stores rates as whole numbers: 5% = 500000
    const byRate = pct => rates.find(t => Number(t.rate) === Math.round(pct * 10000000));
    const gst = byRate(0.05), pst = byRate(locPst(loc)), both = byRate(0.05 + locPst(loc));
    if (gst && pst) ids = [gst.id, pst.id];
    else if (both) ids = [both.id];
    console.log(`Clover tax rates for ${loc.name}: ${ids ? (ids.length === 2 ? 'GST + PST found' : 'combined GST+PST found')
      : 'GST/PST not found (' + rates.map(t => `${t.name} ${Number(t.rate) / 100000}%`).join(', ') + ') — taxes will go in as items'}`);
  } catch (e) { console.warn('Clover tax rate lookup failed:', e.message); }
  cloverTaxCache[loc.merchantId] = { at: Date.now(), ids };
  return ids;
}

// opts.print = false leaves the ticket unprinted (a card payment is taken first, then it prints).
async function createCloverOrder(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp, discounts = [], opts = {}) {
  if (!loc.merchantId || !loc.apiToken) return createCloverOrderItems(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp, discounts, opts);
  if (String(process.env.CLOVER_TAX_MODE || '').toLowerCase() !== 'items') {
    try {
      const taxIds = await cloverTaxRateIds(loc);
      if (taxIds) {
        const id = await createCloverAtomicOrder(loc, orderNum, orderType, customer, items, subtotal, notes, discounts, taxIds);
        if (id) { if (opts.print !== false) await printCloverOrder(loc, id, orderNum); return id; }
      }
    } catch (e) { console.warn('Clover tax-rate order failed, using tax items:', e.message); }
  }
  return createCloverOrderItems(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp, discounts, opts);
}

async function createCloverAtomicOrder(loc, orderNum, orderType, customer, items, subtotal, notes, discounts, taxIds) {
  const base = `https://api.clover.com/v3/merchants/${loc.merchantId}`;
  const H = { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' };
  const cleanNote = String(notes || '').replace(noEmoji, '').replace(/\[\s*/g, '').replace(/\s*\]/g, '\n').replace(/[ \t]+/g, ' ').split('\n').map(l => l.trim()).filter(Boolean);
  const note = [
    `${orderNum}${orderType === 'delivery' ? ' · DELIVERY' : ''}`,
    ...(orderType === 'delivery' ? [`Deliver to: ${customer.address || ''}`, `Phone: ${customer.phone || ''}`] : []),
    ...cleanNote,
  ].join('\n');
  const title = `Online ${orderType} — ${customer.firstName} ${customer.lastName || ''}`;
  const taxRates = taxIds.map(id => ({ id }));

  // One line per unit, like in-store tickets; every food item carries the store's GST/PST rates
  const lineItems = [];
  for (const item of items) {
    const li = { name: printable(item.name).slice(0, 127), price: Math.round(item.price * 100), unitQty: 1000, note: printable(item.flavor).slice(0, 255), taxRates };
    for (let q = 0; q < Math.max(1, Number(item.qty) || 1); q++) lineItems.push({ ...li });
  }
  if (orderType === 'delivery') lineItems.push({ name: 'Delivery Fee', price: 550, unitQty: 1000 });
  const discCents = discounts.map(d => Math.round(Number(d.amount) * 100)).filter(c => c > 0);
  const cartDiscounts = discounts.filter(d => Math.round(Number(d.amount) * 100) > 0).map(d => ({ name: printable(d.name).slice(0, 127), amount: -Math.round(Number(d.amount) * 100) }));

  // What the customer was charged, to check Clover agrees
  const itemCents = lineItems.filter(l => l.taxRates).reduce((s, l) => s + l.price, 0);
  const taxable = Math.max(0, itemCents - discCents.reduce((s, c) => s + c, 0));
  const expected = taxable + Math.round(taxable * 0.05) + Math.round(taxable * locPst(loc)) + (orderType === 'delivery' ? 550 : 0);

  const r = await fetch(`${base}/atomic_order/orders`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ orderCart: { title, note, groupLineItems: false, lineItems, ...(cartDiscounts.length ? { discounts: cartDiscounts } : {}) } })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) { console.warn(`Clover atomic order failed (${r.status}): ${JSON.stringify(d).slice(0, 300)} — using tax items`); return null; }
  const id = d.id;

  // Open it like other online orders, then make sure Clover kept every item and priced it like we did
  await fetch(`${base}/orders/${id}`, { method: 'POST', headers: H, body: JSON.stringify({ state: 'open', title, note }) }).catch(() => {});
  const chk = await (await fetch(`${base}/orders/${id}?expand=lineItems`, { headers: { 'Authorization': H.Authorization } })).json().catch(() => ({}));
  const count = chk.lineItems && Array.isArray(chk.lineItems.elements) ? chk.lineItems.elements.length : 0;
  const total = Number(chk.total);
  if (count !== lineItems.length || !(Math.abs(total - expected) <= 5)) {
    console.warn(`Clover order ${id} doesn't match (items ${count}/${lineItems.length}, total ${total} vs ${expected} cents) — removing it and using tax items`);
    await fetch(`${base}/orders/${id}`, { method: 'DELETE', headers: { 'Authorization': H.Authorization } }).catch(() => {});
    return null;
  }
  console.log(`✓ Clover order ${id} with GST/PST as tax — $${(total / 100).toFixed(2)}`);
  return id;
}

// The old way: items, discounts, then GST/PST as items. Used when Clover's tax rates can't be.
async function createCloverOrderItems(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp, discounts = [], opts = {}) {
  if (!loc.merchantId || !loc.apiToken) {
    console.error(`Clover not set up for ${loc.name}: add its merchant ID and API token on Railway`);
    return null;
  }
  // Keep the printed ticket short, like in-store tickets: order number, pickup time
  // and the customer's notes only. Receipt printers can't print emoji (they come out as "?").
  const cleanNote = String(notes || '').replace(noEmoji, '').replace(/\[\s*/g, '').replace(/\s*\]/g, '\n').replace(/[ \t]+/g, ' ').split('\n').map(l => l.trim()).filter(Boolean);
  const orderNote = [
    `${orderNum}${orderType === 'delivery' ? ' · DELIVERY' : ''}`,
    ...(orderType === 'delivery' ? [`Deliver to: ${customer.address || ''}`, `Phone: ${customer.phone || ''}`] : []),
    ...cleanNote,
  ].join('\n');

  const createResp = await fetch(
    `https://api.clover.com/v3/merchants/${loc.merchantId}/orders`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Online ${orderType} — ${customer.firstName} ${customer.lastName || ''}`,
        note: orderNote,
        state: 'open'
      })
    }
  );
  const createData = await createResp.json();
  if (!createResp.ok || !createData.id) {
    console.error('Clover create failed:', createResp.status, JSON.stringify(createData));
    return null;
  }
  const cloverId = createData.id;
  console.log(`✓ Clover order created: ${cloverId}`);

  for (const item of items) {
    try {
      // Item name on its own line, flavours and notes printed underneath (like in-store tickets)
      const itemName = printable(item.name).slice(0, 127);
      const itemNote = printable(item.flavor).slice(0, 255);
      const lineResp = await fetch(
        `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: itemName, price: Math.round(item.price * 100), unitQty: 1000, note: itemNote })
        }
      );
      const lineData = await lineResp.json();
      console.log(`  Line item: ${itemName} — ${lineResp.status} — id:${lineData.id||'?'}`);
      if (item.qty > 1) {
        for (let q = 1; q < item.qty; q++) {
          await fetch(
            `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: itemName, price: Math.round(item.price * 100), unitQty: 1000, note: itemNote })
            }
          );
        }
      }
    } catch (e) { console.warn('Line item error:', e.message); }
  }

  // ── Discounts (first-order 15%, late night 10%) ──
  // Added as order discounts; if Clover refuses, fall back to a negative line item so the total is still right.
  for (const d of discounts) {
    const cents = Math.round(Number(d.amount) * 100);
    if (!(cents > 0)) continue;
    const name = printable(d.name).slice(0, 127);
    try {
      const dResp = await fetch(
        `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/discounts`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, amount: -cents })
        }
      );
      if (dResp.ok) { console.log(`  Discount: ${name} −$${(cents / 100).toFixed(2)}`); continue; }
      console.warn(`  Discount endpoint ${dResp.status}, adding as line item instead`);
      await fetch(
        `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, price: -cents, unitQty: 1000 })
        }
      );
    } catch (e) { console.warn(`Failed to add discount ${name}:`, e.message); }
  }

  // ── Add tax + delivery fee as line items so receipt total is correct ──
  // Tax is on the subtotal after discounts.
  const discountTotal = discounts.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const subtotalNum = Math.max(0, Number(subtotal) - discountTotal);
  const gst = Math.round(subtotalNum * 0.05 * 100); // cents
  const pst = Math.round(subtotalNum * locPst(loc) * 100); // cents

  const extras = [
    { name: 'GST (5%)', price: gst },
    { name: pstLabel(loc), price: pst }
  ];

  if (orderType === 'delivery') {
    extras.push({ name: 'Delivery Fee', price: 550 }); // $5.50 in cents
  }

  for (const extra of extras) {
    if (extra.price <= 0) continue;
    try {
      await fetch(
        `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: extra.name,
            price: extra.price,
            unitQty: 1000
          })
        }
      );
      console.log(`  Added extra: ${extra.name} — $${(extra.price/100).toFixed(2)}`);
    } catch(e) {
      console.warn(`Failed to add ${extra.name}:`, e.message);
    }
  }

  console.log(`✓ Line items + extras added to ${cloverId}`);
  if (opts.print !== false) await printCloverOrder(loc, cloverId, orderNum);
  return cloverId;
}

// Changes on every deploy; the kitchen screen offers a reload when it sees a new one
const BUILD_ID = process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_GIT_COMMIT_SHA || String(Date.now());

// ── ONLINE CARD PAYMENTS (Clover Ecommerce) ───────────────────
// The card form is Clover's own hosted iframe: card numbers never touch this server, only a one-time
// clv_ token does. The order goes into Clover unprinted, the token pays that Clover order, and only then
// does the ticket print. A declined card removes the order, so nothing reaches the kitchen unpaid.
// Needs CLOVER_PUBLIC_KEY_<STORE> and CLOVER_PRIVATE_KEY_<STORE> on Railway; ONLINE_PAY=off turns it all off.
const payReady = loc => !!(loc && loc.onlinePayments && loc.cloverPublicKey && loc.cloverPrivateKey && loc.merchantId && loc.apiToken)
  && String(process.env.ONLINE_PAY || '').toLowerCase() !== 'off';
const CLOVER_ECOMM = process.env.CLOVER_ECOMM_SANDBOX === 'on'
  ? { api: 'https://scl-sandbox.dev.clover.com', sdk: 'https://checkout.sandbox.dev.clover.com/sdk.js' }
  : { api: 'https://scl.clover.com', sdk: 'https://checkout.clover.com/sdk.js' };
const clientIp = req => String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim();

// The total Clover has on the order, in cents (so we never charge something other than what the customer saw)
async function cloverOrderTotal(loc, cloverId) {
  try {
    const r = await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}`, { headers: { 'Authorization': `Bearer ${loc.apiToken}` } });
    const d = await r.json().catch(() => ({}));
    return r.ok && Number.isFinite(Number(d.total)) ? Number(d.total) : null;
  } catch (e) { return null; }
}
// Puts "PAID ONLINE" on the Clover order's title and note, so the printed kitchen ticket shows it
async function markCloverOrderPaid(loc, cloverId, label) {
  try {
    const H = { 'Authorization': `Bearer ${loc.apiToken}` };
    const d = await (await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}`, { headers: H })).json().catch(() => ({}));
    const title = `PAID ONLINE - ${String(d.title || 'Online order').replace(/^PAID ONLINE - /, '')}`.slice(0, 127);
    const note = `*** PAID ONLINE ***\n${label}\n${d.note || ''}`.trim().slice(0, 2000);
    const r = await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}`, {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, note }) });
    if (!r.ok) console.warn(`Could not mark ${cloverId} as paid on the ticket: ${r.status}`);
  } catch (e) { console.warn('Could not mark order paid on the ticket:', e.message); }
}
async function deleteCloverOrder(loc, cloverId) {
  try {
    await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${loc.apiToken}` } });
    console.log(`🗑️  Removed unpaid Clover order ${cloverId} (${loc.name})`);
  } catch (e) { console.warn('Could not remove unpaid Clover order:', e.message); }
}
// { ok, amount, charge, brand, last4 } | { ok:false, message, unknown } (unknown = we can't tell if the card was charged)
async function payCloverOrder(loc, cloverId, token, email, ip) {
  let r, d;
  try {
    r = await fetch(`${CLOVER_ECOMM.api}/v1/orders/${cloverId}/pay`, {
      method: 'POST',
      headers: {
        'accept': 'application/json', 'content-type': 'application/json',
        'authorization': `Bearer ${loc.cloverPrivateKey}`,
        'idempotency-key': require('crypto').randomUUID(),
        ...(ip ? { 'x-forwarded-for': ip } : {}),
      },
      body: JSON.stringify({ source: token, ecomind: 'ecom', ...(email && String(email).includes('@') ? { email: String(email).trim() } : {}) }),
    });
    d = await r.json().catch(() => ({}));
  } catch (e) {
    console.error(`💳 Payment request for ${cloverId} failed with no answer:`, e.message);
    return { ok: false, unknown: true, message: e.message };
  }
  if (r.ok && d.status === 'paid') {
    const src = d.source || {};
    console.log(`💳 Paid ${cloverId} — $${(Number(d.amount_paid || d.amount) / 100).toFixed(2)} ${src.brand || ''} ••${src.last4 || ''}`);
    return { ok: true, amount: Number(d.amount_paid || d.amount), charge: d.charge || null, brand: src.brand || '', last4: src.last4 || '' };
  }
  const err = d.error || {};
  const message = err.message || d.message || `Clover answered ${r.status}`;
  console.warn(`💳 Payment for ${cloverId} not taken (${r.status}): ${JSON.stringify(d).slice(0, 300)}`);
  // A 5xx means Clover may or may not have charged the card: a person has to check
  return { ok: false, unknown: r.status >= 500, message, declined: r.status === 402 || err.type === 'card_error' || /declin/i.test(message) };
}

// The browser asks which stores take cards online, and gets the PUBLIC key for Clover's card form.
app.get('/api/payments/config', (req, res) => {
  const out = {};
  Object.entries(LOCATIONS).forEach(([id, loc]) => {
    if (payReady(loc)) out[id] = { enabled: true, publicKey: loc.cloverPublicKey, merchantId: loc.merchantId, sdk: CLOVER_ECOMM.sdk };
  });
  res.set('Cache-Control', 'no-store').json(out);
});

// ── FIRST-ORDER DISCOUNT CHECK ────────────────────────────────
const FIRST_ORDER_DISCOUNT_PCT = 0.15;
const FIRST_ORDER_MIN_SUBTOTAL = 25.00;

async function isFirstOrder(phone) {
  if (!phone) return false;
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length < 10) return false;
  try {
    const database = await connectDB();
    if (!database) return false;
    const existing = await database.collection('orders').findOne({ 'customer.phone': cleanPhone });
    return !existing;
  } catch (e) {
    console.warn('isFirstOrder check failed:', e.message);
    return false;
  }
}

app.get('/api/check-first-order', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ firstOrder: true, eligible: true });
  const firstOrder = await isFirstOrder(phone);
  res.json({
    firstOrder,
    eligible: firstOrder,
    discountPct: FIRST_ORDER_DISCOUNT_PCT * 100,
    minSubtotal: FIRST_ORDER_MIN_SUBTOTAL
  });
});

// ── HALLOWEEN GHOST HUNT REWARD ───────────────────────────────
// Customers who catch all 5 ghosts on the site get FREE small fries
// on a $30+ order — once per phone number per Halloween season.
// Season dates match public/halloween.js (Sep 25 – Nov 1, Regina time).
const GHOST_HUNT_MIN_SUBTOTAL = 30.00;
const GHOST_HUNT_FRIES_ITEM = { name: '🎃 FREE Fries (Ghost Hunt)', flavor: 'Small · Halloween Ghost Hunt reward', price: 0, qty: 1 };

function ghostHuntSeason() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Regina', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).reduce((o, p) => (o[p.type] = Number(p.value), o), {});
  const md = parts.month * 100 + parts.day;
  return { active: md >= 925 && md <= 1101, year: parts.year };
}

async function ghostHuntRedeemed(phoneNorm, year) {
  const database = await connectDB();
  if (!database) return true;  // fail closed — can't verify, don't give it away
  return !!(await database.collection('orders').findOne({ ghostHuntPhone: phoneNorm, ghostHuntYear: year }));
}

// ── TV SCREENS (digital menu boards) ──────────────────────────
// /tv-admin: upload pictures and videos, pick which stores show them, order, how long, which days,
// and the scrolling text. Each TV opens /tv?loc=<store> full screen and picks up changes within a minute.
// Files live on a Railway volume (RAILWAY_VOLUME_MOUNT_PATH, or SIGNAGE_DIR), so deploys don't wipe them.
const fs = require('fs');
const SIGNAGE_DIR = process.env.SIGNAGE_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'signage') : null);
if (SIGNAGE_DIR) { try { fs.mkdirSync(SIGNAGE_DIR, { recursive: true }); } catch (e) { console.warn('TV screens: cannot create', SIGNAGE_DIR, e.message); } }
const SIGNAGE_MAX_BYTES = 95 * 1024 * 1024; // Cloudflare refuses uploads over 100 MB
const SIGNAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
const SIGNAGE_DEFAULT_TICKER = '10% OFF LATE NIGHTS AFTER 11 PM  •  ORDER AT WINGORESTAURANTS.COM  •  15% OFF YOUR FIRST ONLINE ORDER';
const signageAuth = req => isAdmin(req.get('x-admin-password') || (req.body && req.body.password) || '');
const signageItemOut = it => ({ id: String(it._id), title: it.title || '', type: it.type, url: `/media/signage/${it.file}`, locations: it.locations || ['all'],
  seconds: it.seconds || 10, days: it.days || [], active: it.active !== false, order: it.order || 0, bytes: it.bytes || 0, createdAt: it.createdAt });
async function signageSettings(database) {
  const d = await database.collection('settings').findOne({ key: 'signage' });
  return { ticker: (d && d.ticker) || { all: SIGNAGE_DEFAULT_TICKER } };
}

// What one TV should play right now (only items for its store, switched on, and for today's weekday)
app.get('/api/signage/playlist', async (req, res) => {
  const loc = String(req.query.loc || '');
  res.set('Cache-Control', 'no-store');
  try {
    const database = await connectDB();
    if (!database) return res.status(503).json({ error: 'database unavailable' });
    const tz = locTz(LOCATIONS[loc]);
    const dow = new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getDay();
    const items = (await database.collection('signage_items').find({}).sort({ order: 1, createdAt: 1 }).toArray())
      .filter(it => it.active !== false)
      .filter(it => !(it.locations && it.locations.length) || it.locations.includes('all') || it.locations.includes(loc))
      .filter(it => !(it.days && it.days.length) || it.days.includes(dow))
      .map(signageItemOut);
    const s = await signageSettings(database);
    const ticker = s.ticker[loc] !== undefined && s.ticker[loc] !== '' ? s.ticker[loc] : (s.ticker.all || '');
    res.json({ build: BUILD_ID, items, ticker, location: LOCATIONS[loc] ? LOCATIONS[loc].name : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/media/signage/:file', (req, res) => {
  const f = String(req.params.file);
  if (!SIGNAGE_DIR || !/^[a-f0-9]{24}\.(jpg|png|webp|gif|mp4|webm|mov)$/.test(f)) return res.status(404).end();
  res.sendFile(path.join(SIGNAGE_DIR, f), { maxAge: '365d', immutable: true }, err => { if (err && !res.headersSent) res.status(404).end(); });
});

app.post('/api/signage/login', (req, res) => {
  if (!signageAuth(req)) return res.status(401).json({ error: 'Wrong password' });
  res.json({ ok: true, storage: !!SIGNAGE_DIR, locations: Object.entries(LOCATIONS).map(([id, l]) => ({ id, name: l.name })) });
});

app.get('/api/signage/items', async (req, res) => {
  if (!signageAuth(req)) return res.status(401).json({ error: 'Wrong password' });
  const database = await connectDB();
  if (!database) return res.status(503).json({ error: 'database unavailable' });
  const items = await database.collection('signage_items').find({}).sort({ order: 1, createdAt: 1 }).toArray();
  res.json({ items: items.map(signageItemOut), ...(await signageSettings(database)), storage: !!SIGNAGE_DIR });
});

// Upload: the raw file is the request body (streamed to disk, so big videos don't fill memory)
app.post('/api/signage/upload', async (req, res) => {
  if (!signageAuth(req)) return res.status(401).json({ error: 'Wrong password' });
  if (!SIGNAGE_DIR) return res.status(503).json({ error: 'No storage yet: add a Volume to the server on Railway first (see the note on this page).' });
  const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = SIGNAGE_TYPES[type];
  if (!ext) return res.status(415).json({ error: 'Use a JPG, PNG, WEBP or GIF picture, or an MP4, WEBM or MOV video.' });
  const len = Number(req.get('content-length') || 0);
  if (len > SIGNAGE_MAX_BYTES) return res.status(413).json({ error: 'That file is over 95 MB. Shorten or compress the video and try again.' });
  const id = new ObjectId(); const file = `${id.toHexString()}.${ext}`; const dest = path.join(SIGNAGE_DIR, file);
  let bytes = 0, tooBig = false;
  const out = fs.createWriteStream(dest);
  req.on('data', c => { bytes += c.length; if (bytes > SIGNAGE_MAX_BYTES && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); req.resume(); } });
  req.pipe(out);
  const done = await new Promise(r => { out.on('finish', () => r(true)); out.on('close', () => r(!tooBig)); out.on('error', () => r(false)); req.on('aborted', () => r(false)); });
  if (!done || tooBig || bytes === 0) { fs.unlink(dest, () => {}); return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'That file is over 95 MB.' : 'The upload did not finish. Try again.' }); }
  try {
    const database = await connectDB();
    const last = await database.collection('signage_items').find({}).sort({ order: -1 }).limit(1).toArray();
    const doc = { _id: id, file, type: type.startsWith('video') ? 'video' : 'image', bytes,
      title: String(req.query.title || '').slice(0, 120), locations: ['all'], seconds: 10, days: [], active: true,
      order: (last[0] ? last[0].order || 0 : 0) + 1, createdAt: new Date() };
    await database.collection('signage_items').insertOne(doc);
    console.log(`📺 TV upload: ${doc.type} ${file} (${(bytes / 1048576).toFixed(1)} MB)`);
    res.json({ item: signageItemOut(doc) });
  } catch (e) { fs.unlink(dest, () => {}); res.status(500).json({ error: e.message }); }
});

app.post('/api/signage/items/:id', async (req, res) => {
  if (!signageAuth(req)) return res.status(401).json({ error: 'Wrong password' });
  let _id; try { _id = new ObjectId(String(req.params.id)); } catch (e) { return res.status(400).json({ error: 'Bad id' }); }
  const b = req.body || {}; const set = {};
  if (typeof b.title === 'string') set.title = b.title.slice(0, 120);
  if (Array.isArray(b.locations)) set.locations = b.locations.map(String).filter(l => l === 'all' || LOCATIONS[l]);
  if (b.seconds !== undefined) set.seconds = Math.min(600, Math.max(3, Math.round(Number(b.seconds) || 10)));
  if (Array.isArray(b.days)) set.days = [...new Set(b.days.map(Number).filter(d => d >= 0 && d <= 6))];
  if (typeof b.active === 'boolean') set.active = b.active;
  if (b.order !== undefined && Number.isFinite(Number(b.order))) set.order = Number(b.order);
  const database = await connectDB();
  const r = await database.collection('signage_items').findOneAndUpdate({ _id }, { $set: set }, { returnDocument: 'after' });
  const doc = r && (r.value !== undefined ? r.value : r);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json({ item: signageItemOut(doc) });
});

app.post('/api/signage/items/:id/delete', async (req, res) => {
  if (!signageAuth(req)) return res.status(401).json({ error: 'Wrong password' });
  let _id; try { _id = new ObjectId(String(req.params.id)); } catch (e) { return res.status(400).json({ error: 'Bad id' }); }
  const database = await connectDB();
  const doc = await database.collection('signage_items').findOne({ _id });
  if (!doc) return res.status(404).json({ error: 'Not found' });
  await database.collection('signage_items').deleteOne({ _id });
  if (SIGNAGE_DIR && doc.file) fs.unlink(path.join(SIGNAGE_DIR, doc.file), () => {});
  res.json({ ok: true });
});

app.post('/api/signage/ticker', async (req, res) => {
  if (!signageAuth(req)) return res.status(401).json({ error: 'Wrong password' });
  const t = (req.body && req.body.ticker) || {}; const ticker = {};
  ['all', ...Object.keys(LOCATIONS)].forEach(k => { if (typeof t[k] === 'string') ticker[k] = t[k].slice(0, 400); });
  const database = await connectDB();
  await database.collection('settings').updateOne({ key: 'signage' }, { $set: { key: 'signage', ticker } }, { upsert: true });
  res.json({ ticker });
});

app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/tv-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv-admin.html')));

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', locations: Object.keys(LOCATIONS), time: new Date().toISOString() });
});

// Checks that a location's Clover merchant ID and API token work, without creating an order.
// GET /api/clover/check?loc=albert-st&password=ADMIN_PASSWORD, or POST { loc, password } (the /admin button).
app.all('/api/clover/check', async (req, res) => {
  const q = req.method === 'POST' ? (req.body || {}) : req.query;
  if (!isAdmin(q.password)) return res.status(401).json({ error: 'Wrong password' });
  const loc = LOCATIONS[q.loc];
  if (!loc) return res.status(400).json({ error: 'Unknown location', locations: Object.keys(LOCATIONS) });
  if (!loc.merchantId) return res.json({ ok: false, merchantId: null, error: 'No merchant ID set for this location' });
  if (!loc.apiToken) return res.json({ ok: false, merchantId: loc.merchantId, error: 'No API token set for this location' });
  try {
    const r = await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}`, { headers: { 'Authorization': `Bearer ${loc.apiToken}` } });
    const d = await r.json().catch(() => ({}));
    res.json({ ok: r.ok, status: r.status, merchantId: loc.merchantId, merchantName: d.name || null, error: r.ok ? null : (d.message || 'Clover rejected the request') });
  } catch (e) { res.json({ ok: false, merchantId: loc.merchantId, error: e.message }); }
});

// ── PUSH ADMIN PANEL ───────────────────────────────────────────
app.get('/push-admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'push-admin.html')); });
app.get('/push-admin.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'push-admin.html')); });
app.get('/sauce-boss-admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'push-admin.html')); });
app.get('/sb-admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'push-admin.html')); });

// ── KITCHEN DISPLAY ────────────────────────────────────────────
app.get('/kitchen', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'kitchen.html')); });
app.get('/kitchen.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'kitchen.html')); });

// ── SAUCE BOSS DASHBOARD ROUTE ─────────────────────────────────
app.get('/dashboard', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/dashboard.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });

// ── PLACE ORDER ────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  const { locationId, orderType, customer, items, notes, subtotal, tax, total, preOrder, openTime, scheduled } = req.body;
  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  if (SEASON_CLOSED.includes(locationId)) return res.status(400).json({ error: `${LOCATIONS[locationId].name} is closed for the season. See ya next summer! Please pick another location.` });
  // Check if location is enabled
  try {
    const database = await connectDB();
    if (database) {
      const statusDoc = await database.collection('settings').findOne({ key: 'location_status' });
      if (effectiveStatus(statusDoc?.status, 'startsOff')[locationId] === false) {
        return res.status(400).json({ error: 'This location is temporarily closed. Please pick another location.' });
      }
      if (orderType === 'delivery') {
        const delDoc = await database.collection('settings').findOne({ key: 'delivery_status' });
        if (effectiveStatus(delDoc?.status, 'startsOff')[locationId] === false) {
          return res.status(400).json({ error: 'Delivery is turned off at this location right now. Please choose pickup.' });
        }
      }
    }
  } catch (e) { /* fail-open if DB check fails */ }
  if (!customer?.firstName || !customer?.phone) return res.status(400).json({ error: 'Missing customer info' });
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });
  // Items staff marked sold out today at this store can't be ordered
  try {
    const gone = (await getLiveSettings()).soldOut[locationId] || [];
    const hit = items.filter(i => i && i.id && gone.includes(String(i.id)));
    if (hit.length) return res.status(409).json({ error: `Sorry, ${hit.map(i => i.name).join(', ')} ${hit.length > 1 ? 'are' : 'is'} sold out at this location today. Please remove ${hit.length > 1 ? 'them' : 'it'} from your cart.`, soldOut: hit.map(i => i.id) });
  } catch (e) { /* fail-open */ }
  const waitMins = await waitMinsFor(locationId);

  const loc = LOCATIONS[locationId];
  const orderNum = 'WO-' + String(Math.floor(1000 + Math.random() * 9000));
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: locTz(loc) });

  // ── FIRST-ORDER DISCOUNT VALIDATION ────────────────────────
  let discountApplied = 0;
  let discountValidated = false;
  if (req.body.discountRequested === 'first-order') {
    const eligibleFirstOrder = await isFirstOrder(customer.phone);
    const subtotalNum = Number(subtotal) || 0;
    if (eligibleFirstOrder && subtotalNum >= FIRST_ORDER_MIN_SUBTOTAL) {
      discountApplied = Math.round(subtotalNum * FIRST_ORDER_DISCOUNT_PCT * 100) / 100;
      discountValidated = true;
      console.log(`🎉 First-order discount applied: $${discountApplied.toFixed(2)} for ${customer.phone}`);
    } else {
      console.log(`⚠️ Discount denied for ${customer.phone}: eligible=${eligibleFirstOrder}, subtotal=$${subtotalNum}, min=$${FIRST_ORDER_MIN_SUBTOTAL}`);
    }
  }

  // ── CONTEST WINNER REDEMPTION CHECK ────────────────────────
  let contestRedemption = null;
  try {
    const phoneNorm = String(customer.phone || '').replace(/\D/g, '');
    const subtotalForContest = Number(subtotal) || 0;
    if (typeof checkContestRedemption === 'function') {
      const r = await checkContestRedemption(phoneNorm, locationId, subtotalForContest);
      if (r.applies) {
        contestRedemption = r;
        console.log(`🏆 CONTEST WINNER REDEMPTION: ${r.winner_name} (${phoneNorm}) — discount $${r.discount_amount.toFixed(2)} at ${loc.name}`);
      }
    }
  } catch (e) { console.warn('Contest redemption check failed:', e.message); }

  // ── HALLOWEEN GHOST HUNT FREE FRIES ────────────────────────
  let ghostHuntFries = false, ghostHuntDenied = null;
  const ghostPhone = String(customer.phone || '').replace(/\D/g, '');
  const ghostSeason = ghostHuntSeason();
  if (req.body.ghostHunt === 'fries') {
    try {
      if (!ghostSeason.active) ghostHuntDenied = 'season-over';
      else if (discountValidated) ghostHuntDenied = 'first-order-discount';  // doesn't stack with 15% off — fries stay saved
      else if ((Number(subtotal) || 0) < GHOST_HUNT_MIN_SUBTOTAL) ghostHuntDenied = 'below-minimum';
      else if (ghostPhone.length < 10) ghostHuntDenied = 'invalid-phone';
      else if (await ghostHuntRedeemed(ghostPhone, ghostSeason.year)) ghostHuntDenied = 'already-redeemed';
      else ghostHuntFries = true;
    } catch (e) { ghostHuntDenied = 'error'; console.warn('Ghost hunt check failed:', e.message); }
    if (ghostHuntFries) {
      items.push({ ...GHOST_HUNT_FRIES_ITEM });
      console.log(`🎃 Ghost Hunt free fries added for ${ghostPhone}`);
    } else {
      console.log(`⚠️ Ghost Hunt fries denied for ${ghostPhone}: ${ghostHuntDenied}`);
    }
  }

  console.log(`\n[${timestamp}] Order ${orderNum} for ${customer.firstName} at ${loc.name}`);

  // ── PRICE THE ORDER HERE so Clover, the emails and Mongo all show the discounted total ──
  // Late night 10% is worked out in the browser (only some items qualify); cap it at 10% of the subtotal.
  // The first-order 15% is the server-validated amount above.
  const round2 = n => Math.round(n * 100) / 100;
  const subNum = Number(subtotal) || 0;
  const lateNightOff = round2(Math.min(Math.max(Number(req.body.discount) || 0, 0), subNum * 0.10));
  const discounts = [];
  if (lateNightOff > 0) discounts.push({ name: 'Late Night 10% Off', amount: lateNightOff });
  if (discountApplied > 0) discounts.push({ name: 'First Order 15% Off', amount: discountApplied });
  const discountSum = round2(discounts.reduce((s, d) => s + d.amount, 0));
  const taxable = Math.max(0, round2(subNum - discountSum));
  const gstAmt = round2(taxable * 0.05);
  const pstAmt = round2(taxable * locPst(loc));
  const delFeeAmt = orderType === 'delivery' ? 5.50 : 0;
  const finalTax = round2(gstAmt + pstAmt);
  const finalTotal = round2(taxable + finalTax + delFeeAmt);
  const discountRowsHtml = (style) => discounts.map(d => `<div style="${style}"><span>${d.name}</span><span>−$${d.amount.toFixed(2)}</span></div>`).join('');

  // ── PAY ONLINE (stores with card payments on) ──
  const payToken = req.body.payment && typeof req.body.payment.token === 'string' ? req.body.payment.token.trim() : '';
  const payOnline = !!payToken;
  if (payOnline) {
    if (!payReady(loc)) return res.status(400).json({ paymentFailed: true, error: `Paying online isn't available at ${loc.name} right now, and nothing was charged. Please choose Pay at ${orderType === 'delivery' ? 'delivery' : 'pickup'}.` });
    // Never charge more than the total the customer was shown
    const shown = Number(req.body.payTotal);
    if (!(shown >= finalTotal - 0.01)) return res.status(409).json({ paymentFailed: true, priceChanged: true, total: finalTotal.toFixed(2),
      error: `Your total is $${finalTotal.toFixed(2)}${discountApplied > 0 || !req.body.discountRequested ? '' : ' (the first-order discount didn\'t apply)'}. Nothing was charged. Tap the button again to pay $${finalTotal.toFixed(2)}.` });
  }
  const payFail = (status, error, extra = {}) => res.status(status).json({ paymentFailed: true, error, ...extra });

  let cloverId = null, cloverSuccess = false;
  try {
    cloverId = await createCloverOrder(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp, discounts, { print: !payOnline });
    cloverSuccess = !!cloverId;
  } catch (e) { console.error('Clover error:', e.message); }

  let payment = null;
  if (payOnline) {
    const storeLine = `call the store at ${loc.phone}`;
    if (!cloverId) return payFail(502, `We couldn't reach the store's card system, so nothing was charged. Try again in a minute, or choose Pay at ${orderType === 'delivery' ? 'delivery' : 'pickup'}.`);
    const wantCents = Math.round(finalTotal * 100);
    const haveCents = await cloverOrderTotal(loc, cloverId);
    if (haveCents === null || Math.abs(haveCents - wantCents) > 5) {
      console.warn(`💳 Not charging ${orderNum}: Clover total ${haveCents} vs ours ${wantCents} cents`);
      await deleteCloverOrder(loc, cloverId);
      return payFail(502, `We couldn't set up the card payment, so nothing was charged. Please choose Pay at ${orderType === 'delivery' ? 'delivery' : 'pickup'}.`);
    }
    const pay = await payCloverOrder(loc, cloverId, payToken, customer.email, clientIp(req));
    if (!pay.ok && pay.unknown) {
      alertOwner(`💳 Card payment for ${orderNum} at ${loc.name} needs checking`,
        `<p>${escHtml(customer.firstName)} (<a href="tel:${escHtml(customer.phone)}">${escHtml(customer.phone)}</a>) tried to pay <b>$${finalTotal.toFixed(2)}</b> online for order <b>${escHtml(orderNum)}</b>, but Clover didn't give a clear answer (${escHtml(pay.message)}).</p>
         <p><b>What to do:</b> in Clover, look at the order and the Transactions list. If it was paid, print the order and start cooking. If not, call the customer. The customer was told to call the store.</p>`);
      return payFail(502, `We couldn't confirm your payment. Please don't order again yet: ${storeLine} and we'll sort it out.`, { orderNum });
    }
    if (!pay.ok) {
      await deleteCloverOrder(loc, cloverId);
      return payFail(402, `${pay.declined ? 'Your card was declined' : 'The payment didn\'t go through'}: ${pay.message}. Nothing was charged. Try another card, or choose Pay at ${orderType === 'delivery' ? 'delivery' : 'pickup'}.`);
    }
    payment = { status: 'paid', method: 'card-online', amount: Math.round(pay.amount) / 100, chargeId: pay.charge, brand: pay.brand, last4: pay.last4, paidAt: new Date() };
    if (Math.abs(pay.amount - wantCents) > 5) alertOwner(`💳 Order ${orderNum} was charged $${(pay.amount / 100).toFixed(2)}, not $${finalTotal.toFixed(2)}`,
      `<p>Check order <b>${escHtml(orderNum)}</b> in Clover at ${escHtml(loc.name)}: the card was charged a different amount than the website total.</p>`);
    // Receipt printers can't print emoji, so plain text only
    await markCloverOrderPaid(loc, cloverId, `$${payment.amount.toFixed(2)}${payment.last4 ? ` ${payment.brand || 'card'} ${payment.last4}` : ''} - do not charge again`);
    await printCloverOrder(loc, cloverId, orderNum);
  }
  const paidLabel = payment ? `✅ PAID ONLINE${payment.last4 ? ` — ${escHtml(payment.brand || 'card')} ••${escHtml(payment.last4)}` : ''}` : '';

  let savedForKitchen = false;
  try {
    const database = await connectDB();
    if (database) {
      await database.collection('orders').insertOne({
        orderNum, locationId, locationName: loc.name, orderType,
        customer: {
          firstName: customer.firstName, lastName: customer.lastName || '',
          phone: customer.phone, email: customer.email || '', address: customer.address || ''
        },
        items: items.map(i => ({ name: i.name, flavor: i.flavor || '', price: i.price, qty: i.qty })),
        notes: (ghostHuntFries ? '🎃 GHOST HUNT — FREE SMALL FRIES · ' : '') + (contestRedemption
          ? ('🏆 FREE WINGS WINNER · ' + contestRedemption.label + ' · ' + (notes || ''))
          : (notes || '')),
        subtotal: Number(subtotal), tax: finalTax, total: finalTotal, discounts,
        preOrder: !!preOrder, openTime: openTime || null, cloverId, cloverSuccess,
        paidOnline: !!payment, payment,
        firstOrderDiscount: discountApplied, discountValidated,
        contestRedemption: contestRedemption || null,
        ghostHuntPhone: ghostHuntFries ? ghostPhone : null,
        ghostHuntYear: ghostHuntFries ? ghostSeason.year : null,
        kitchenStatus: 'pending', createdAt: new Date(),
        // Google review request email goes out later (see REVIEW REQUESTS); only for customers who gave an email
        reviewDueAt: (customer.email && String(customer.email).includes('@')) ? reviewDueTime(new Date(), !!preOrder) : null
      });
      console.log(`✓ Order ${orderNum} saved to Mongo`);
      savedForKitchen = true;
    }
  } catch (e) { console.warn('Order save to Mongo failed:', e.message); }
  if (!savedForKitchen) alertOwner(`Order ${orderNum} at ${loc.name} was not saved for the kitchen screen`,
    `<p>Order <b>${escHtml(orderNum)}</b> (${escHtml(customer.firstName)}, <a href="tel:${escHtml(customer.phone)}">${escHtml(customer.phone)}</a>) could not be saved to the database, so it won't show on the kitchen screen, in Customers or on the loyalty card.</p>
     <p>${cloverSuccess ? 'It <b>did</b> reach Clover, so the store has it.' : 'It also did <b>not</b> reach Clover. See the other alert.'}</p>`);

  const stampResult = await autoAddStamp(customer.phone, orderNum, customer.firstName);

  // If Clover didn't get the order, this email IS the alert: urgent subject + red banner, so nobody misses it.
  const cloverFailBanner = cloverSuccess ? '' : `<div style="background:#E8190A;color:#fff;padding:16px 18px;font-size:16px;line-height:1.5;">
      <b>⚠️ THIS ORDER DID NOT REACH CLOVER at ${loc.name}.</b><br>
      The customer has been told it's confirmed. Call the store (${escHtml(loc.phone)}) now so they ring it into the POS and start cooking,
      or call the customer at <a href="tel:${escHtml(customer.phone)}" style="color:#fff;">${escHtml(customer.phone)}</a>.</div>`;
  sendEmail({
    to: 'besaucy@wingorestaurants.com',
    subject: `${cloverSuccess ? '' : '🚨 NOT IN CLOVER: '}${preOrder ? '⏰ PRE-ORDER' : '🍗 New Order'} ${orderNum} — ${loc.name} — $${finalTotal.toFixed(2)}${payment ? ' — PAID' : ''}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">${cloverFailBanner}
      <div style="background:#0D0D0D;padding:20px;text-align:center;"><h1 style="color:#E8190A;font-size:28px;margin:0;">WING-O</h1><p style="color:#888;margin:4px 0 0;font-size:12px;letter-spacing:2px;">${preOrder ? '⏰ PRE-ORDER' : 'New Online Order'}</p></div>
      <div style="background:#F5F0E8;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Order #</td><td style="padding:6px 0;font-weight:bold;font-size:16px;color:#E8190A;">${orderNum}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Location</td><td style="padding:6px 0;font-weight:bold;">${loc.name}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Type</td><td style="padding:6px 0;">${orderType === 'delivery' ? '🛵 Delivery' : '🏃 Pickup'}${preOrder ? ' <span style="background:#F5A800;color:#000;padding:2px 8px;border-radius:3px;font-size:11px;">PRE-ORDER — ' + (scheduled ? 'for ' : 'opens ') + escHtml(openTime) + '</span>' : ''}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Time</td><td style="padding:6px 0;">${timestamp}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Name</td><td style="padding:6px 0;">${customer.firstName} ${customer.lastName || ''}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Phone</td><td style="padding:6px 0;"><a href="tel:${customer.phone}" style="color:#E8190A;">${customer.phone}</a></td></tr>
          ${customer.email ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Email</td><td>${customer.email}</td></tr>` : ''}
          ${orderType === 'delivery' ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Address</td><td style="padding:6px 0;">${customer.address}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Payment</td><td style="padding:6px 0;color:${payment ? '#2D8A3E' : '#F5A800'};font-weight:bold;">${payment ? paidLabel : `💰 PAY AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}`}</td></tr>
          ${stampResult ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Loyalty</td><td style="padding:6px 0;color:#F5A800;">🍗 Stamp #${stampResult.totalOrders} added${stampResult.gotFree ? ' — 🎉 FREE WINGS EARNED!' : ''}</td></tr>` : ''}
        </table>
        <hr style="border:1px solid #E8E0D0;margin:16px 0;">
        ${items.map(i => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #E8E0D0;"><div><div style="font-weight:bold;font-size:14px;">${i.name} x${i.qty}</div>${i.flavor ? `<div style="color:#E8190A;font-size:12px;">${i.flavor}</div>` : ''}</div><div style="font-weight:bold;">$${(i.price * i.qty).toFixed(2)}</div></div>`).join('')}
        <div style="margin-top:12px;">
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>Subtotal</span><span>$${Number(subtotal).toFixed(2)}</span></div>
          ${discountRowsHtml('display:flex;justify-content:space-between;padding:4px 0;color:#2D8A3E;font-size:13px;font-weight:bold;')}
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>GST (5%)</span><span>$${gstAmt.toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>${pstLabel(loc)}</span><span>$${pstAmt.toFixed(2)}</span></div>
          ${delFeeAmt > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>Delivery</span><span>$${delFeeAmt.toFixed(2)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:bold;font-size:18px;border-top:2px solid #0D0D0D;margin-top:8px;"><span>${payment ? 'TOTAL PAID ONLINE' : `TOTAL DUE AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}`}</span><span style="color:#E8190A;">$${finalTotal.toFixed(2)}</span></div>
        </div>
        ${notes ? `<div style="background:#FFF8EE;border:1px solid #F5D98A;border-radius:6px;padding:10px;margin-top:12px;"><strong>Notes:</strong> ${notes}</div>` : ''}
      </div>
    </div>`
  });

  // ── CUSTOMER CONFIRMATION EMAIL ─────────────────────────────
  // Fires only if customer provided their email at checkout
  if (customer.email && customer.email.includes('@')) {
    const etaText = preOrder
      ? (scheduled
          ? `Your pre-order is booked for <strong>${escHtml(openTime)}</strong>. We'll have it ${orderType === 'delivery' ? 'on its way' : 'ready'} then.`
          : `Since we're closed right now, your order will be prepared when we open at <strong>${escHtml(openTime)}</strong>.`)
      : (orderType === 'delivery'
          ? `Should be at your door in about <strong>${waitMins + 15}–${waitMins + 30} minutes</strong>.`
          : `Should be ready in about <strong>${waitMins} minutes</strong>.`);
    const whatsNext = orderType === 'delivery'
      ? `Sit tight — your food is being prepared.${payment ? ' It\'s already paid.' : ' Have cash or card ready for the driver.'}`
      : `Come pick up at <strong style="color:#F5A800;">${loc.address}</strong>. Look for the Wing-O logo.`;
    const tipAmt = Number(req.body.tip || 0);
    const delFee = orderType === 'delivery' ? 5.50 : 0;

    sendEmail({
      to: customer.email,
      subject: `🍗 Order Confirmed — ${orderNum} · Wing-O Restaurants`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F4EBD7;">
        <div style="background:#0D0D0D;padding:24px;text-align:center;border-bottom:3px double #F5A800;">
          <h1 style="color:#E8190A;font-size:32px;margin:0;letter-spacing:2px;font-weight:900;">WING<span style="color:white;">-O</span></h1>
          <p style="color:#F5A800;margin:8px 0 0;font-size:12px;letter-spacing:3px;">${preOrder ? '⏰ PRE-ORDER CONFIRMED' : '✅ ORDER CONFIRMED'}</p>
        </div>

        <div style="padding:28px 24px;">
          <p style="font-size:18px;color:#1A1208;margin:0 0 6px;font-weight:bold;">Hey ${customer.firstName}! 👋</p>
          <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 20px;">Thanks for ordering with Wing-O. Your ${orderType === 'delivery' ? 'delivery' : 'pickup'} order is confirmed and heading to the kitchen. ${etaText}</p>

          <div style="background:white;border:1px solid #C8B89A;border-radius:8px;padding:18px 20px;margin-bottom:16px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:4px 0;color:#888;font-size:11px;letter-spacing:1.5px;">ORDER #</td><td style="padding:4px 0;font-weight:bold;font-size:20px;color:#E8190A;text-align:right;font-family:Arial;">${orderNum}</td></tr>
              <tr><td style="padding:4px 0;color:#888;font-size:11px;letter-spacing:1.5px;">LOCATION</td><td style="padding:4px 0;font-weight:bold;text-align:right;">${loc.name}</td></tr>
              <tr><td style="padding:4px 0;color:#888;font-size:11px;letter-spacing:1.5px;">${orderType === 'delivery' ? 'DELIVER TO' : 'PICKUP AT'}</td><td style="padding:4px 0;text-align:right;font-size:13px;">${orderType === 'delivery' ? customer.address : loc.address}</td></tr>
              <tr><td style="padding:4px 0;color:#888;font-size:11px;letter-spacing:1.5px;">${orderType === 'delivery' ? 'CALL US' : 'STORE PHONE'}</td><td style="padding:4px 0;text-align:right;"><a href="tel:${loc.phone.replace(/\D/g, '')}" style="color:#E8190A;text-decoration:none;font-weight:bold;">${loc.phone}</a></td></tr>
            </table>
          </div>

          <div style="background:white;border:1px solid #C8B89A;border-radius:8px;padding:18px 20px;margin-bottom:16px;">
            <div style="font-size:11px;color:#888;letter-spacing:2px;margin-bottom:12px;font-weight:bold;">YOUR ORDER</div>
            ${items.map(i => `<div style="padding:10px 0;border-bottom:1px solid #E8DCC1;"><div style="display:flex;justify-content:space-between;align-items:flex-start;"><div style="flex:1;"><div style="font-weight:bold;font-size:14px;color:#1A1208;">${i.name} <span style="color:#888;font-weight:normal;">×${i.qty}</span></div>${i.flavor ? `<div style="color:#E8190A;font-size:12px;margin-top:3px;">${i.flavor}</div>` : ''}</div><div style="font-weight:bold;color:#1A1208;font-size:14px;margin-left:12px;">$${(i.price * i.qty).toFixed(2)}</div></div></div>`).join('')}
            <div style="padding-top:14px;">
              <div style="display:flex;justify-content:space-between;padding:3px 0;color:#666;font-size:13px;"><span>Subtotal</span><span>$${Number(subtotal).toFixed(2)}</span></div>
              ${discountRowsHtml('display:flex;justify-content:space-between;padding:3px 0;color:#2D8A3E;font-size:13px;font-weight:bold;')}
              <div style="display:flex;justify-content:space-between;padding:3px 0;color:#666;font-size:13px;"><span>Tax (GST + PST)</span><span>$${finalTax.toFixed(2)}</span></div>
              ${delFee > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#666;font-size:13px;"><span>Delivery</span><span>$${delFee.toFixed(2)}</span></div>` : ''}
              ${tipAmt > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#2D8A3E;font-size:13px;font-weight:bold;"><span>💸 Tip</span><span>$${tipAmt.toFixed(2)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between;padding:10px 0 4px;font-weight:bold;font-size:18px;border-top:2px solid #1A1208;margin-top:8px;"><span>TOTAL</span><span style="color:#E8190A;">$${finalTotal.toFixed(2)}</span></div>
              <div style="text-align:center;font-size:11px;color:#F5A800;letter-spacing:2px;margin-top:8px;font-weight:bold;">${payment ? paidLabel : `💰 PAY AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}`}</div>
            </div>
          </div>

          <div style="background:#0D0D0D;color:white;padding:18px 20px;border-radius:8px;text-align:center;margin-bottom:20px;">
            <div style="font-size:11px;color:#F5A800;letter-spacing:2.5px;margin-bottom:8px;font-weight:bold;">WHAT'S NEXT?</div>
            <div style="font-size:14px;line-height:1.6;">${whatsNext}</div>
          </div>

          ${notes ? `<div style="background:#FFF8EE;border-left:4px solid #F5A800;border-radius:6px;padding:12px 14px;margin-bottom:16px;font-size:13px;color:#555;"><strong style="color:#1A1208;">Your note to kitchen:</strong> ${notes}</div>` : ''}

          <div style="text-align:center;padding:12px 0 20px;font-size:13px;color:#666;line-height:1.7;">
            Questions or need to change something?<br>
            <a href="tel:${loc.phone.replace(/\D/g, '')}" style="color:#E8190A;text-decoration:none;font-weight:bold;">📞 ${loc.phone}</a>
            &nbsp;·&nbsp;
            <a href="mailto:besaucy@wingorestaurants.com" style="color:#E8190A;text-decoration:none;font-weight:bold;">📧 Email us</a>
          </div>
        </div>

        <div style="background:#0D0D0D;padding:22px 20px;text-align:center;">
          <p style="color:#F5A800;font-family:Georgia,serif;font-style:italic;font-size:14px;margin:0 0 8px;">— The Sauce Boss 🌾</p>
          <p style="color:#666;font-size:10px;letter-spacing:2px;margin:0 0 4px;">PROUDLY PRAIRIE · REGINA, SASKATCHEWAN</p>
          <p style="margin:6px 0 0;"><a href="https://wingorestaurants.com" style="color:#F5A800;text-decoration:none;font-size:11px;letter-spacing:1px;">wingorestaurants.com</a></p>
        </div>
      </div>`
    });
  }

  res.json({
    success: true, orderNum, cloverId, cloverSuccess,
    message: cloverSuccess ? `Order sent to ${loc.name} kitchen!` : 'Order recorded!',
    customer: customer.firstName, total: finalTotal.toFixed(2),
    phone: customer.phone, orderType, location: loc.name,
    stampAdded: !!stampResult, gotFreeWings: stampResult?.gotFree || false, loyaltyStamps: stampResult?.stamps,
    discountApplied, discountValidated,
    ghostHuntFries, ghostHuntDenied,
    paid: !!payment, paidAmount: payment ? payment.amount.toFixed(2) : null, cardLast4: payment ? payment.last4 : null
  });
});

// ── KITCHEN API ────────────────────────────────────────────────
app.get('/api/kitchen/auth', (req, res) => {
  const { loc, pw } = req.query;
  if (checkKitchenAuth(loc, pw)) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

app.get('/api/kitchen/orders', async (req, res) => {
  const { loc, pw } = req.query;
  if (!checkKitchenAuth(loc, pw)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const database = await connectDB();
    if (!database) return res.json({ pending: [], progress: [] });
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const orders = await database.collection('orders').find({
      locationId: loc,
      kitchenStatus: { $in: ['pending', 'progress'] },
      createdAt: { $gte: cutoff }
    }).sort({ createdAt: 1 }).toArray();
    const now = Date.now();
    const formatted = orders.map(o => ({
      id: o._id.toString(), orderNum: o.orderNum,
      customer: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' ') || 'Customer',
      phone: o.customer?.phone || '', address: o.customer?.address || '',
      orderType: o.orderType || 'pickup', items: o.items || [], notes: o.notes || '',
      paidOnline: !!o.paidOnline, total: o.total,
      kitchenStatus: o.kitchenStatus || 'pending',
      readyNotifiedAt: o.readyNotifiedAt ? o.readyNotifiedAt.toISOString() : null,
      timeAgo: formatTimeAgo(now - new Date(o.createdAt).getTime())
    }));
    res.json({
      build: BUILD_ID,
      pending:  formatted.filter(o => o.kitchenStatus === 'pending'),
      progress: formatted.filter(o => o.kitchenStatus === 'progress')
    });
  } catch (e) {
    console.error('[kitchen] fetch error', e.message);
    res.status(500).json({ error: 'server error', pending: [], progress: [] });
  }
});

function formatTimeAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Just now';
  if (mins === 1) return '1 min ago';
  if (mins < 60) return mins + ' mins ago';
  const hrs = Math.floor(mins / 60);
  return hrs + ' hr' + (hrs > 1 ? 's' : '') + ' ago';
}

app.post('/api/kitchen/order/:id/status', async (req, res) => {
  const { loc, pw, status } = req.body;
  if (!checkKitchenAuth(loc, pw)) return res.status(401).json({ error: 'unauthorized' });
  if (!['pending', 'progress', 'complete'].includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'db unavailable' });
    await database.collection('orders').updateOne(
      { _id: new ObjectId(req.params.id), locationId: loc },
      { $set: { kitchenStatus: status, [`kitchenStatus_${status}_at`]: new Date() } }
    );
    console.log(`[kitchen] ${loc} → order ${req.params.id} → ${status}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[kitchen] status update error', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── NOTIFY CUSTOMER READY / OUT-FOR-DELIVERY ────────────────
// Called from kitchen display "🔥 Notify Ready" button.
// Fires customer email but does NOT change order status.
// Can be called multiple times if kitchen needs to re-notify.
// ══════════ CATERING / CORPORATE ORDERS ══════════
// Receives a built catering request from /catering.html, stores it,
// emails the owner, and sends the customer a confirmation copy.
app.post('/api/catering', async (req, res) => {
  try {
    const b = req.body || {};
    const c = b.customer || {};
    if (!c.firstName || !c.phone || !c.email) {
      return res.status(400).json({ error: 'missing required fields' });
    }

    const refNum = 'WC-' + Date.now().toString().slice(-6);
    const loc = LOCATIONS[b.locationId] || { name: b.locationId || 'Albert Street', phone: '639-997-0553', address: '' } // TEMP phone;
    const isDelivery = b.fulfilment === 'delivery';
    const flavours = Array.isArray(b.flavours) ? b.flavours : [];
    const addons = Array.isArray(b.addons) ? b.addons : [];

    const billLabel = {
      card:    'Pay in full on pickup/delivery (card or cash)',
      deposit: '50% DEPOSIT NOW — balance on pickup/delivery',
      po:      'COMPANY CARD / PO ON FILE'
    }[b.billing] || 'Pay in full on pickup/delivery';

    let whenStr = b.date || '';
    try {
      const d = new Date(b.date + 'T' + (b.time || '12:00'));
      whenStr = d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
              + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch (e) { /* fall back to raw date string */ }

    // Persist if the DB is up; never block the response on it
    try {
      const database = await connectDB();
      if (database) {
        await database.collection('catering').insertOne({
          refNum, ...b, status: 'new', createdAt: new Date()
        });
      }
    } catch (e) {
      console.error('[catering] db insert failed:', e.message);
    }

    const addonRows = addons.length
      ? addons.map(a => `<tr><td style="padding:4px 0;">${a.name} × ${a.qty}</td><td style="padding:4px 0;text-align:right;">$${Number(a.total).toFixed(2)}</td></tr>`).join('')
      : '<tr><td style="padding:4px 0;color:#888;" colspan="2">None</td></tr>';

    // ── Owner notification ──
    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🍽️ CATERING REQUEST ${refNum} — ${b.headcount} guests — ${whenStr}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;background:#F4EBD7;">
        <div style="background:#0D0D0D;padding:20px;text-align:center;border-bottom:3px double #F5A800;">
          <h1 style="color:#E8190A;font-size:26px;margin:0;letter-spacing:2px;">WING<span style="color:#fff;">-O</span> CATERING</h1>
          <p style="color:#F5A800;margin:6px 0 0;font-size:12px;letter-spacing:3px;">NEW REQUEST · ${refNum}</p>
        </div>
        <div style="padding:22px;">
          <div style="background:#E8190A;color:#fff;padding:14px;border-radius:6px;text-align:center;margin-bottom:16px;">
            <div style="font-size:11px;letter-spacing:2px;">NEEDED</div>
            <div style="font-size:19px;font-weight:bold;margin-top:3px;">${whenStr}</div>
            <div style="font-size:13px;margin-top:5px;">${isDelivery ? '🛵 DELIVERY — ' + (b.address || '') : '🏃 PICKUP — ' + loc.name}</div>
          </div>

          <div style="background:#fff;border:1px solid #C8B89A;border-radius:6px;padding:16px;margin-bottom:14px;">
            <div style="font-size:11px;color:#888;letter-spacing:2px;margin-bottom:8px;">CUSTOMER</div>
            <div style="font-size:17px;font-weight:bold;">${c.firstName} ${c.lastName || ''}</div>
            ${c.company ? `<div style="color:#E8190A;font-weight:bold;font-size:14px;margin-top:2px;">${c.company}</div>` : ''}
            <div style="margin-top:8px;font-size:14px;">
              📞 <a href="tel:${String(c.phone).replace(/\D/g, '')}" style="color:#E8190A;font-weight:bold;">${c.phone}</a><br>
              📧 <a href="mailto:${c.email}" style="color:#E8190A;">${c.email}</a>
            </div>
          </div>

          <div style="background:#fff;border:1px solid #C8B89A;border-radius:6px;padding:16px;margin-bottom:14px;">
            <div style="font-size:11px;color:#888;letter-spacing:2px;margin-bottom:8px;">ORDER</div>
            <div style="font-size:18px;font-weight:bold;color:#1A1208;">${b.package} · ${b.headcount} guests</div>
            ${b.wingStyle ? `<div style="margin-top:6px;padding:6px 10px;background:#FFF8EE;border:1px solid #F5D98A;border-radius:4px;font-size:14px;"><strong>🍗 ${b.wingOrders || ''} orders — ${b.wingStyle} wings</strong></div>` : ''}
            ${b.occasion ? `<div style="font-size:13px;color:#666;margin-top:6px;">Occasion: ${b.occasion}</div>` : ''}
            <div style="margin-top:10px;font-size:14px;"><strong>Flavours (${flavours.length}):</strong><br>${flavours.join(' · ') || '—'}</div>
            <div style="margin-top:12px;font-size:14px;"><strong>Add-ons:</strong></div>
            <table style="width:100%;font-size:14px;margin-top:4px;">${addonRows}</table>
          </div>

          <div style="background:#fff;border:1px solid #C8B89A;border-radius:6px;padding:16px;margin-bottom:14px;">
            <table style="width:100%;font-size:14px;">
              <tr><td style="padding:3px 0;color:#666;">Subtotal</td><td style="padding:3px 0;text-align:right;">$${Number(b.subtotal || 0).toFixed(2)}</td></tr>
              <tr><td style="padding:3px 0;color:#666;">Tax</td><td style="padding:3px 0;text-align:right;">$${Number(b.tax || 0).toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0 0;font-weight:bold;font-size:18px;border-top:2px solid #1A1208;">TOTAL</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;font-size:18px;color:#E8190A;border-top:2px solid #1A1208;">$${Number(b.total || 0).toFixed(2)}</td></tr>
            </table>
            <div style="margin-top:10px;padding:8px;background:#FFF8EE;border:1px solid #F5D98A;border-radius:4px;font-size:13px;text-align:center;"><strong>Billing:</strong> ${billLabel}</div>
          </div>

          ${b.notes ? `<div style="background:#FFF8EE;border-left:4px solid #F5A800;border-radius:6px;padding:12px 14px;font-size:14px;"><strong>Notes:</strong> ${b.notes}</div>` : ''}

          <div style="text-align:center;margin-top:18px;padding:12px;background:#0D0D0D;border-radius:6px;color:#F5A800;font-size:13px;letter-spacing:1px;">
            ⏰ CALL TO CONFIRM WITHIN 4 BUSINESS HOURS
          </div>
        </div>
      </div>`
    });

    // ── Customer confirmation ──
    sendEmail({
      to: c.email,
      subject: `🍗 Catering Request Received — ${refNum} · Wing-O`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F4EBD7;">
        <div style="background:#0D0D0D;padding:24px;text-align:center;border-bottom:3px double #F5A800;">
          <h1 style="color:#E8190A;font-size:30px;margin:0;letter-spacing:2px;font-weight:900;">WING<span style="color:#fff;">-O</span></h1>
          <p style="color:#F5A800;margin:8px 0 0;font-size:12px;letter-spacing:3px;">CATERING REQUEST RECEIVED</p>
        </div>
        <div style="padding:26px 24px;">
          <p style="font-size:18px;font-weight:bold;margin:0 0 6px;">Hey ${c.firstName}! 👋</p>
          <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 18px;">Thanks for choosing WingO to feed your crew. We've got your request and someone from our team will call you within <strong>4 business hours</strong> to confirm the details and lock it in. Nothing is charged until we've spoken.</p>

          <div style="background:#fff;border:1px solid #C8B89A;border-radius:8px;padding:16px 18px;margin-bottom:14px;text-align:center;">
            <div style="font-size:10px;color:#888;letter-spacing:2px;">REFERENCE #</div>
            <div style="font-size:24px;color:#E8190A;font-weight:900;letter-spacing:2px;">${refNum}</div>
          </div>

          <div style="background:#fff;border:1px solid #C8B89A;border-radius:8px;padding:18px;margin-bottom:14px;">
            <table style="width:100%;font-size:14px;">
              <tr><td style="padding:5px 0;color:#888;font-size:11px;letter-spacing:1.5px;">PACKAGE</td><td style="padding:5px 0;text-align:right;font-weight:bold;">${b.package}</td></tr>
              <tr><td style="padding:5px 0;color:#888;font-size:11px;letter-spacing:1.5px;">GUESTS</td><td style="padding:5px 0;text-align:right;font-weight:bold;">${b.headcount}</td></tr>
              <tr><td style="padding:5px 0;color:#888;font-size:11px;letter-spacing:1.5px;">WHEN</td><td style="padding:5px 0;text-align:right;font-weight:bold;">${whenStr}</td></tr>
              <tr><td style="padding:5px 0;color:#888;font-size:11px;letter-spacing:1.5px;">${isDelivery ? 'DELIVER TO' : 'PICKUP AT'}</td><td style="padding:5px 0;text-align:right;font-size:13px;">${isDelivery ? (b.address || '') : loc.name}</td></tr>
            </table>
            ${b.wingStyle ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #E8DCC1;font-size:14px;"><strong>Wings:</strong> ${b.wingOrders || ''} orders — ${b.wingStyle}</div>` : ''}
            ${addons.length ? `<div style="margin-top:10px;font-size:14px;"><strong>Also included:</strong><br><span style="color:#666;">${addons.map(a=>a.name).join('<br>')}</span></div>` : ''}
            <div style="margin-top:12px;padding-top:12px;border-top:2px solid #1A1208;display:flex;justify-content:space-between;font-size:18px;font-weight:bold;">
              <span>Estimated Total</span><span style="color:#E8190A;">$${Number(b.total || 0).toFixed(2)}</span>
            </div>
            <div style="font-size:11px;color:#888;text-align:center;margin-top:6px;">Final total confirmed on our call</div>
          </div>

          <div style="text-align:center;padding:12px 0;font-size:13px;color:#666;line-height:1.7;">
            Need to change something before we call?<br>
            <a href="tel:${String(loc.phone || '6399970553').replace(/\D/g, '')}" style="color:#E8190A;text-decoration:none;font-weight:bold;">📞 ${loc.phone || '639-997-0553'}</a>
            &nbsp;·&nbsp;
            <a href="mailto:besaucy@wingorestaurants.com" style="color:#E8190A;text-decoration:none;font-weight:bold;">📧 Email us</a>
          </div>
        </div>
        <div style="background:#0D0D0D;padding:22px 20px;text-align:center;">
          <p style="color:#F5A800;font-family:Georgia,serif;font-style:italic;font-size:14px;margin:0 0 8px;">— The Sauce Boss 🌾</p>
          <p style="color:#666;font-size:10px;letter-spacing:2px;margin:0;">PROUDLY PRAIRIE · REGINA, SASKATCHEWAN</p>
        </div>
      </div>`
    });

    console.log(`🍽️ Catering request ${refNum} — ${c.firstName} — ${b.headcount} guests — $${Number(b.total || 0).toFixed(2)}`);
    res.json({ success: true, refNum });
  } catch (e) {
    console.error('[catering] error', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/kitchen/order/:id/notify-ready', async (req, res) => {
  const { loc, pw } = req.body;
  if (!checkKitchenAuth(loc, pw)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'db unavailable' });

    const order = await database.collection('orders').findOne(
      { _id: new ObjectId(req.params.id), locationId: loc }
    );
    if (!order) return res.status(404).json({ error: 'order not found' });

    // No email on file — nothing to send, but return success so button feels responsive
    if (!order.customer?.email || !order.customer.email.includes('@')) {
      console.log(`[kitchen] notify-ready skipped for ${order.orderNum}: no customer email`);
      return res.json({ ok: true, notified: false, reason: 'no-email' });
    }

    const locData = LOCATIONS[loc] || { name: loc, phone: '', address: '' };
    const isDelivery = order.orderType === 'delivery';

    const subject = isDelivery
      ? `🛵 Your WingO is On the Way — ${order.orderNum}`
      : `🍗 Order Ready for Pickup — ${order.orderNum}`;
    const headline = isDelivery ? 'OUT FOR DELIVERY 🛵' : 'READY FOR PICKUP 🍗';
    const headlineColor = isDelivery ? '#F5A800' : '#2D8A3E';
    const bodyIntro = isDelivery
      ? `Your food is packed up and on the way to <strong>${order.customer?.address || 'your address'}</strong>. Have cash or card ready when the driver arrives.`
      : `Your order is hot and ready! Come pick it up at <strong>${locData.name}</strong> — the sooner the better while it's fresh out of the fryer.`;
    const bigInfo = isDelivery
      ? `<div style="background:#0D0D0D;color:white;padding:22px 20px;border-radius:8px;text-align:center;margin-bottom:20px;">
           <div style="font-size:11px;color:#F5A800;letter-spacing:2.5px;margin-bottom:8px;font-weight:bold;">DELIVERING TO</div>
           <div style="font-size:18px;line-height:1.4;font-weight:bold;">${order.customer?.address || ''}</div>
           <div style="font-size:12px;color:#CCC;margin-top:10px;">ETA: 15–25 minutes</div>
         </div>`
      : `<div style="background:#0D0D0D;color:white;padding:22px 20px;border-radius:8px;text-align:center;margin-bottom:20px;">
           <div style="font-size:11px;color:#F5A800;letter-spacing:2.5px;margin-bottom:8px;font-weight:bold;">PICK UP AT</div>
           <div style="font-size:18px;line-height:1.4;font-weight:bold;">${locData.name}</div>
           <div style="font-size:14px;color:#CCC;margin-top:8px;">${locData.address || ''}</div>
           <div style="margin-top:14px;"><a href="tel:${(locData.phone || '').replace(/\D/g, '')}" style="color:#F5A800;text-decoration:none;font-weight:bold;font-size:14px;">📞 ${locData.phone || ''}</a></div>
         </div>`;

    sendEmail({
      to: order.customer.email,
      subject: subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#F4EBD7;">
        <div style="background:#0D0D0D;padding:24px;text-align:center;border-bottom:3px double #F5A800;">
          <h1 style="color:#E8190A;font-size:32px;margin:0;letter-spacing:2px;font-weight:900;">WING<span style="color:white;">-O</span></h1>
          <p style="color:${headlineColor};margin:8px 0 0;font-size:13px;letter-spacing:3px;font-weight:bold;">${headline}</p>
        </div>
        <div style="padding:28px 24px;">
          <p style="font-size:18px;color:#1A1208;margin:0 0 6px;font-weight:bold;">Hey ${order.customer.firstName}! 👋</p>
          <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 20px;">${bodyIntro}</p>
          ${bigInfo}
          <div style="background:white;border:1px solid #C8B89A;border-radius:8px;padding:14px 18px;margin-bottom:16px;text-align:center;">
            <div style="font-size:10px;color:#888;letter-spacing:1.5px;margin-bottom:4px;">ORDER #</div>
            <div style="font-size:24px;color:#E8190A;font-weight:900;letter-spacing:2px;">${order.orderNum}</div>
          </div>
          <div style="text-align:center;padding:12px 0 4px;font-size:13px;color:#666;line-height:1.7;">
            ${isDelivery ? 'Delivery running late or something wrong?' : 'Any issues with your order?'}<br>
            <a href="tel:${(locData.phone || '').replace(/\D/g, '')}" style="color:#E8190A;text-decoration:none;font-weight:bold;">📞 ${locData.phone || ''}</a>
          </div>
        </div>
        <div style="background:#0D0D0D;padding:22px 20px;text-align:center;">
          <p style="color:#F5A800;font-family:Georgia,serif;font-style:italic;font-size:14px;margin:0 0 8px;">— The Sauce Boss 🌾</p>
          <p style="color:#666;font-size:10px;letter-spacing:2px;margin:0;">PROUDLY PRAIRIE · REGINA, SASKATCHEWAN</p>
        </div>
      </div>`
    });

    // Mark notified — kitchen display shows green "✅ Customer notified" tag
    await database.collection('orders').updateOne(
      { _id: order._id },
      { $set: { readyNotifiedAt: new Date() } }
    );

    console.log(`✉️ Customer notified: ${order.orderNum} → ${isDelivery ? 'out for delivery' : 'ready for pickup'}`);
    res.json({
      ok: true,
      notified: true,
      customerName: order.customer.firstName,
      mode: isDelivery ? 'delivery' : 'pickup'
    });
  } catch (e) {
    console.error('[kitchen] notify-ready error', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ── DONATION TRACKER (Mongo-backed, survives restarts) ────────
let donationAmount = 27000;
let donationLoaded = false;

async function loadDonationFromDB() {
  try {
    const database = await connectDB();
    if (!database) return;
    const doc = await database.collection('settings').findOne({ key: 'donation' });
    if (doc && typeof doc.amount === 'number') {
      donationAmount = doc.amount;
      console.log(`✓ Donation loaded from DB: ${donationAmount}`);
    } else {
      await database.collection('settings').insertOne({ key: 'donation', amount: donationAmount, updatedAt: new Date() });
      console.log(`✓ Donation initialized in DB: ${donationAmount}`);
    }
    donationLoaded = true;
  } catch (e) {
    console.warn('Donation load failed:', e.message);
  }
}
setTimeout(loadDonationFromDB, 2000);

app.get('/api/donation', async (req, res) => {
  if (!donationLoaded) await loadDonationFromDB();
  res.json({ amount: donationAmount, updatedAt: new Date().toISOString() });
});

app.post('/api/donation', async (req, res) => {
  const { amount, password } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Wrong password' });
  const newAmount = Number(amount);
  if (isNaN(newAmount) || newAmount < 0) return res.status(400).json({ error: 'Invalid amount' });
  donationAmount = newAmount;
  try {
    const database = await connectDB();
    if (database) {
      await database.collection('settings').updateOne(
        { key: 'donation' },
        { $set: { amount: newAmount, updatedAt: new Date() } },
        { upsert: true }
      );
      console.log(`✓ Donation updated to ${donationAmount} (saved to DB)`);
    }
  } catch (e) {
    console.warn('Donation save failed:', e.message);
  }
  res.json({ success: true, amount: donationAmount });
});

// ── LOCATION STATUS (ON/OFF toggle) ───────────────────────────
app.get('/api/locations/status', async (req, res) => {
  try {
    const database = await connectDB();
    if (!database) return res.json({ status: effectiveStatus({}, 'startsOff'), delivery: effectiveStatus({}, 'startsOff') });
    const doc = await database.collection('settings').findOne({ key: 'location_status' });
    const del = await database.collection('settings').findOne({ key: 'delivery_status' });
    const live = await getLiveSettings();
    res.json({ status: effectiveStatus(doc?.status, 'startsOff'), delivery: effectiveStatus(del?.status, 'startsOff'), wait: live.wait, soldOut: live.soldOut, seasonClosed: SEASON_CLOSED });
  } catch (e) {
    res.json({ status: effectiveStatus({}, 'startsOff'), delivery: effectiveStatus({}, 'startsOff') });
  }
});

// Delivery ON/OFF per location (pickup stays available). Missing = ON.
app.post('/api/locations/delivery', async (req, res) => {
  const { locationId, enabled, password } = req.body || {};
  if (!isAdmin(password)) return res.status(401).json({ error: 'Wrong password' });
  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'Database unavailable' });
    const doc = await database.collection('settings').findOne({ key: 'delivery_status' });
    const status = doc?.status || {};
    status[locationId] = !!enabled;
    await database.collection('settings').updateOne(
      { key: 'delivery_status' },
      { $set: { status, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`🛵 Delivery ${locationId} → ${enabled ? 'ON' : 'OFF'}`);
    res.json({ success: true, locationId, enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/locations/status', async (req, res) => {
  const { locationId, enabled, password } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Wrong password' });
  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'Database unavailable' });
    const doc = await database.collection('settings').findOne({ key: 'location_status' });
    const status = doc?.status || {};
    status[locationId] = !!enabled;
    await database.collection('settings').updateOne(
      { key: 'location_status' },
      { $set: { status, updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`📍 Location ${locationId} → ${enabled ? 'ENABLED' : 'DISABLED'}`);
    res.json({ success: true, locationId, enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SEASONAL STORES ───────────────────────────────────────────
// Stores closed for the season (no online orders; the site says "See ya next summer").
// Railway variable SEASON_CLOSED: comma-separated store ids. Not set = Regina Beach is closed.
// To reopen Regina Beach for summer, set SEASON_CLOSED to "none".
const SEASON_CLOSED = String(process.env.SEASON_CLOSED ?? 'regina-beach')
  .split(',').map(s => s.trim()).filter(id => LOCATIONS[id]);

// ── LIVE WAIT TIMES + SOLD-OUT ITEMS (set by staff in /admin) ──────────
// Wait: minutes until a pickup order is ready, per location (default 20).
// Sold out: menu item ids per location. A sold-out mark only lasts for the current
// business day: it clears by itself at 5 AM store time, so nothing stays hidden by mistake.
const DEFAULT_WAIT_MINS = 20;
const WAIT_CHOICES = [15, 20, 30, 45, 60, 90];
let liveCache = { at: 0, wait: {}, soldOutRaw: {} };
function businessDayStart(locId) {
  const tz = locTz(LOCATIONS[locId]);
  const now = new Date();
  const wall = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const start = new Date(wall); start.setHours(5, 0, 0, 0);
  if (wall < start) start.setDate(start.getDate() - 1);
  return now.getTime() - (wall.getTime() - start.getTime());   // back to real time
}
function activeSoldOut(raw) {
  const out = {};
  for (const [loc, items] of Object.entries(raw || {})) {
    if (!LOCATIONS[loc]) continue;
    const since = businessDayStart(loc);
    const ids = Object.entries(items || {}).filter(([, at]) => new Date(at).getTime() >= since).map(([id]) => id);
    if (ids.length) out[loc] = ids;
  }
  return out;
}
async function getLiveSettings(fresh) {
  if (fresh || Date.now() - liveCache.at > 15000) {
    try {
      const database = await connectDB();
      if (database) {
        const [w, s] = await Promise.all([
          database.collection('settings').findOne({ key: 'wait_times' }),
          database.collection('settings').findOne({ key: 'sold_out' }),
        ]);
        liveCache = { at: Date.now(), wait: w?.wait || {}, soldOutRaw: s?.items || {} };
      }
    } catch (e) { console.warn('Live settings load failed:', e.message); }
  }
  return { wait: liveCache.wait, soldOut: activeSoldOut(liveCache.soldOutRaw) };
}
async function waitMinsFor(locId) {
  const { wait } = await getLiveSettings();
  return Number(wait[locId]) || DEFAULT_WAIT_MINS;
}

app.post('/api/locations/wait', async (req, res) => {
  const { locationId, mins, password } = req.body || {};
  if (!isAdmin(password)) return res.status(401).json({ error: 'Wrong password' });
  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  const m = Number(mins);
  if (!WAIT_CHOICES.includes(m)) return res.status(400).json({ error: 'Pick one of: ' + WAIT_CHOICES.join(', ') + ' minutes' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'Database unavailable' });
    await database.collection('settings').updateOne({ key: 'wait_times' }, { $set: { [`wait.${locationId}`]: m, updatedAt: new Date() } }, { upsert: true });
    await getLiveSettings(true);
    console.log(`⏱️ Wait time ${locationId} → ${m} min`);
    res.json({ success: true, locationId, mins: m });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/locations/soldout', async (req, res) => {
  const { locationId, itemId, soldOut, password } = req.body || {};
  if (!isAdmin(password)) return res.status(401).json({ error: 'Wrong password' });
  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  if (!/^[a-z0-9-]{1,20}$/i.test(String(itemId || ''))) return res.status(400).json({ error: 'Invalid item' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'Database unavailable' });
    const field = `items.${locationId}.${itemId}`;
    await database.collection('settings').updateOne({ key: 'sold_out' },
      soldOut ? { $set: { [field]: new Date(), updatedAt: new Date() } } : { $unset: { [field]: '' }, $set: { updatedAt: new Date() } },
      { upsert: true });
    const live = await getLiveSettings(true);
    console.log(`🚫 ${locationId} ${itemId} → ${soldOut ? 'SOLD OUT' : 'available'}`);
    res.json({ success: true, soldOut: live.soldOut[locationId] || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LOCATIONS ─────────────────────────────────────────────────
app.get('/api/locations', (req, res) => {
  const safe = Object.entries(LOCATIONS).map(([id, loc]) => ({
    id, name: loc.name, address: loc.address, phone: loc.phone, hours: loc.hours
  }));
  res.json(safe);
});

// ── FRANCHISE INQUIRY ─────────────────────────────────────────
// Form in the franchise overlay on the home page (and /#franchise). Every lead is saved to
// MongoDB (franchise_leads) and emailed; the owner reviews them at /franchise-admin.
const frHits = new Map();
function frRateOk(ip) {
  const now = Date.now();
  const hits = (frHits.get(ip) || []).filter(t => now - t < 60000);
  hits.push(now);
  frHits.set(ip, hits);
  if (frHits.size > 5000) frHits.clear();
  return hits.length <= 5;
}
const FR_FIELDS = { firstName: 60, lastName: 60, email: 200, phone: 30, city: 120, budget: 80, timeline: 80, financing: 80, experience: 200, message: 3000 };

app.post('/api/franchise', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  if (!frRateOk(ip)) return res.status(429).json({ success: false, error: 'Too many tries — please wait a minute.' });
  const lead = {};
  for (const [k, max] of Object.entries(FR_FIELDS)) lead[k] = String((req.body || {})[k] || '').trim().slice(0, max);
  if (!lead.firstName || !lead.email || !lead.phone || !lead.city) return res.status(400).json({ success: false, error: 'Please fill in all required fields.' });
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });
  console.log(`\n🚀 FRANCHISE: ${lead.firstName} ${lead.lastName} — ${lead.city} — ${timestamp}`);

  let saved = false;
  try {
    const database = await connectDB();
    if (database) {
      await database.collection('franchise_leads').insertOne({ ...lead, status: 'new', created_at: new Date(), ip });
      saved = true;
    }
  } catch (e) { console.error('Franchise lead save failed:', e.message); }

  const e = escHtml;
  const row = (label, val) => `<tr><td style="padding:8px 0;color:#888;font-size:13px;width:120px;">${label}</td><td style="padding:8px 0;font-weight:bold;">${val}</td></tr>`;
  sendEmail({
    to: 'besaucy@wingorestaurants.com',
    subject: `🚀 Franchise Inquiry — ${lead.firstName} ${lead.lastName} (${lead.city})`.replace(/[\r\n]/g, ' '),
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0D0D0D;padding:20px;text-align:center;"><h1 style="color:#E8190A;font-size:28px;margin:0;">WING-O</h1><p style="color:#888;margin:4px 0 0;font-size:12px;letter-spacing:2px;">🚀 Franchise Inquiry</p></div>
      <div style="background:#F5F0E8;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          ${row('Name', e(lead.firstName + ' ' + lead.lastName))}
          ${row('Email', `<a href="mailto:${e(lead.email)}" style="color:#E8190A;">${e(lead.email)}</a>`)}
          ${row('Phone', `<a href="tel:${e(lead.phone)}" style="color:#E8190A;">${e(lead.phone)}</a>`)}
          ${row('City', e(lead.city))}
          ${row('Investment', e(lead.budget || 'Not specified'))}
          ${row('Timeline', e(lead.timeline || 'Not specified'))}
          ${row('Financing', e(lead.financing || 'Not specified'))}
          ${row('Experience', e(lead.experience || 'Not specified'))}
          ${row('Time', e(timestamp))}
        </table>
        ${lead.message ? `<hr style="border:1px solid #E8E0D0;margin:16px 0;"><p style="background:white;border:1px solid #E8E0D0;border-radius:6px;padding:12px;margin:0;font-size:14px;white-space:pre-wrap;">${e(lead.message)}</p>` : ''}
        <p style="font-size:12px;color:#888;margin-top:16px;">${saved ? 'Saved — see every lead at wingorestaurants.com/franchise-admin' : '⚠️ Not saved to the database — keep this email.'}</p>
      </div>
    </div>`
  });
  res.json({ success: true });
});

// Owner-only lead list + status updates. Needs ADMIN_PASSWORD set on Railway.
const FR_STATUSES = ['new', 'contacted', 'call booked', 'sent disclosure', 'not a fit', 'signed'];
app.post('/api/franchise/leads', async (req, res) => {
  if (!isAdmin((req.body || {}).password)) return res.status(401).json({ error: 'Wrong password' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'Database unavailable' });
    const col = database.collection('franchise_leads');
    const { id, status, notes } = req.body;
    if (id) {
      if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Bad id' });
      const set = { updated_at: new Date() };
      if (status !== undefined) { if (!FR_STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' }); set.status = status; }
      if (notes !== undefined) set.notes = String(notes).slice(0, 2000);
      await col.updateOne({ _id: new ObjectId(id) }, { $set: set });
    }
    const rows = await col.find({}, { projection: { ip: 0 } }).sort({ created_at: -1 }).limit(5000).toArray();
    res.json({ statuses: FR_STATUSES, rows: rows.map(r => ({ ...r, id: String(r._id), _id: undefined })) });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ── LOYALTY ───────────────────────────────────────────────────
app.post('/api/loyalty/signup', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email || !phone) return res.json({ success: false, error: 'Missing fields' });
  const cleanPhone = loyaltyPhone(phone);
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const existing = await database.collection('loyalty').findOne(loyaltyPhoneQuery(cleanPhone));
    if (existing) return res.json({ success: false, error: 'Phone already registered' });
    const member = {
      name, email, phone: cleanPhone, stamps: 0, totalOrders: 0, freeEarned: 0, freeRedeemed: 0, cardToken: newCardToken(),
      usedOrderNums: [], history: [], joinDate: new Date().toISOString(), createdAt: new Date()
    };
    await database.collection('loyalty').insertOne(member);
    console.log(`🍗 New loyalty member: ${name} — ${cleanPhone}`);
    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🍗 New Saucy Stamps Member — ${name}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;">
        <h2 style="color:#F5A800;font-size:22px;margin:0 0 16px;">New Saucy Stamps Member! 🍗</h2>
        <table style="width:100%;color:#CCC;font-size:14px;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#888;width:80px;">Name</td><td style="font-weight:bold;color:white;">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Email</td><td>${email}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Phone</td><td>${cleanPhone}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Joined</td><td>${new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' })}</td></tr>
        </table>
      </div>`
    });
    res.json({ success: true, member: publicCard(member) });
  } catch (e) {
    console.error('Loyalty signup error:', e.message);
    res.json({ success: false, error: 'Signup failed' });
  }
});

app.get('/api/loyalty/lookup', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search' });
  const cleanPhone = loyaltyPhone(q);
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const byEmail = q.includes('@');
    const member = await database.collection('loyalty').findOne(
      byEmail ? { email: q.toLowerCase().trim() } : loyaltyPhoneQuery(cleanPhone)
    );
    if (!member) return res.json({ success: false, error: 'Member not found' });
    await ensureCardToken(database, member);
    if (byEmail) {
      // Don't show someone's card to whoever typed their email: send the owner a private link instead.
      const link = `https://wingorestaurants.com/?card=${member.cardToken}`;
      sendEmail({
        to: member.email,
        subject: 'Your Saucy Stamps card 🍗',
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;color:#eee;">
          <h2 style="color:#F5A800;margin:0 0 12px;">Here's your Saucy Stamps card</h2>
          <p style="color:#ccc;line-height:1.5;">Hi ${String(member.name || '').split(' ')[0]}, tap below to open your stamp card on this device.</p>
          <p style="text-align:center;margin:20px 0;"><a href="${link}" style="background:#E8190A;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;">Open my card</a></p>
          <p style="color:#888;font-size:12px;">Didn't ask for this? You can ignore this email.</p></div>`
      });
      return res.json({ success: true, emailed: true });
    }
    res.json({ success: true, member: publicCard(member) });
  } catch (e) {
    console.error('Loyalty lookup error:', e.message);
    res.json({ success: false, error: 'Lookup failed' });
  }
});

app.post('/api/loyalty/stamp', async (req, res) => {
  const { phone, token, password } = req.body;
  const orderNum = String(req.body.orderNum || '').trim().toUpperCase();
  let cleanPhone = loyaltyPhone(phone);
  if ((!cleanPhone && !token) || !orderNum) return res.json({ success: false, error: 'Missing fields' });
  // Staff (admin password) can stamp any order, including in-store ones.
  // Customers can stamp their own online orders: the order must exist under the same phone number.
  const isStaff = isAdmin(password);
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne(token ? { cardToken: String(token) } : loyaltyPhoneQuery(cleanPhone));
    if (!member) return res.json({ success: false, error: 'Member not found' });
    cleanPhone = loyaltyPhone(member.phone);
    if (!isStaff) {
      const order = await database.collection('orders').findOne({ orderNum });
      if (!order || loyaltyPhone(order.customer && order.customer.phone) !== cleanPhone) {
        return res.json({ success: false, error: 'We couldn’t find that online order under your phone number. In-store orders are stamped at the counter.' });
      }
    }
    if (member.usedOrderNums && member.usedOrderNums.includes(orderNum)) {
      return res.json({ success: false, error: 'Order number already used' });
    }
    const newStamps = (member.stamps || 0) + 1;
    const newTotalOrders = (member.totalOrders || 0) + 1;
    const gotFree = newStamps >= 10;
    const finalStamps = gotFree ? 0 : newStamps;
    const newFreeEarned = gotFree ? (member.freeEarned || 0) + 1 : (member.freeEarned || 0);
    const newHistory = [
      { orderNum, date: new Date().toLocaleDateString('en-CA'), stamp: newTotalOrders, manual: true, ...(isStaff ? { staff: true } : {}) },
      ...(member.history || [])
    ].slice(0, 50);
    await database.collection('loyalty').updateOne(
      { _id: member._id },
      {
        $set: { stamps: finalStamps, totalOrders: newTotalOrders, freeEarned: newFreeEarned, history: newHistory, updatedAt: new Date() },
        $push: { usedOrderNums: orderNum }
      }
    );
    const updated = await database.collection('loyalty').findOne({ _id: member._id });
    console.log(`🍗 MANUAL STAMP: ${member.name} — ${orderNum} — Total: ${newTotalOrders} — Free: ${gotFree}`);
    if (gotFree) {
      sendEmail({
        to: 'besaucy@wingorestaurants.com',
        subject: `🎉 FREE WINGS EARNED — ${member.name}`,
        html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;">
          <h2 style="color:#E8190A;margin:0 0 16px;">🎉 Free Wings Earned!</h2>
          <table style="width:100%;color:#CCC;font-size:14px;">
            <tr><td style="padding:6px 0;color:#888;">Member</td><td>${member.name}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Order</td><td>${orderNum}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Free Wings #</td><td style="color:#F5A800;font-weight:bold;">${newFreeEarned}</td></tr>
          </table>
          <div style="background:#E8190A;border-radius:6px;padding:12px;margin-top:16px;text-align:center;color:white;font-size:13px;letter-spacing:1px;">REDEEM: Give customer one FREE half order of wings 🍗</div>
        </div>`
      });
    }
    await ensureCardToken(database, updated);
    res.json({ success: true, member: isStaff ? Object.assign(publicCard(updated), staffView(updated)) : publicCard(updated), gotFree, stamps: finalStamps, totalOrders: newTotalOrders });
  } catch (e) {
    console.error('Loyalty stamp error:', e.message);
    res.json({ success: false, error: 'Failed to add stamp' });
  }
});

// Card by private token (from the emailed link, and from a saved browser session).
app.get('/api/loyalty/card/:token', async (req, res) => {
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne({ cardToken: String(req.params.token) });
    if (!member) return res.json({ success: false, error: 'Member not found' });
    res.json({ success: true, member: publicCard(member) });
  } catch (e) { res.json({ success: false, error: 'Lookup failed' }); }
});

// ── Staff: look up a card, and mark free wings as used (/stamps-admin) ──
const staffView = m => ({ fullName: m.name, email: m.email, phone: m.phone, freeRedeemed: m.freeRedeemed === undefined ? Math.max(0, (m.freeEarned || 0) - freeAvailable(m)) : m.freeRedeemed });
app.post('/api/loyalty/admin/find', async (req, res) => {
  if (!isAdmin(req.body.password)) return res.status(401).json({ success: false, error: 'Wrong password' });
  const q = String(req.body.q || '').trim();
  if (!q) return res.json({ success: false, error: 'Enter a phone number or email' });
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne(q.includes('@') ? { email: q.toLowerCase() } : loyaltyPhoneQuery(loyaltyPhone(q)));
    if (!member) return res.json({ success: false, error: 'No card found' });
    await ensureCardToken(database, member);
    res.json({ success: true, member: Object.assign(publicCard(member), staffView(member)) });
  } catch (e) { res.json({ success: false, error: 'Lookup failed' }); }
});
app.post('/api/loyalty/redeem', async (req, res) => {
  if (!isAdmin(req.body.password)) return res.status(401).json({ success: false, error: 'Wrong password' });
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne(loyaltyPhoneQuery(loyaltyPhone(req.body.phone)));
    if (!member) return res.json({ success: false, error: 'No card found' });
    const avail = freeAvailable(member);
    if (avail < 1) return res.json({ success: false, error: 'No free wings to redeem on this card' });
    const redeemed = (member.freeEarned || 0) - avail + 1;
    const history = [{ orderNum: 'FREE WINGS', date: new Date().toLocaleDateString('en-CA'), redeemed: true }, ...(member.history || [])].slice(0, 50);
    await database.collection('loyalty').updateOne({ _id: member._id }, { $set: { freeRedeemed: redeemed, history, updatedAt: new Date() } });
    const updated = await database.collection('loyalty').findOne({ _id: member._id });
    console.log(`🎁 REDEEMED free wings: ${member.name} (${member.phone})`);
    res.json({ success: true, member: Object.assign(publicCard(updated), staffView(updated)) });
  } catch (e) { res.json({ success: false, error: 'Redeem failed' }); }
});

app.get('/api/loyalty/member/:phone', async (req, res) => {
  const cleanPhone = loyaltyPhone(req.params.phone);
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne(loyaltyPhoneQuery(cleanPhone));
    if (!member) return res.json({ success: false, error: 'Member not found' });
    await ensureCardToken(database, member);
    res.json({ success: true, member: publicCard(member) });
  } catch (e) { res.json({ success: false, error: 'Lookup failed' }); }
});

app.get('/api/loyalty/admin/members', async (req, res) => {
  if (!isAdmin(req.query.password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const database = await connectDB();
    const members = await database.collection('loyalty').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, count: members.length, members });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, info } = req.body;
  if (!subscription || !subscription.endpoint) return res.json({ success: false, error: 'Invalid subscription' });
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    await database.collection('push_subs').updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: { subscription, updatedAt: new Date(), userAgent: info?.userAgent || '', location: info?.location || '' },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    console.log(`🔔 Push subscriber saved: ${subscription.endpoint.slice(-30)}`);
    res.json({ success: true });
  } catch (e) { console.error('Push subscribe error:', e.message); res.json({ success: false, error: e.message }); }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  try {
    const database = await connectDB();
    if (database) await database.collection('push_subs').deleteOne({ endpoint });
    res.json({ success: true });
  } catch (e) { res.json({ success: false }); }
});

app.get('/api/push/count', async (req, res) => {
  if (!isAdmin(req.query.password)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const database = await connectDB();
    const count = await database.collection('push_subs').countDocuments();
    res.json({ success: true, count });
  } catch (e) { res.json({ success: false, count: 0 }); }
});

app.post('/api/push/send', async (req, res) => {
  const { password, title, body, url, icon } = req.body;
  if (!isAdmin(password)) return res.status(401).json({ error: 'Unauthorized' });
  if (!title || !body) return res.json({ success: false, error: 'Title and body required' });
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const subs = await database.collection('push_subs').find({}).toArray();
    if (!subs.length) return res.json({ success: true, sent: 0, message: 'No subscribers yet' });
    if (!webpush) return res.json({ success: false, error: 'web-push not installed' });
    const payload = JSON.stringify({
      title: title || 'Wing-O 🍗', body,
      icon: icon || '/images/logo.jpg', badge: '/images/logo.jpg',
      url: url || '/', timestamp: Date.now()
    });
    let sent = 0, failed = 0, expired = [];
    await Promise.all(subs.map(async (sub) => {
      try { await webpush.sendNotification(sub.subscription, payload); sent++; }
      catch (e) {
        failed++;
        if (e.statusCode === 410 || e.statusCode === 404) expired.push(sub.endpoint);
        console.warn(`Push failed for ${sub.endpoint.slice(-20)}: ${e.message}`);
      }
    }));
    if (expired.length) {
      await database.collection('push_subs').deleteMany({ endpoint: { $in: expired } });
      console.log(`🧹 Removed ${expired.length} expired push subscriptions`);
    }
    console.log(`🔔 Push sent: ${sent} success, ${failed} failed`);
    res.json({ success: true, sent, failed, total: subs.length });
  } catch (e) { console.error('Push send error:', e.message); res.json({ success: false, error: e.message }); }
});

// ── SAUCE BOSS DASHBOARD ───────────────────────────────────────
app.get('/api/dashboard/orders', async (req, res) => {
  const { password, location, limit = 200 } = req.query;
  if (!isAdmin(password)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: true, orders: [], stats: {} });
    const query = {};
    if (location && location !== 'all') query.locationId = location;
    const orders = await database.collection('orders')
      .find(query).sort({ createdAt: -1 }).limit(parseInt(limit)).toArray();
    const now = new Date();
    const regina = new Date(now.toLocaleString('en-US', { timeZone: 'America/Regina' }));
    regina.setHours(0, 0, 0, 0);
    const today = orders.filter(o => new Date(o.createdAt) >= regina);
    const todayRevenue = today.reduce((s, o) => s + (o.total || 0), 0);
    const locRevenue = {}, locCount = {};
    orders.forEach(o => {
      const l = o.locationId || 'albert-st';
      locRevenue[l] = (locRevenue[l] || 0) + (o.total || 0);
      locCount[l] = (locCount[l] || 0) + 1;
    });
    res.json({
      success: true,
      orders,
      stats: {
        todayCount: today.length,
        todayRevenue: todayRevenue.toFixed(2),
        totalCount: orders.length,
        locRevenue,
        locCount
      }
    });
  } catch (err) {
    console.error('[Dashboard] Error:', err.message);
    res.json({ success: false, error: err.message });
  }
});

// ========================================================
// 🏆 FREE WINGS FOR A YEAR — Contest module
// ========================================================
// Paste this ENTIRE block into server.js immediately BEFORE
// the "// ── SPA FALLBACK ──" section (the app.get('*') line).
// No new dependencies required — uses your existing connectDB,
// sendEmail, MongoClient, ObjectId, and node-fetch.
// ========================================================

// ── CONTEST CONFIG ─────────────────────────────────────────────
// Edit these 3 dates before launch. SK uses CST year-round (no DST).
const CONTEST_CONFIG = {
  ENTRY_OPENS_AT:  process.env.CONTEST_OPEN  || '2026-06-02T00:00:00-06:00',
  ENTRY_CLOSES_AT: process.env.CONTEST_CLOSE || '2026-06-29T23:59:59-06:00',
  DRAW_DATE_LABEL: process.env.CONTEST_DRAW_LABEL || 'Wednesday, July 1, 2026',
  CLAIM_WINDOW_DAYS: 7,
  WEEKLY_CAP_DOLLARS: null,   // null = no cap. Set a number (e.g. 50) to cap.
  WEEKS: 52,
  ELIGIBLE_LOCATIONS: ['albert-st','east-regina','regina-beach'],
  ADMIN_PASSWORD: process.env.CONTEST_ADMIN_PASSWORD || 'wingocontest2026',
  ELIGIBLE_PROVINCE: 'SK',
  RATE_LIMIT_PER_MIN: 5
};

// ── CONTEST HELPERS ────────────────────────────────────────────
function contestIsOpen() {
  const now = Date.now();
  return now >= Date.parse(CONTEST_CONFIG.ENTRY_OPENS_AT) && now <= Date.parse(CONTEST_CONFIG.ENTRY_CLOSES_AT);
}

function genSkillQuestion() {
  const a = 5 + Math.floor(Math.random() * 20);
  const b = 2 + Math.floor(Math.random() * 8);
  const c = 5 + Math.floor(Math.random() * 30);
  const d = 1 + Math.floor(Math.random() * 15);
  return { text: `(${a} × ${b}) + ${c} − ${d} = ?`, answer: (a * b) + c - d };
}

function newContestToken() {
  return require('crypto').randomBytes(24).toString('hex');
}

// Start of current week (Monday 00:00 CST) in epoch ms — SK has no DST
function weekStartCstMs(d) {
  d = d || new Date();
  const cstOffsetMs = -6 * 60 * 60 * 1000;
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const cst = new Date(utc + cstOffsetMs);
  const day = cst.getUTCDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  cst.setUTCDate(cst.getUTCDate() + diffToMon);
  cst.setUTCHours(0, 0, 0, 0);
  return cst.getTime() - cstOffsetMs;
}

// In-memory rate limiter
const contestRateBuckets = new Map();
function contestCheckRate(ip) {
  const now = Date.now();
  const bucket = (contestRateBuckets.get(ip) || []).filter(t => now - t < 60000);
  if (bucket.length >= CONTEST_CONFIG.RATE_LIMIT_PER_MIN) return false;
  bucket.push(now);
  contestRateBuckets.set(ip, bucket);
  return true;
}

// Build the contest indexes once at startup (non-blocking)
setTimeout(async function() {
  try {
    const database = await connectDB();
    if (!database) return;
    await database.collection('contest_entries').createIndex({ email_normalized: 1 }, { unique: true });
    await database.collection('contest_entries').createIndex({ phone_normalized: 1 });
    await database.collection('contest_entries').createIndex({ created_at: -1 });
    console.log('✓ Contest indexes ready');
  } catch (e) { console.warn('Contest index setup:', e.message); }
}, 3000);

// ── STATIC PAGES ──────────────────────────────────────────────
app.get('/contest',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'contest.html')));
app.get('/contest/rules', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contest-rules.html')));
app.get('/contest/claim/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contest-claim.html')));
app.get('/contest-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'contest-admin.html')));

// ── PUBLIC: SUBMIT ENTRY ──────────────────────────────────────
app.post('/api/contest/entry', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (!contestCheckRate(ip)) return res.status(429).json({ success: false, error: 'Too many entries from this address — try again in a minute.' });
    if (!contestIsOpen()) return res.status(400).json({ success: false, error: 'The contest is not currently open.' });

    const { firstName, lastName, email, phone, city, province, age_confirm, consent_rules, consent_marketing, ig_handle, fb_handle, tagged_friends } = req.body || {};
    if (!firstName || !email || !phone) return res.status(400).json({ success: false, error: 'Name, email, and phone are required.' });
    if (!consent_rules) return res.status(400).json({ success: false, error: 'You must agree to the contest rules to enter.' });
    if (age_confirm !== true && age_confirm !== 'true') return res.status(400).json({ success: false, error: 'You must confirm you are 18 or older.' });
    if ((province || '').toUpperCase() !== CONTEST_CONFIG.ELIGIBLE_PROVINCE) return res.status(400).json({ success: false, error: 'Open to Saskatchewan residents only.' });

    const emailNorm = String(email).trim().toLowerCase();
    const phoneNorm = String(phone).replace(/\D/g, '');
    if (!emailNorm.includes('@')) return res.status(400).json({ success: false, error: 'Please enter a valid email.' });
    if (phoneNorm.length < 10)    return res.status(400).json({ success: false, error: 'Please enter a valid phone number.' });

    const bonuses = [];
    if (ig_handle && String(ig_handle).trim())                    bonuses.push('ig_follow');
    if (fb_handle && String(fb_handle).trim())                    bonuses.push('fb_follow');
    if (tagged_friends && String(tagged_friends).trim().length>3) bonuses.push('tag_friend');

    const doc = {
      firstName: String(firstName).trim().slice(0, 60),
      lastName:  String(lastName || '').trim().slice(0, 60),
      email:     String(email).trim().slice(0, 200),
      email_normalized: emailNorm,
      phone:     String(phone).trim().slice(0, 30),
      phone_normalized: phoneNorm,
      city:      String(city || '').trim().slice(0, 80),
      province:  'SK',
      age_confirm: true,
      consent_rules: true,
      consent_marketing: !!consent_marketing,
      ig_handle: String(ig_handle || '').trim().slice(0, 60),
      fb_handle: String(fb_handle || '').trim().slice(0, 60),
      tagged_friends: String(tagged_friends || '').trim().slice(0, 300),
      bonus_entries: bonuses,
      total_entries: 1 + bonuses.length,
      created_at: new Date(),
      ip,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
    };

    const database = await connectDB();
    if (!database) return res.status(500).json({ success: false, error: 'Database unavailable.' });

    try {
      await database.collection('contest_entries').insertOne(doc);
    } catch (e) {
      if (e.code === 11000) return res.status(409).json({ success: false, error: 'This email is already entered. One entry per person.' });
      throw e;
    }

    console.log(`🏆 Contest entry: ${doc.firstName} ${doc.lastName} (${emailNorm}) — ${doc.total_entries} entr${doc.total_entries===1?'y':'ies'}`);

    // Reuse existing email infra to notify Gagan
    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🏆 New Contest Entry — ${doc.firstName} ${doc.lastName} (${doc.total_entries} entries)`,
      html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;color:#CCC;">
        <h2 style="color:#F5A800;margin:0 0 16px;">🏆 New Contest Entry</h2>
        <table style="width:100%;font-size:14px;">
          <tr><td style="padding:6px 0;color:#888;width:120px;">Name</td><td style="color:white;font-weight:bold;">${doc.firstName} ${doc.lastName}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Email</td><td>${doc.email}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Phone</td><td>${doc.phone}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">City</td><td>${doc.city}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Entries</td><td style="color:#F5A800;font-weight:bold;">${doc.total_entries} (${doc.bonus_entries.length} bonus)</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Marketing</td><td>${doc.consent_marketing ? '✓ Opted in' : '— Skipped'}</td></tr>
        </table>
      </div>`
    });

    res.json({ success: true, entries: doc.total_entries, message: `You're in, ${doc.firstName}! You earned ${doc.total_entries} ${doc.total_entries === 1 ? 'entry' : 'entries'}.` });
  } catch (e) {
    console.error('[contest/entry]', e.message);
    res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ── PUBLIC: STATUS (for countdown / counters) ─────────────────
app.get('/api/contest/status', async (req, res) => {
  try {
    const database = await connectDB();
    const total = database ? await database.collection('contest_entries').countDocuments({}) : 0;
    res.json({
      success: true,
      open: contestIsOpen(),
      opens_at: CONTEST_CONFIG.ENTRY_OPENS_AT,
      closes_at: CONTEST_CONFIG.ENTRY_CLOSES_AT,
      draw_date_label: CONTEST_CONFIG.DRAW_DATE_LABEL,
      entries_count: total,
      weekly_cap: CONTEST_CONFIG.WEEKLY_CAP_DOLLARS,
      weeks: CONTEST_CONFIG.WEEKS
    });
  } catch (e) { res.json({ success: false }); }
});

// ── ADMIN: LOGIN CHECK ────────────────────────────────────────
app.post('/api/contest/admin/login', (req, res) => {
  if ((req.body || {}).password !== CONTEST_CONFIG.ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Unauthorized' });
  res.json({ success: true });
});

// ── ADMIN: LIST ENTRIES ───────────────────────────────────────
app.post('/api/contest/admin/list', async (req, res) => {
  if ((req.body || {}).password !== CONTEST_CONFIG.ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const list = await database.collection('contest_entries').find({}, { projection: { ip: 0, user_agent: 0 } }).sort({ created_at: -1 }).limit(5000).toArray();
    res.json({ success: true, count: list.length, entries: list });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── ADMIN: DRAW WINNER ────────────────────────────────────────
app.post('/api/contest/admin/draw', async (req, res) => {
  if ((req.body || {}).password !== CONTEST_CONFIG.ADMIN_PASSWORD) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ success: false, error: 'Database unavailable' });

    const existing = await database.collection('contest_winner').findOne({});
    if (existing && existing.claimed_at) return res.status(400).json({ success: false, error: 'A winner has already been drawn and claimed the prize.' });

    const all = await database.collection('contest_entries').find({}).toArray();
    if (!all.length) return res.status(400).json({ success: false, error: 'No entries to draw from.' });

    // Weighted pool: each entry appears once per total_entries
    const pool = [];
    all.forEach(e => {
      const n = e.total_entries || 1;
      for (let i = 0; i < n; i++) pool.push(e._id);
    });
    const winnerId = pool[Math.floor(Math.random() * pool.length)];
    const winnerEntry = all.find(e => String(e._id) === String(winnerId));

    const stq = genSkillQuestion();
    const token = newContestToken();
    const expiresAt = new Date(Date.now() + CONTEST_CONFIG.CLAIM_WINDOW_DAYS * 86400000);

    await database.collection('contest_winner').deleteMany({});
    await database.collection('contest_winner').insertOne({
      entry_id: winnerEntry._id,
      firstName: winnerEntry.firstName,
      lastName:  winnerEntry.lastName,
      email:     winnerEntry.email,
      phone:     winnerEntry.phone_normalized,
      city:      winnerEntry.city,
      drawn_at:  new Date(),
      claim_token: token,
      claim_expires_at: expiresAt,
      stq_question: stq.text,
      stq_correct_answer: stq.answer,
      stq_attempts: 0,
      claimed_at: null,
      weeks_used: 0,
      weekly_cap_dollars: CONTEST_CONFIG.WEEKLY_CAP_DOLLARS,
      last_redeemed_week_start: null
    });

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'wingorestaurants.com';
    const claim_url = `https://${host}/contest/claim/${token}`;

    console.log(`🎲 Contest draw: ${winnerEntry.firstName} ${winnerEntry.lastName} (pool size: ${pool.length}, unique: ${all.length})`);

    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🎲 CONTEST WINNER DRAWN — ${winnerEntry.firstName} ${winnerEntry.lastName}`,
      html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;color:#CCC;">
        <h2 style="color:#F5A800;margin:0 0 16px;">🏆 Potential Winner Drawn</h2>
        <table style="width:100%;font-size:14px;">
          <tr><td style="padding:6px 0;color:#888;width:120px;">Name</td><td style="color:white;font-weight:bold;">${winnerEntry.firstName} ${winnerEntry.lastName}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Phone</td><td><a href="tel:${winnerEntry.phone_normalized}" style="color:#E8190A;">${winnerEntry.phone_normalized}</a></td></tr>
          <tr><td style="padding:6px 0;color:#888;">Email</td><td>${winnerEntry.email}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">City</td><td>${winnerEntry.city || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Pool size</td><td>${pool.length} weighted / ${all.length} unique</td></tr>
        </table>
        <div style="background:#1A1208;border:1.5px dashed #F5A800;border-radius:6px;padding:12px;margin-top:16px;text-align:center;">
          <div style="color:#888;font-size:11px;letter-spacing:2px;margin-bottom:6px;">CLAIM URL — SEND TO WINNER</div>
          <div style="color:#F5A800;font-family:monospace;font-size:13px;word-break:break-all;">${claim_url}</div>
        </div>
        <p style="margin-top:14px;font-size:13px;color:#888;">Expires: ${expiresAt.toLocaleString()}. 3 attempts. STQ: <strong style="color:white;">${stq.text}</strong></p>
      </div>`
    });

    res.json({
      success: true,
      winner: { name: winnerEntry.firstName + ' ' + winnerEntry.lastName, email: winnerEntry.email, phone: winnerEntry.phone_normalized, city: winnerEntry.city },
      claim_url,
      claim_expires_at: expiresAt,
      stq_question: stq.text,
      message: `Drawn from pool of ${pool.length} weighted entries (${all.length} unique entrants). Contact the winner with the claim URL.`
    });
  } catch (e) {
    console.error('[contest/admin/draw]', e.message);
    res.status(500).json({ success: false, error: 'Draw failed.' });
  }
});

// ── WINNER: GET STQ ───────────────────────────────────────────
app.get('/api/contest/claim/:token', async (req, res) => {
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const w = await database.collection('contest_winner').findOne({ claim_token: req.params.token });
    if (!w) return res.json({ success: false, error: 'Invalid or expired claim link.' });
    if (w.claimed_at) return res.json({ success: false, error: 'This prize has already been claimed.' });
    if (Date.now() > new Date(w.claim_expires_at).getTime()) return res.json({ success: false, error: 'This claim link has expired.' });
    res.json({ success: true, firstName: w.firstName, stq_question: w.stq_question, attempts_remaining: 3 - (w.stq_attempts || 0) });
  } catch (e) { res.json({ success: false, error: 'Lookup failed' }); }
});

// ── WINNER: SUBMIT STQ ────────────────────────────────────────
app.post('/api/contest/claim', async (req, res) => {
  try {
    const { token, answer } = req.body || {};
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const w = await database.collection('contest_winner').findOne({ claim_token: token });
    if (!w) return res.json({ success: false, error: 'Invalid or expired claim link.' });
    if (w.claimed_at) return res.json({ success: false, error: 'This prize has already been claimed.' });
    if (Date.now() > new Date(w.claim_expires_at).getTime()) return res.json({ success: false, error: 'Claim link expired.' });
    if ((w.stq_attempts || 0) >= 3) return res.json({ success: false, error: 'No attempts remaining. The next entrant will be drawn.' });

    const submitted = parseInt(String(answer).trim(), 10);
    if (isNaN(submitted)) return res.json({ success: false, error: 'Please enter a number.' });

    if (submitted !== w.stq_correct_answer) {
      await database.collection('contest_winner').updateOne({ _id: w._id }, { $inc: { stq_attempts: 1 } });
      const remaining = 2 - (w.stq_attempts || 0);
      return res.json({ success: false, error: `Incorrect. ${remaining > 0 ? remaining + ' attempt(s) remaining.' : 'No attempts remaining.'}` });
    }

    await database.collection('contest_winner').updateOne({ _id: w._id }, { $set: { claimed_at: new Date() } });

    console.log(`🏆 CONTEST CLAIMED: ${w.firstName} ${w.lastName} (${w.phone}) — free wings for ${CONTEST_CONFIG.WEEKS} weeks activated`);

    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🏆 CONTEST CLAIMED — ${w.firstName} ${w.lastName} is the winner`,
      html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;color:#CCC;">
        <h2 style="color:#F5A800;margin:0 0 16px;">🏆 Winner Claimed!</h2>
        <p>${w.firstName} ${w.lastName} solved the skill-testing question and is now the confirmed winner.</p>
        <table style="width:100%;font-size:14px;margin-top:12px;">
          <tr><td style="padding:6px 0;color:#888;width:120px;">Phone</td><td style="color:white;">${w.phone}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Email</td><td>${w.email}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Active for</td><td style="color:#F5A800;">${CONTEST_CONFIG.WEEKS} weeks</td></tr>
        </table>
        <p style="margin-top:14px;font-size:13px;color:#888;">From now on, orders placed using ${w.phone} at any of the 5 corporate locations will be free (one per week).</p>
      </div>`
    });

    res.json({ success: true, message: `Congratulations, ${w.firstName}! You answered correctly. You've won free wings for ${CONTEST_CONFIG.WEEKS} weeks. Show your phone (${w.phone}) at any of our 5 corporate locations to redeem.` });
  } catch (e) {
    console.error('[contest/claim]', e.message);
    res.json({ success: false, error: 'Server error.' });
  }
});

// ── ORDER-TIME REDEMPTION CHECK ───────────────────────────────
// Called from inside /api/orders below. Returns { applies, discount_amount, label, winner_name }.
async function checkContestRedemption(phoneNormalized, locationId, subtotalNum) {
  if (!phoneNormalized) return { applies: false };
  if (!CONTEST_CONFIG.ELIGIBLE_LOCATIONS.includes(locationId)) return { applies: false, reason: 'location_not_eligible' };

  const database = await connectDB();
  if (!database) return { applies: false };

  const winner = await database.collection('contest_winner').findOne({ phone: phoneNormalized, claimed_at: { $ne: null } });
  if (!winner) return { applies: false };
  if ((winner.weeks_used || 0) >= CONTEST_CONFIG.WEEKS) return { applies: false, reason: 'all_weeks_used' };

  const thisWeek = weekStartCstMs();
  if (winner.last_redeemed_week_start === thisWeek) return { applies: false, reason: 'already_redeemed_this_week' };

  let discount = subtotalNum;
  if (CONTEST_CONFIG.WEEKLY_CAP_DOLLARS && discount > CONTEST_CONFIG.WEEKLY_CAP_DOLLARS) discount = CONTEST_CONFIG.WEEKLY_CAP_DOLLARS;

  // Atomic week-lock to prevent double-redemption races
  const upd = await database.collection('contest_winner').findOneAndUpdate(
    { _id: winner._id, last_redeemed_week_start: winner.last_redeemed_week_start || null },
    { $set: { last_redeemed_week_start: thisWeek }, $inc: { weeks_used: 1 } },
    { returnDocument: 'after' }
  );
  if (!upd.value) return { applies: false, reason: 'race_lost' };

  return {
    applies: true,
    discount_amount: Number(discount.toFixed(2)),
    label: `🏆 Free Wings For A Year · Week ${upd.value.weeks_used}/${CONTEST_CONFIG.WEEKS}`,
    winner_name: winner.firstName + ' ' + winner.lastName
  };
}
// Expose for use inside /api/orders below
app.locals.checkContestRedemption = checkContestRedemption;

// ========================================================
// END CONTEST MODULE
// ========================================================

// Escape text for HTML emails
const escHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── GOOGLE REVIEW REQUESTS ─────────────────────────────────────
// ~2 hours after an online order, email the customer a link to review
// the location they ordered from. Rules:
//  • only orders that have reviewDueAt (set when the order is saved), so
//    orders from before this feature never get an email
//  • no emails 10 PM – 10 AM Regina time (pushed to 11 AM)
//  • one request per email address every 60 days; unsubscribe honoured
//  • Google policy: ask everyone the same way — no incentives, no filtering
//    happy customers first ("review gating")
// Set REVIEW_URL_ALBERT / REVIEW_URL_EAST / REVIEW_URL_BEACH on Railway to
// each location's "Ask for reviews" link from Google Business Profile.
const REVIEW_LINKS = {
  'albert-st':    process.env.REVIEW_URL_ALBERT,
  'east-regina':  process.env.REVIEW_URL_EAST,
  'regina-beach': process.env.REVIEW_URL_BEACH,
  'winnipeg':     process.env.REVIEW_URL_WINNIPEG,
};
const REVIEW_DELAY_MS = 2 * 60 * 60 * 1000;
const REVIEW_REPEAT_DAYS = 60;
const REGINA_UTC_OFFSET_H = -6;  // Saskatchewan: CST all year, no daylight saving

function reviewUrlFor(locationId) {
  if (REVIEW_LINKS[locationId]) return REVIEW_LINKS[locationId];
  const loc = LOCATIONS[locationId];
  // Fallback: Google Maps search for the location (customer taps "Reviews" there)
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('Wing-O ' + (loc ? loc.address : 'Regina SK'));
}

// Returns a Date at the given Regina wall-clock hour, on the Regina day of `d` plus `addDays`.
function reginaAt(d, hour, addDays) {
  const r = new Date(d.getTime() + REGINA_UTC_OFFSET_H * 3600000);  // shift so UTC fields = Regina time
  return new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth(), r.getUTCDate() + (addDays || 0), hour) - REGINA_UTC_OFFSET_H * 3600000);
}
function reviewDueTime(createdAt, preOrder) {
  if (preOrder) {
    // Made when the store opens at 11 AM → ask at 1 PM that day
    const today1pm = reginaAt(createdAt, 13, 0);
    return today1pm > createdAt ? today1pm : reginaAt(createdAt, 13, 1);
  }
  const due = new Date(createdAt.getTime() + REVIEW_DELAY_MS);
  const h = new Date(due.getTime() + REGINA_UTC_OFFSET_H * 3600000).getUTCHours();
  if (h >= 22) return reginaAt(due, 11, 1);  // late evening → 11 AM next day
  if (h < 10) return reginaAt(due, 11, 0);   // overnight → 11 AM same day
  return due;
}

async function sendDueReviewRequests() {
  const database = await connectDB();
  if (!database) return;
  const orders = database.collection('orders');
  const now = new Date();
  for (let i = 0; i < 25; i++) {
    // Claim one due order atomically so two server instances never both send it
    const r = await orders.findOneAndUpdate(
      { reviewDueAt: { $lte: now }, reviewRequest: { $exists: false } },
      { $set: { reviewRequest: { status: 'claimed', at: now } } }
    );
    const order = r && r.value !== undefined ? r.value : r;
    if (!order) break;
    const mark = (status, extra) => orders.updateOne({ _id: order._id }, { $set: { reviewRequest: { status, at: new Date(), ...(extra || {}) } } });
    try {
      const email = String(order.customer?.email || '').trim();
      const emailNorm = email.toLowerCase();
      if (!emailNorm.includes('@')) { await mark('skipped', { reason: 'no-email' }); continue; }
      if (now - new Date(order.createdAt) > 3 * 86400000) { await mark('skipped', { reason: 'too-old' }); continue; }
      if (await database.collection('email_optouts').findOne({ email_normalized: emailNorm })) { await mark('skipped', { reason: 'unsubscribed' }); continue; }
      const recent = await database.collection('review_requests').findOne({ email_normalized: emailNorm, sent_at: { $gt: new Date(now - REVIEW_REPEAT_DAYS * 86400000) } });
      if (recent) { await mark('skipped', { reason: 'asked-recently' }); continue; }

      const token = require('crypto').randomBytes(16).toString('hex');
      const locName = String(LOCATIONS[order.locationId]?.name || order.locationName || '').replace(/\s*\(.*\)\s*$/, '');  // 'East Regina (Wing-O East)' → 'East Regina'
      const reviewUrl = reviewUrlFor(order.locationId);
      const unsubUrl = `https://wingorestaurants.com/api/email/unsubscribe?t=${token}`;
      const first = escHtml(order.customer?.firstName || '');
      await database.collection('review_requests').insertOne({ email_normalized: emailNorm, orderNum: order.orderNum, locationId: order.locationId, token, sent_at: new Date() });
      await sendEmail({
        to: email,
        replyTo: 'besaucy@wingorestaurants.com',
        subject: `How were your wings${first ? ', ' + (order.customer.firstName) : ''}? 🍗`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#F4EBD7;">
          <div style="background:#0D0D0D;padding:22px;text-align:center;border-bottom:3px double #F5A800;"><h1 style="color:#E8190A;margin:0;letter-spacing:2px;">WING<span style="color:white;">-O</span></h1></div>
          <div style="padding:26px 24px;color:#1A1208;font-size:15px;line-height:1.6;text-align:center;">
            <p style="font-size:19px;font-weight:bold;margin:0 0 10px;">Hey${first ? ' ' + first : ''}! How was everything? 👋</p>
            <p style="margin:0 0 20px;">Thanks for ordering from <strong>Wing-O ${escHtml(locName)}</strong> (order ${escHtml(order.orderNum)}). We're a local Regina business, and a quick Google review helps more people find us.</p>
            <a href="${escHtml(reviewUrl)}" style="display:inline-block;background:#E8190A;color:white;text-decoration:none;font-weight:bold;font-size:17px;letter-spacing:1px;padding:15px 28px;border-radius:6px;">⭐ Leave a Google review</a>
            <p style="margin:22px 0 0;font-size:14px;color:#555;">Something not right? Just reply to this email — it goes straight to the Sauce Boss and we'll make it right.</p>
          </div>
          <div style="padding:14px 24px;color:#888;font-size:12px;text-align:center;">Wing-O Restaurants · Regina, Saskatchewan · You're getting this because you ordered at wingorestaurants.com. <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></div>
        </div>`
      });
      await mark('sent');
      console.log(`⭐ Review request sent for ${order.orderNum} (${locName})`);
    } catch (e) {
      console.warn('Review request failed for', order.orderNum, e.message);
      await mark('error', { message: String(e.message).slice(0, 200) }).catch(() => {});
    }
  }
}
setInterval(() => { sendDueReviewRequests().catch(e => console.warn('Review job error:', e.message)); }, Number(process.env.REVIEW_JOB_MS) || 10 * 60 * 1000);

app.get('/api/email/unsubscribe', async (req, res) => {
  const t = String(req.query.t || '');
  const page = msg => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wing-O</title></head><body style="font-family:Arial,sans-serif;background:#F4EBD7;text-align:center;padding:60px 20px;"><h1 style="color:#E8190A;">WING-O</h1><p style="font-size:17px;">${msg}</p><p><a href="/" style="color:#E8190A;">Back to Wing-O</a></p></body></html>`;
  if (!/^[a-f0-9]{32}$/.test(t)) return res.status(400).send(page('That unsubscribe link is not valid.'));
  try {
    const database = await connectDB();
    if (!database) return res.status(500).send(page('Please try again in a few minutes.'));
    const rr = await database.collection('review_requests').findOne({ token: t });
    if (!rr) return res.status(404).send(page('We couldn\'t find that link — you may already be unsubscribed.'));
    await database.collection('email_optouts').updateOne(
      { email_normalized: rr.email_normalized },
      { $set: { email_normalized: rr.email_normalized, source: 'review-request', at: new Date() } },
      { upsert: true }
    );
    res.send(page('You won\'t get review emails from Wing-O anymore. Thanks for ordering! 🍗'));
  } catch (e) {
    res.status(500).send(page('Please try again in a few minutes.'));
  }
});

// ── WINNIPEG LAUNCH SIGN-UPS ───────────────────────────────────
// Email list for the Winnipeg opening (form on /winnipeg).
// Consent is required and recorded (CASL); every email has an unsubscribe link.
// Owner views the list at /winnipeg-admin with ADMIN_PASSWORD (set on Railway).
const wpgHits = new Map();
function wpgRateOk(ip) {
  const now = Date.now();
  const hits = (wpgHits.get(ip) || []).filter(t => now - t < 60000);
  hits.push(now);
  wpgHits.set(ip, hits);
  if (wpgHits.size > 5000) wpgHits.clear();
  return hits.length <= 5;
}
const wpgEsc = escHtml;
let wpgIndexed = false;

app.post('/api/winnipeg/signup', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (!wpgRateOk(ip)) return res.status(429).json({ success: false, error: 'Too many tries — please wait a minute.' });
    const { name, email, phone, area, consent, website } = req.body || {};
    if (website) return res.json({ success: true });  // honeypot: bots fill the hidden field
    const emailNorm = String(email || '').trim().toLowerCase();
    if (emailNorm.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email.' });
    }
    if (consent !== true) return res.status(400).json({ success: false, error: 'Please tick the box so we can email you the opening news.' });

    const database = await connectDB();
    if (!database) return res.status(500).json({ success: false, error: 'Sign-ups are unavailable right now — please try again soon.' });
    const col = database.collection('winnipeg_signups');
    if (!wpgIndexed) { await col.createIndex({ email_normalized: 1 }, { unique: true }); await col.createIndex({ unsubscribe_token: 1 }); wpgIndexed = true; }

    const existing = await col.findOne({ email_normalized: emailNorm });
    if (existing && !existing.unsubscribed) return res.json({ success: true, already: true });

    const token = require('crypto').randomBytes(16).toString('hex');
    const doc = {
      name: String(name || '').trim().slice(0, 60),
      email: String(email).trim().slice(0, 200),
      email_normalized: emailNorm,
      phone: String(phone || '').trim().slice(0, 30),
      area: String(area || '').trim().slice(0, 80),
      consent_marketing: true,
      consent_text: 'Yes, Wing-O Restaurants may email me about the Winnipeg opening and Wing-O deals. I can unsubscribe at any time.',
      consent_at: new Date(),
      unsubscribed: false,
      unsubscribe_token: token,
      created_at: existing ? existing.created_at : new Date(),
      ip,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 300)
    };
    try {
      if (existing) await col.updateOne({ _id: existing._id }, { $set: doc });  // re-subscribe after unsubscribing
      else await col.insertOne(doc);
    } catch (e) {
      if (e.code === 11000) return res.json({ success: true, already: true });
      throw e;
    }

    const unsubUrl = `https://wingorestaurants.com/api/winnipeg/unsubscribe?t=${token}`;
    sendEmail({
      to: doc.email,
      subject: "🍗 You're on the Wing-O Winnipeg list",
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#F4EBD7;">
        <div style="background:#0D0D0D;padding:22px;text-align:center;border-bottom:3px double #F5A800;"><h1 style="color:#E8190A;margin:0;letter-spacing:2px;">WING<span style="color:white;">-O</span></h1><p style="color:#F5A800;margin:6px 0 0;font-size:12px;letter-spacing:3px;">WINNIPEG · COMING SOON</p></div>
        <div style="padding:24px;color:#1A1208;font-size:15px;line-height:1.6;">
          <p style="font-size:18px;font-weight:bold;margin:0 0 10px;">Hey${doc.name ? ' ' + wpgEsc(doc.name) : ''}! 👋</p>
          <p>You're on the list. When Wing-O opens in Winnipeg, you'll be the first to hear the date — plus any opening-week deals.</p>
          <p>135+ flavours, crispy wings, boneless, chicken fingers and fried chicken burgers. Winnipeg, get ready.</p>
          <p style="margin-top:22px;">— The Sauce Boss 🌾<br><span style="color:#888;font-size:13px;">Wing-O Restaurants · Regina, Saskatchewan</span></p>
        </div>
        <div style="padding:14px 24px;color:#888;font-size:12px;text-align:center;">You signed up at wingorestaurants.com/winnipeg. <a href="${unsubUrl}" style="color:#888;">Unsubscribe</a></div>
      </div>`
    });

    console.log(`🚀 Winnipeg sign-up: ${emailNorm}${doc.area ? ' (' + doc.area + ')' : ''}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Winnipeg signup error:', e.message);
    res.status(500).json({ success: false, error: 'Something went wrong — please try again.' });
  }
});

app.get('/api/winnipeg/unsubscribe', async (req, res) => {
  const t = String(req.query.t || '');
  const page = msg => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wing-O</title></head><body style="font-family:Arial,sans-serif;background:#F4EBD7;text-align:center;padding:60px 20px;"><h1 style="color:#E8190A;">WING-O</h1><p style="font-size:17px;">${msg}</p><p><a href="/" style="color:#E8190A;">Back to Wing-O</a></p></body></html>`;
  if (!/^[a-f0-9]{32}$/.test(t)) return res.status(400).send(page('That unsubscribe link is not valid.'));
  try {
    const database = await connectDB();
    if (!database) return res.status(500).send(page('Please try again in a few minutes.'));
    const r = await database.collection('winnipeg_signups').updateOne({ unsubscribe_token: t }, { $set: { unsubscribed: true, unsubscribed_at: new Date() } });
    if (!r.matchedCount) return res.status(404).send(page('We couldn\'t find that sign-up — you may already be unsubscribed.'));
    res.send(page('You\'re unsubscribed from Wing-O Winnipeg emails. Sorry to see you go! 🍗'));
  } catch (e) {
    res.status(500).send(page('Please try again in a few minutes.'));
  }
});

// Owner-only list. Needs ADMIN_PASSWORD set on Railway (no built-in fallback).
app.post('/api/winnipeg/list', async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: 'Set ADMIN_PASSWORD on Railway to view sign-ups.' });
  const given = String((req.body || {}).password || '');
  const crypto = require('crypto');
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong password' });
  try {
    const database = await connectDB();
    if (!database) return res.status(500).json({ error: 'Database unavailable' });
    const rows = await database.collection('winnipeg_signups')
      .find({}, { projection: { _id: 0, name: 1, email: 1, phone: 1, area: 1, created_at: 1, unsubscribed: 1 } })
      .sort({ created_at: -1 }).limit(20000).toArray();
    const safe = rows.map(r => ({ name: r.name, email: r.email, phone: r.phone, area: r.area, created_at: r.created_at, unsubscribed: !!r.unsubscribed }));
    res.json({ total: safe.length, subscribed: safe.filter(r => !r.unsubscribed).length, rows: safe });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ── WINNIPEG EMAILS: SEND TO THE WHOLE LIST ───────────────────
// The owner picks an email and sends it from /winnipeg-admin. Rules (per email):
//  • only sign-ups that are still subscribed, each with their own unsubscribe link
//  • each sign-up gets this email once: it is marked on the sign-up (campaigns.<id>)
//    before sending, so a double click or a second server never sends it twice
//  • sent through Resend's batch API, 100 emails per call, under its 2 calls/second limit
//  • if a batch fails, those people are marked "error" and the next Send retries only them
const wpgOpening = require('./winnipeg-opening-email');
const wpgGameNight = require('./winnipeg-gamenight-email');
// Newest first: the admin page picks the first one by default.
const WPG_CAMPAIGNS = [wpgGameNight, wpgOpening];
const wpgCampaign = id => WPG_CAMPAIGNS.find(c => c.ID === id) || WPG_CAMPAIGNS[0];
const WPG_FROM = 'Wing-O Restaurants <orders@wingorestaurants.com>';
const wpgKey = c => `campaigns.${c.ID}`;
const wpgPendingQuery = c => ({ unsubscribed: { $ne: true }, unsubscribe_token: { $exists: true }, [`${wpgKey(c)}.status`]: { $nin: ['sent', 'claimed'] } });
let wpgCampaignRunning = false, wpgCampaignLast = null;

function wpgEmailFor(c, row, test) {
  const unsubUrl = test ? 'https://wingorestaurants.com/winnipeg' : `https://wingorestaurants.com/api/winnipeg/unsubscribe?t=${row.unsubscribe_token}`;
  return {
    from: WPG_FROM, to: [row.email], reply_to: 'besaucy@wingorestaurants.com',
    subject: (test ? '[TEST] ' : '') + c.SUBJECT,
    html: c.render({ name: row.name, unsubUrl }),
    headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
  };
}
async function wpgSendBatch(items) {
  const r = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(d.data)) throw new Error(d.message || `Resend error ${r.status}`);
  return d.data.length;
}
async function wpgCampaignCounts(col, c) {
  const f = `${wpgKey(c)}.status`;
  const [subscribed, sent, failed, pending] = await Promise.all([
    col.countDocuments({ unsubscribed: { $ne: true } }),
    col.countDocuments({ [f]: 'sent' }),
    col.countDocuments({ unsubscribed: { $ne: true }, [f]: 'error' }),
    col.countDocuments(wpgPendingQuery(c)),
  ]);
  return { subscribed, sent, failed, pending };
}
// Sends campaign c to every pending row of col (Winnipeg sign-ups or the customer list).
// pendingQuery(c) selects who still needs it; emailFor(c, row) builds each email. Progress goes into run.
async function runListCampaign(col, c, pendingQuery, emailFor, run, label) {
  const KEY = `campaigns.${c.ID}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    for (let round = 0; round < 400; round++) {
      const rows = await col.find(pendingQuery(c), { projection: { _id: 1, email: 1, name: 1, unsubscribe_token: 1 } }).limit(100).toArray();
      if (!rows.length) break;
      const claimed = [];
      for (const row of rows) {
        const u = await col.updateOne({ _id: row._id, ...pendingQuery(c) }, { $set: { [KEY]: { status: 'claimed', at: new Date() } } });
        if (u.modifiedCount) claimed.push(row);
      }
      if (!claimed.length) continue;
      const ids = claimed.map(r => r._id);
      try {
        await wpgSendBatch(claimed.map(r => emailFor(c, r)));
        await col.updateMany({ _id: { $in: ids } }, { $set: { [KEY]: { status: 'sent', at: new Date() } } });
        run.sent += claimed.length;
      } catch (e) {
        const msg = String(e.message).slice(0, 200);
        console.warn(`${label} email batch failed:`, msg);
        if (/rate|too many/i.test(msg)) {   // too fast: put them back and slow down
          await col.updateMany({ _id: { $in: ids } }, { $unset: { [KEY]: '' } });
          await sleep(3000); continue;
        }
        // One bad address fails the whole batch, so send this batch one by one
        let ok = 0;
        for (const r of claimed) {
          try {
            await wpgSendBatch([emailFor(c, r)]);
            await col.updateOne({ _id: r._id }, { $set: { [KEY]: { status: 'sent', at: new Date() } } }); ok++;
          } catch (e1) {
            const m1 = String(e1.message).slice(0, 200);
            await col.updateOne({ _id: r._id }, { $set: { [KEY]: { status: 'error', at: new Date(), message: m1 } } });
            run.failed++; run.error = m1;
          }
          await sleep(600);
        }
        run.sent += ok;
        if (!ok) break;   // nothing goes through (e.g. bad API key or daily limit): stop, the owner can retry
      }
      await sleep(700);
    }
  } catch (e) {
    run.error = String(e.message).slice(0, 200);
    console.warn(`${label} email job error:`, run.error);
  }
}
async function runWpgCampaign(col, c) {
  const run = { campaign: c.ID, started: new Date(), sent: 0, failed: 0, error: null, finished: null };
  wpgCampaignLast = run;
  try {
    await runListCampaign(col, c, wpgPendingQuery, wpgEmailFor, run, 'Winnipeg');
  } finally {
    run.finished = new Date();
    wpgCampaignRunning = false;
    console.log(`📣 Winnipeg email ${c.ID}: ${run.sent} sent, ${run.failed} failed`);
  }
}
async function wpgAdminCol(req, res) {
  if (!isAdmin((req.body || {}).password)) { res.status(401).json({ error: 'Wrong password' }); return null; }
  const database = await connectDB();
  if (!database) { res.status(500).json({ error: 'Database unavailable' }); return null; }
  return database.collection('winnipeg_signups');
}

app.post('/api/winnipeg/campaign/status', async (req, res) => {
  try {
    const col = await wpgAdminCol(req, res); if (!col) return;
    const c = wpgCampaign((req.body || {}).campaign);
    const last = wpgCampaignLast && wpgCampaignLast.campaign === c.ID ? wpgCampaignLast : null;
    res.json({
      campaign: c.ID, subject: c.SUBJECT,
      campaigns: WPG_CAMPAIGNS.map(x => ({ id: x.ID, label: x.LABEL || x.SUBJECT })),
      ...(await wpgCampaignCounts(col, c)), running: wpgCampaignRunning, runningCampaign: wpgCampaignRunning && wpgCampaignLast ? wpgCampaignLast.campaign : null,
      last, emailReady: !!process.env.RESEND_API_KEY,
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/winnipeg/campaign/preview', (req, res) => {
  if (!isAdmin((req.body || {}).password)) return res.status(401).json({ error: 'Wrong password' });
  const c = wpgCampaign((req.body || {}).campaign);
  res.json({ subject: c.SUBJECT, html: c.render({ name: '', unsubUrl: '#' }) });
});

app.post('/api/winnipeg/campaign/test', async (req, res) => {
  try {
    const col = await wpgAdminCol(req, res); if (!col) return;
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Set RESEND_API_KEY on Railway first.' });
    const email = String((req.body || {}).email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    await wpgSendBatch([wpgEmailFor(wpgCampaign(req.body.campaign), { email, name: '' }, true)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e.message || 'Send failed').slice(0, 200) }); }
});

app.post('/api/winnipeg/campaign/send', async (req, res) => {
  try {
    const col = await wpgAdminCol(req, res); if (!col) return;
    if (req.body.confirm !== 'SEND') return res.status(400).json({ error: 'Not confirmed.' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Set RESEND_API_KEY on Railway first.' });
    if (wpgCampaignRunning) return res.status(409).json({ error: 'Already sending. Watch the progress below.' });
    const c = wpgCampaign(req.body.campaign);
    const { pending } = await wpgCampaignCounts(col, c);
    if (!pending) return res.json({ success: true, started: false, pending: 0 });
    wpgCampaignRunning = true;
    runWpgCampaign(col, c);   // runs in the background; the page polls /status
    res.json({ success: true, started: true, pending });
  } catch (e) { wpgCampaignRunning = false; res.status(500).json({ error: 'server error' }); }
});

// ── EMAILS TO ALL CUSTOMERS ───────────────────────────────────
// The owner sends deal emails to everyone who gave us an email, from /email-admin.
// The list (customer_list, one row per email address) is rebuilt from:
//  • website orders from the last 2 years (CASL implied consent: a purchase in the past 2 years)
//  • Rewards (loyalty) members active in the last 2 years
//  • Winnipeg sign-ups who ticked the consent box and haven't unsubscribed
// Anyone in email_optouts (any Wing-O unsubscribe) or unsubscribed from the Winnipeg list is left out.
// Sending reuses the Winnipeg rules: each person once per email, own unsubscribe link, batches of 100.
const CUSTOMER_CAMPAIGNS = [require('./customer-thursday-email')];   // newest first
const custCampaign = id => CUSTOMER_CAMPAIGNS.find(c => c.ID === id) || CUSTOMER_CAMPAIGNS[0];
const custPendingQuery = c => ({ unsubscribed: { $ne: true }, unsubscribe_token: { $exists: true }, [`campaigns.${c.ID}.status`]: { $nin: ['sent', 'claimed'] } });
const CUST_CONSENT_DAYS = 730;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let custCampaignRunning = false, custCampaignLast = null, custIndexed = false, custSync = null;

async function syncCustomerList(database) {
  const col = database.collection('customer_list');
  if (!custIndexed) { await col.createIndex({ email_normalized: 1 }, { unique: true }); await col.createIndex({ unsubscribe_token: 1 }); custIndexed = true; }
  const since = new Date(Date.now() - CUST_CONSENT_DAYS * 86400000);
  const found = new Map();
  const add = (email, name, at, source) => {
    email = String(email || '').trim();
    const norm = email.toLowerCase();
    if (!EMAIL_RE.test(norm) || norm.length > 254) return;
    const f = found.get(norm) || { email, name: '', last: new Date(0), sources: new Set() };
    const when = at ? new Date(at) : new Date(0);
    if (name && (!f.name || when >= f.last)) f.name = String(name).trim().slice(0, 80);
    if (when > f.last) f.last = when;
    f.sources.add(source);
    found.set(norm, f);
  };
  const orders = await database.collection('orders').find(
    { 'customer.email': { $regex: '@' }, createdAt: { $gte: since } },
    { projection: { 'customer.email': 1, 'customer.firstName': 1, createdAt: 1 } }).toArray();
  orders.forEach(o => add(o.customer.email, o.customer.firstName, o.createdAt, 'order'));
  const members = await database.collection('loyalty').find(
    { email: { $regex: '@' }, $or: [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }] },
    { projection: { email: 1, name: 1, createdAt: 1, updatedAt: 1 } }).toArray();
  members.forEach(m => add(m.email, m.name, m.updatedAt || m.createdAt, 'rewards'));
  const wpgCol = database.collection('winnipeg_signups');
  const signups = await wpgCol.find({ unsubscribed: { $ne: true } }, { projection: { email: 1, name: 1, created_at: 1 } }).toArray();
  signups.forEach(s => add(s.email, s.name, s.created_at, 'winnipeg'));

  // Everyone who unsubscribed from anything Wing-O sends
  const out = new Set((await database.collection('email_optouts').find({}, { projection: { email_normalized: 1 } }).toArray()).map(x => x.email_normalized));
  (await wpgCol.find({ unsubscribed: true }, { projection: { email_normalized: 1, email: 1 } }).toArray())
    .forEach(x => out.add(x.email_normalized || String(x.email || '').trim().toLowerCase()));

  const ops = [];
  for (const [norm, f] of found) {
    if (out.has(norm)) continue;
    ops.push({ updateOne: {
      filter: { email_normalized: norm },
      update: {
        $set: { email: f.email, name: f.name, last_seen_at: f.last, sources: [...f.sources] },
        $setOnInsert: { email_normalized: norm, unsubscribe_token: require('crypto').randomBytes(16).toString('hex'), unsubscribed: false, created_at: new Date() },
      },
      upsert: true,
    } });
  }
  for (let i = 0; i < ops.length; i += 500) await col.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  if (out.size) await col.updateMany({ email_normalized: { $in: [...out] }, unsubscribed: { $ne: true } }, { $set: { unsubscribed: true, unsubscribed_at: new Date() } });
  return col;
}
// Rebuild at most once a minute (the admin page polls status while sending)
async function customerListCol(database, force) {
  if (force || !custSync || Date.now() - custSync.at > 60000) {
    const p = syncCustomerList(database);
    custSync = { at: Date.now(), p };
    p.catch(() => { custSync = null; });
  }
  return custSync.p;
}
function custEmailFor(c, row, test) {
  const unsubUrl = test ? 'https://wingorestaurants.com/' : `https://wingorestaurants.com/api/customers/unsubscribe?t=${row.unsubscribe_token}`;
  return {
    from: WPG_FROM, to: [row.email], reply_to: 'besaucy@wingorestaurants.com',
    subject: (test ? '[TEST] ' : '') + c.SUBJECT,
    html: c.render({ name: row.name, unsubUrl }),
    headers: { 'List-Unsubscribe': `<${unsubUrl}>` },
  };
}
async function custAdminCol(req, res, force) {
  if (!isAdmin((req.body || {}).password)) { res.status(401).json({ error: 'Wrong password' }); return null; }
  const database = await connectDB();
  if (!database) { res.status(500).json({ error: 'Database unavailable' }); return null; }
  return customerListCol(database, force);
}

app.post('/api/customers/campaign/status', async (req, res) => {
  try {
    const col = await custAdminCol(req, res); if (!col) return;
    const c = custCampaign((req.body || {}).campaign);
    const f = `campaigns.${c.ID}.status`;
    const live = { unsubscribed: { $ne: true } };
    const [subscribed, unsubscribed, sent, failed, pending, fromOrders, fromRewards, fromWinnipeg] = await Promise.all([
      col.countDocuments(live), col.countDocuments({ unsubscribed: true }),
      col.countDocuments({ [f]: 'sent' }), col.countDocuments({ ...live, [f]: 'error' }), col.countDocuments(custPendingQuery(c)),
      col.countDocuments({ ...live, sources: 'order' }), col.countDocuments({ ...live, sources: 'rewards' }), col.countDocuments({ ...live, sources: 'winnipeg' }),
    ]);
    const last = custCampaignLast && custCampaignLast.campaign === c.ID ? custCampaignLast : null;
    res.json({
      campaign: c.ID, subject: c.SUBJECT,
      campaigns: CUSTOMER_CAMPAIGNS.map(x => ({ id: x.ID, label: x.LABEL || x.SUBJECT })),
      subscribed, unsubscribed, sent, failed, pending, fromOrders, fromRewards, fromWinnipeg,
      running: custCampaignRunning, last, emailReady: !!process.env.RESEND_API_KEY,
    });
  } catch (e) { console.warn('Customer list error:', e.message); res.status(500).json({ error: 'server error' }); }
});

// The subscribed list as rows, for the Download CSV button (to move the list to another email tool)
app.post('/api/customers/campaign/list', async (req, res) => {
  try {
    const col = await custAdminCol(req, res, true); if (!col) return;
    const rows = await col.find({ unsubscribed: { $ne: true } }, { projection: { _id: 0, email: 1, name: 1, sources: 1, last_seen_at: 1 } })
      .sort({ last_seen_at: -1 }).limit(50000).toArray();
    res.json({ rows: rows.map(r => ({ email: r.email, name: r.name || '', sources: (r.sources || []).join(' '), last_seen_at: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : '' })) });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

app.post('/api/customers/campaign/preview', (req, res) => {
  if (!isAdmin((req.body || {}).password)) return res.status(401).json({ error: 'Wrong password' });
  const c = custCampaign((req.body || {}).campaign);
  res.json({ subject: c.SUBJECT, html: c.render({ name: '', unsubUrl: '#' }) });
});

app.post('/api/customers/campaign/test', async (req, res) => {
  try {
    if (!isAdmin((req.body || {}).password)) return res.status(401).json({ error: 'Wrong password' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Set RESEND_API_KEY on Railway first.' });
    const email = String((req.body || {}).email || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    await wpgSendBatch([custEmailFor(custCampaign(req.body.campaign), { email, name: '' }, true)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e.message || 'Send failed').slice(0, 200) }); }
});

app.post('/api/customers/campaign/send', async (req, res) => {
  try {
    if (!isAdmin((req.body || {}).password)) return res.status(401).json({ error: 'Wrong password' });
    if ((req.body || {}).confirm !== 'SEND') return res.status(400).json({ error: 'Not confirmed.' });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Set RESEND_API_KEY on Railway first.' });
    if (custCampaignRunning) return res.status(409).json({ error: 'Already sending. Watch the progress below.' });
    const col = await custAdminCol(req, res, true); if (!col) return;   // fresh list, so new unsubscribes are honoured
    const c = custCampaign(req.body.campaign);
    const pending = await col.countDocuments(custPendingQuery(c));
    if (!pending) return res.json({ success: true, started: false, pending: 0 });
    custCampaignRunning = true;
    const run = { campaign: c.ID, started: new Date(), sent: 0, failed: 0, error: null, finished: null };
    custCampaignLast = run;
    runListCampaign(col, c, custPendingQuery, custEmailFor, run, 'Customer')   // background; the page polls /status
      .finally(() => { run.finished = new Date(); custCampaignRunning = false; console.log(`📣 Customer email ${c.ID}: ${run.sent} sent, ${run.failed} failed`); });
    res.json({ success: true, started: true, pending });
  } catch (e) { custCampaignRunning = false; res.status(500).json({ error: 'server error' }); }
});

app.get('/api/customers/unsubscribe', async (req, res) => {
  const t = String(req.query.t || '');
  const page = msg => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wing-O</title></head><body style="font-family:Arial,sans-serif;background:#F4EBD7;text-align:center;padding:60px 20px;"><h1 style="color:#E8190A;">WING-O</h1><p style="font-size:17px;">${msg}</p><p><a href="/" style="color:#E8190A;">Back to Wing-O</a></p></body></html>`;
  if (!/^[a-f0-9]{32}$/.test(t)) return res.status(400).send(page('That unsubscribe link is not valid.'));
  try {
    const database = await connectDB();
    if (!database) return res.status(500).send(page('Please try again in a few minutes.'));
    const row = await database.collection('customer_list').findOne({ unsubscribe_token: t });
    if (!row) return res.status(404).send(page('We couldn\'t find that link. You may already be unsubscribed.'));
    await database.collection('customer_list').updateOne({ _id: row._id }, { $set: { unsubscribed: true, unsubscribed_at: new Date() } });
    await database.collection('email_optouts').updateOne(
      { email_normalized: row.email_normalized },
      { $set: { email_normalized: row.email_normalized, source: 'customer-email', at: new Date() } },
      { upsert: true });
    res.send(page('You\'re unsubscribed from Wing-O emails. Sorry to see you go! 🍗'));
  } catch (e) {
    res.status(500).send(page('Please try again in a few minutes.'));
  }
});


// ── SPA FALLBACK ───────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────
// ========================================================
// 🎁 REFERRAL PROGRAM (added at end — safe paste)
// ========================================================

function generateReferralCode(name, phone) {
  const cleanName = (name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6) || 'WINGO';
  const phoneSuffix = (phone || '').replace(/\D/g, '').slice(-4) || Math.floor(1000 + Math.random() * 9000);
  return cleanName + phoneSuffix;
}

async function creditReferralBonus(referrerCode, newMemberPhone, newMemberName) {
  if (!referrerCode || !newMemberPhone) return null;
  try {
    const database = await connectDB();
    if (!database) return null;
    const referrer = await database.collection('loyalty').findOne({ referralCode: referrerCode });
    if (!referrer) {
      console.log(`⚠️ Referral code ${referrerCode} not found`);
      return null;
    }
    if (loyaltyPhone(referrer.phone) === loyaltyPhone(newMemberPhone)) {
      console.log(`⚠️ Self-referral blocked: ${referrerCode}`);
      return null;
    }
    const newReferrerStamps = (referrer.stamps || 0) + 1;
    const gotFree = newReferrerStamps >= 10;
    const finalStamps = gotFree ? 0 : newReferrerStamps;
    const newFreeEarned = gotFree ? (referrer.freeEarned || 0) + 1 : (referrer.freeEarned || 0);
    const newTotalOrders = (referrer.totalOrders || 0) + 1;
    const newReferralCount = (referrer.referralCount || 0) + 1;
    const newHistory = [
      { orderNum: 'REF-' + newMemberName.split(' ')[0], date: new Date().toLocaleDateString('en-CA'), stamp: newTotalOrders, referral: true },
      ...(referrer.history || [])
    ].slice(0, 50);
    await database.collection('loyalty').updateOne(
      { referralCode: referrerCode },
      {
        $set: {
          stamps: finalStamps,
          totalOrders: newTotalOrders,
          freeEarned: newFreeEarned,
          referralCount: newReferralCount,
          history: newHistory,
          updatedAt: new Date()
        }
      }
    );
    console.log(`🎁 REFERRAL: ${referrer.name} earned a stamp from ${newMemberName}`);
    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🎁 NEW REFERRAL — ${referrer.name} brought in ${newMemberName}`,
      html: `<div style="font-family:Arial;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;">
        <h2 style="color:#F5A800;margin:0 0 16px;">🎁 Referral Activated!</h2>
        <table style="width:100%;color:#CCC;font-size:14px;">
          <tr><td style="padding:6px 0;color:#888;">Referrer</td><td><strong style="color:white;">${referrer.name}</strong></td></tr>
          <tr><td style="padding:6px 0;color:#888;">Code</td><td>${referrerCode}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">New Member</td><td>${newMemberName}</td></tr>
          <tr><td style="padding:6px 0;color:#888;">Total Referrals</td><td style="color:#F5A800;font-weight:bold;">${newReferralCount}</td></tr>
          ${gotFree ? '<tr><td style="padding:6px 0;color:#E8190A;font-weight:bold;">🎉 EARNED FREE WINGS!</td><td></td></tr>' : ''}
        </table>
      </div>`
    });
    return { success: true, gotFree, referrerName: referrer.name };
  } catch (e) {
    console.error('Referral credit error:', e.message);
    return null;
  }
}

// New signup endpoint that handles referrals
app.post('/api/loyalty/signup-v2', async (req, res) => {
  const { name, email, phone, referralCode } = req.body;
  if (!name || !email || !phone) return res.json({ success: false, error: 'Missing fields' });
  const cleanPhone = loyaltyPhone(phone);
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const existing = await database.collection('loyalty').findOne(loyaltyPhoneQuery(cleanPhone));
    if (existing) return res.json({ success: false, error: 'Phone already registered' });
    const myReferralCode = generateReferralCode(name, cleanPhone);
    let initialStamps = 0;
    let referralBonus = null;
    if (referralCode) {
      const result = await creditReferralBonus(referralCode, cleanPhone, name);
      if (result && result.success) {
        initialStamps = 1;
        referralBonus = result;
      }
    }
    const member = {
      name, email, phone: cleanPhone,
      stamps: initialStamps, totalOrders: initialStamps, freeEarned: 0, freeRedeemed: 0, cardToken: newCardToken(),
      referralCode: myReferralCode, referralCount: 0, referredBy: referralCode || null,
      usedOrderNums: [], history: initialStamps > 0 ? [{ orderNum: 'WELCOME-REF', date: new Date().toLocaleDateString('en-CA'), stamp: 1, referral: true }] : [],
      joinDate: new Date().toISOString(), createdAt: new Date()
    };
    await database.collection('loyalty').insertOne(member);
    console.log(`🍗 New loyalty member: ${name} — ${cleanPhone}${referralBonus ? ' (referred by ' + referralBonus.referrerName + ')' : ''}`);
    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `🍗 New Saucy Stamps Member — ${name}${referralBonus ? ' (REFERRAL!)' : ''}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0D0D0D;padding:24px;border-radius:8px;">
        <h2 style="color:#F5A800;font-size:22px;margin:0 0 16px;">New Saucy Stamps Member! 🍗</h2>
        <table style="width:100%;color:#CCC;font-size:14px;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#888;width:80px;">Name</td><td style="font-weight:bold;color:white;">${name}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Email</td><td>${email}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Phone</td><td>${cleanPhone}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Code</td><td style="color:#F5A800;">${myReferralCode}</td></tr>
          ${referralBonus ? `<tr><td style="padding:8px 0;color:#E8190A;font-weight:bold;">Referred By</td><td>${referralBonus.referrerName} 🎁</td></tr>` : ''}
        </table>
      </div>`
    });
    res.json({ success: true, member: publicCard(member), referralBonus });
  } catch (e) {
    console.error('Loyalty signup-v2 error:', e.message);
    res.json({ success: false, error: 'Signup failed' });
  }
});

// Look up referrer info from a code
app.get('/api/loyalty/referral-info/:code', async (req, res) => {
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne({ referralCode: req.params.code });
    if (!member) return res.json({ success: false, error: 'Invalid referral code' });
    res.json({ success: true, referrerName: member.name.split(' ')[0], referralCode: member.referralCode });
  } catch (e) { res.json({ success: false, error: 'Lookup failed' }); }
});

// One-time migration: give existing members their referral codes
app.post('/api/loyalty/migrate-codes', async (req, res) => {
  if (!isAdmin(req.body.password)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const database = await connectDB();
    const members = await database.collection('loyalty').find({ referralCode: { $exists: false } }).toArray();
    let migrated = 0;
    for (const m of members) {
      const code = generateReferralCode(m.name, m.phone);
      await database.collection('loyalty').updateOne({ _id: m._id }, { $set: { referralCode: code, referralCount: 0 } });
      migrated++;
    }
    res.json({ success: true, migrated });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Pretty URL for share links: wingorestaurants.com/r/MIKE2024
app.get('/r/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========================================================
// 👥 CUSTOMER DATABASE — Aggregates all customers from orders
// ========================================================
app.get('/customers', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'customers.html')); });
app.get('/customers.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'customers.html')); });

app.get('/api/customers', async (req, res) => {
  const { password } = req.query;
  if (!isAdmin(password)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });

    // Aggregate ALL orders by phone number
    const orders = await database.collection('orders').find({}).sort({ createdAt: -1 }).toArray();
    const loyaltyMembers = await database.collection('loyalty').find({}).toArray();

    // Build a phone -> loyalty member map
    const loyaltyMap = {};
    loyaltyMembers.forEach(m => {
      if (m.phone) loyaltyMap[m.phone] = m;
    });

    // Aggregate orders by customer phone
    const customerMap = {};
    orders.forEach(o => {
      const phone = (o.customer?.phone || '').replace(/\D/g, '');
      if (!phone || phone.length < 10) return;
      if (!customerMap[phone]) {
        customerMap[phone] = {
          phone,
          firstName: o.customer?.firstName || '',
          lastName: o.customer?.lastName || '',
          email: o.customer?.email || '',
          firstOrderDate: o.createdAt,
          lastOrderDate: o.createdAt,
          totalOrders: 0,
          totalRevenue: 0,
          locations: {},
          orderTypes: { pickup: 0, delivery: 0 },
          orders: []
        };
      }
      const c = customerMap[phone];
      c.totalOrders++;
      c.totalRevenue += Number(o.total) || 0;
      if (new Date(o.createdAt) < new Date(c.firstOrderDate)) c.firstOrderDate = o.createdAt;
      if (new Date(o.createdAt) > new Date(c.lastOrderDate)) c.lastOrderDate = o.createdAt;
      const loc = o.locationId || 'unknown';
      c.locations[loc] = (c.locations[loc] || 0) + 1;
      const otype = o.orderType || 'pickup';
      c.orderTypes[otype] = (c.orderTypes[otype] || 0) + 1;
      c.orders.push({
        orderNum: o.orderNum,
        date: o.createdAt,
        total: o.total,
        location: o.locationId,
        orderType: o.orderType,
        items: o.items?.length || 0,
        discountApplied: o.firstOrderDiscount || 0
      });
      // Always use latest name/email if missing
      if (!c.firstName && o.customer?.firstName) c.firstName = o.customer.firstName;
      if (!c.email && o.customer?.email) c.email = o.customer.email;
    });

    // Convert to array + enrich with loyalty data
    const customers = Object.values(customerMap).map(c => {
      const loyalty = loyaltyMap[c.phone];
      // Find favorite location
      let favLocation = '';
      let maxCount = 0;
      Object.entries(c.locations).forEach(([loc, count]) => {
        if (count > maxCount) { maxCount = count; favLocation = loc; }
      });
      return {
        ...c,
        avgOrderValue: c.totalRevenue / c.totalOrders,
        favoriteLocation: favLocation,
        isLoyaltyMember: !!loyalty,
        loyaltyStamps: loyalty?.stamps || 0,
        loyaltyTotalOrders: loyalty?.totalOrders || 0,
        loyaltyFreeEarned: loyalty?.freeEarned || 0,
        referralCode: loyalty?.referralCode || '',
        referralCount: loyalty?.referralCount || 0
      };
    });

    // Sort by most recent order by default
    customers.sort((a, b) => new Date(b.lastOrderDate) - new Date(a.lastOrderDate));

    // Compute summary stats
    const now = new Date();
    const reginaNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Regina' }));
    const todayStart = new Date(reginaNow); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart); monthStart.setDate(monthStart.getDate() - 30);

    const stats = {
      totalCustomers: customers.length,
      newToday: customers.filter(c => new Date(c.firstOrderDate) >= todayStart).length,
      newThisWeek: customers.filter(c => new Date(c.firstOrderDate) >= weekStart).length,
      newThisMonth: customers.filter(c => new Date(c.firstOrderDate) >= monthStart).length,
      totalOrders: customers.reduce((s, c) => s + c.totalOrders, 0),
      totalRevenue: customers.reduce((s, c) => s + c.totalRevenue, 0),
      avgLifetimeValue: customers.length ? customers.reduce((s, c) => s + c.totalRevenue, 0) / customers.length : 0,
      loyaltyMembers: customers.filter(c => c.isLoyaltyMember).length,
      repeatCustomers: customers.filter(c => c.totalOrders > 1).length
    };

    res.json({ success: true, customers, stats });
  } catch (e) {
    console.error('[Customers] Error:', e.message);
    res.json({ success: false, error: e.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔥 Wing-O server on port ${PORT}`);
  console.log(`   Locations: ${Object.keys(LOCATIONS).join(', ')}\n`);
});
