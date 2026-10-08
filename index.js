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
app.use(cors());
app.use(express.json());
// extensions: lets clean URLs like /regina-albert-st serve regina-albert-st.html (SEO pages)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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

// ── LOCATION CONFIG ────────────────────────────────────────────
const LOCATIONS = {
  "albert-st": {
    name: "Albert Street (Regina)",
    merchantId: process.env.CLOVER_MERCHANT_ID_ALBERT || "98YG45GQNN8X1",
    apiToken: process.env.CLOVER_API_TOKEN_ALBERT,
    address: "#3 - 155 Albert St N, Regina, SK",
    phone: "639-997-0553", // TEMP: Albert St line having technical issues. Revert to 306-522-2111.
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: false,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_ALBERT
  },
  "east-regina": {
    name: "East Regina (Wing-O East)",
    merchantId: process.env.CLOVER_MERCHANT_ID_EAST || "4BB1SFERQNQF1",
    apiToken: process.env.CLOVER_API_TOKEN_EAST,
    address: "534 University Park Drive, Regina, SK",
    phone: "306-522-2114",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: false,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_EAST
  },
  "regina-beach": {
    name: "Regina Beach",
    merchantId: process.env.CLOVER_MERCHANT_ID_BEACH || "WSTB4D3E5RAG1",
    apiToken: process.env.CLOVER_API_TOKEN_BEACH,
    address: "110 Centre St, Regina Beach, SK",
    phone: "639-997-0553",
    hours: "Every Day 11am-10pm",
    onlinePayments: false,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_BEACH
  }
};

// ── KITCHEN AUTH ──────────────────────────────────────────────
function getKitchenPassword(loc) {
  switch(loc) {
    case 'albert-st':   return process.env.KITCHEN_PW_ALBERT;
    case 'east-regina': return process.env.KITCHEN_PW_EAST;
    case 'regina-beach': return process.env.KITCHEN_PW_BEACH;
    default: return null;
  }
}
function checkKitchenAuth(loc, pw) {
  const expected = getKitchenPassword(loc);
  return !!expected && pw === expected;
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
function isAdmin(pw) {
  const expected = process.env.ADMIN_PASSWORD;
  return !!expected && typeof pw === 'string' && pw === expected;
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
async function createCloverOrder(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp) {
  const orderNote = `
=================================
WING-O ONLINE ORDER
=================================
ORDER #: ${orderNum}
TIME: ${timestamp}
TYPE: ${orderType.toUpperCase()}
LOCATION: ${loc.name}
---------------------------------
CUSTOMER
  Name:  ${customer.firstName} ${customer.lastName || ''}
  Phone: ${customer.phone}
  Email: ${customer.email || 'N/A'}
${orderType === 'delivery' ? `  Deliver to: ${customer.address}` : '  PICKUP at store'}
---------------------------------
ITEMS
${items.map(i => `  ${i.name}${i.flavor ? ' [' + i.flavor + ']' : ''} x${i.qty}  $${(i.price * i.qty).toFixed(2)}`).join('\n')}
---------------------------------
  Subtotal: $${Number(subtotal).toFixed(2)}
  GST (5%): $${(Number(subtotal) * 0.05).toFixed(2)}
  PST (6%): $${(Number(subtotal) * 0.06).toFixed(2)}
${orderType === 'delivery' ? `  Delivery: $5.50` : ''}
---------------------------------
${notes ? 'NOTES: ' + notes : ''}
PAY AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}
=================================`.trim();

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
      const itemName = item.flavor ? `${item.name} [${item.flavor}]` : item.name;
      const lineResp = await fetch(
        `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: itemName, price: Math.round(item.price * 100), unitQty: 1000, note: item.flavor || '' })
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
              body: JSON.stringify({ name: itemName, price: Math.round(item.price * 100), unitQty: 1000, note: item.flavor || '' })
            }
          );
        }
      }
    } catch (e) { console.warn('Line item error:', e.message); }
  }

  // ── Add tax + delivery fee as line items so receipt total is correct ──
  const subtotalNum = Number(subtotal);
  const gst = Math.round(subtotalNum * 0.05 * 100); // cents
  const pst = Math.round(subtotalNum * 0.06 * 100); // cents

  const extras = [
    { name: 'GST (5%)', price: gst },
    { name: 'PST (6%)', price: pst }
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
  return cloverId;
}

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
// Season dates match public/halloween.js (Sep 25 – Nov 2, Regina time).
const GHOST_HUNT_MIN_SUBTOTAL = 30.00;
const GHOST_HUNT_FRIES_ITEM = { name: '🎃 FREE Fries (Ghost Hunt)', flavor: 'Small · Halloween Ghost Hunt reward', price: 0, qty: 1 };

function ghostHuntSeason() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Regina', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).reduce((o, p) => (o[p.type] = Number(p.value), o), {});
  const md = parts.month * 100 + parts.day;
  return { active: md >= 925 && md <= 1102, year: parts.year };
}

async function ghostHuntRedeemed(phoneNorm, year) {
  const database = await connectDB();
  if (!database) return true;  // fail closed — can't verify, don't give it away
  return !!(await database.collection('orders').findOne({ ghostHuntPhone: phoneNorm, ghostHuntYear: year }));
}

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', locations: Object.keys(LOCATIONS), time: new Date().toISOString() });
});

// Checks that a location's Clover merchant ID and API token work, without creating an order.
// GET /api/clover/check?loc=albert-st&password=ADMIN_PASSWORD
app.get('/api/clover/check', async (req, res) => {
  if (!isAdmin(req.query.password)) return res.status(401).json({ error: 'Wrong password' });
  const loc = LOCATIONS[req.query.loc];
  if (!loc) return res.status(400).json({ error: 'Unknown location', locations: Object.keys(LOCATIONS) });
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
  const { locationId, orderType, customer, items, notes, subtotal, tax, total, preOrder, openTime } = req.body;
  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  // Check if location is enabled
  try {
    const database = await connectDB();
    if (database) {
      const statusDoc = await database.collection('settings').findOne({ key: 'location_status' });
      if (statusDoc?.status && statusDoc.status[locationId] === false) {
        return res.status(400).json({ error: 'This location is temporarily closed. Please pick another location.' });
      }
    }
  } catch (e) { /* fail-open if DB check fails */ }
  if (!customer?.firstName || !customer?.phone) return res.status(400).json({ error: 'Missing customer info' });
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });

  const loc = LOCATIONS[locationId];
  const orderNum = 'WO-' + String(Math.floor(1000 + Math.random() * 9000));
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });

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

  let cloverId = null, cloverSuccess = false;
  try {
    cloverId = await createCloverOrder(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp);
    cloverSuccess = !!cloverId;
  } catch (e) { console.error('Clover error:', e.message); }

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
        subtotal: Number(subtotal), tax: Number(tax), total: Number(total),
        preOrder: !!preOrder, openTime: openTime || null, cloverId, cloverSuccess,
        firstOrderDiscount: discountApplied, discountValidated,
        contestRedemption: contestRedemption || null,
        ghostHuntPhone: ghostHuntFries ? ghostPhone : null,
        ghostHuntYear: ghostHuntFries ? ghostSeason.year : null,
        kitchenStatus: 'pending', createdAt: new Date(),
        // Google review request email goes out later (see REVIEW REQUESTS); only for customers who gave an email
        reviewDueAt: (customer.email && String(customer.email).includes('@')) ? reviewDueTime(new Date(), !!preOrder) : null
      });
      console.log(`✓ Order ${orderNum} saved to Mongo`);
    }
  } catch (e) { console.warn('Order save to Mongo failed:', e.message); }

  const stampResult = await autoAddStamp(customer.phone, orderNum, customer.firstName);

  sendEmail({
    to: 'besaucy@wingorestaurants.com',
    subject: `${preOrder ? '⏰ PRE-ORDER' : '🍗 New Order'} ${orderNum} — ${loc.name} — $${Number(total).toFixed(2)}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0D0D0D;padding:20px;text-align:center;"><h1 style="color:#E8190A;font-size:28px;margin:0;">WING-O</h1><p style="color:#888;margin:4px 0 0;font-size:12px;letter-spacing:2px;">${preOrder ? '⏰ PRE-ORDER' : 'New Online Order'}</p></div>
      <div style="background:#F5F0E8;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Order #</td><td style="padding:6px 0;font-weight:bold;font-size:16px;color:#E8190A;">${orderNum}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Location</td><td style="padding:6px 0;font-weight:bold;">${loc.name}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Type</td><td style="padding:6px 0;">${orderType === 'delivery' ? '🛵 Delivery' : '🏃 Pickup'}${preOrder ? ' <span style="background:#F5A800;color:#000;padding:2px 8px;border-radius:3px;font-size:11px;">PRE-ORDER — opens ' + openTime + '</span>' : ''}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Time</td><td style="padding:6px 0;">${timestamp}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Name</td><td style="padding:6px 0;">${customer.firstName} ${customer.lastName || ''}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Phone</td><td style="padding:6px 0;"><a href="tel:${customer.phone}" style="color:#E8190A;">${customer.phone}</a></td></tr>
          ${customer.email ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Email</td><td>${customer.email}</td></tr>` : ''}
          ${orderType === 'delivery' ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Address</td><td style="padding:6px 0;">${customer.address}</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:#888;font-size:13px;">Payment</td><td style="padding:6px 0;color:#F5A800;font-weight:bold;">💰 PAY AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}</td></tr>
          ${stampResult ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Loyalty</td><td style="padding:6px 0;color:#F5A800;">🍗 Stamp #${stampResult.totalOrders} added${stampResult.gotFree ? ' — 🎉 FREE WINGS EARNED!' : ''}</td></tr>` : ''}
        </table>
        <hr style="border:1px solid #E8E0D0;margin:16px 0;">
        ${items.map(i => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #E8E0D0;"><div><div style="font-weight:bold;font-size:14px;">${i.name} x${i.qty}</div>${i.flavor ? `<div style="color:#E8190A;font-size:12px;">${i.flavor}</div>` : ''}</div><div style="font-weight:bold;">$${(i.price * i.qty).toFixed(2)}</div></div>`).join('')}
        <div style="margin-top:12px;">
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>Subtotal</span><span>$${Number(subtotal).toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>GST (5%)</span><span>$${(Number(subtotal)*0.05).toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>PST (6%)</span><span>$${(Number(subtotal)*0.06).toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:bold;font-size:18px;border-top:2px solid #0D0D0D;margin-top:8px;"><span>TOTAL DUE AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}</span><span style="color:#E8190A;">$${Number(total).toFixed(2)}</span></div>
        </div>
        ${notes ? `<div style="background:#FFF8EE;border:1px solid #F5D98A;border-radius:6px;padding:10px;margin-top:12px;"><strong>Notes:</strong> ${notes}</div>` : ''}
      </div>
    </div>`
  });

  // ── CUSTOMER CONFIRMATION EMAIL ─────────────────────────────
  // Fires only if customer provided their email at checkout
  if (customer.email && customer.email.includes('@')) {
    const etaText = preOrder
      ? `Since we're closed right now, your order will be prepared when we open at <strong>${openTime}</strong>.`
      : `Should be ready in about <strong>${orderType === 'delivery' ? '30–45' : '15–20'} minutes</strong>.`;
    const whatsNext = orderType === 'delivery'
      ? `Sit tight — your food is being prepared. Have cash or card ready for the driver.`
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
              <div style="display:flex;justify-content:space-between;padding:3px 0;color:#666;font-size:13px;"><span>Tax (GST + PST)</span><span>$${Number(tax || 0).toFixed(2)}</span></div>
              ${delFee > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#666;font-size:13px;"><span>Delivery</span><span>$${delFee.toFixed(2)}</span></div>` : ''}
              ${tipAmt > 0 ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#2D8A3E;font-size:13px;font-weight:bold;"><span>💸 Tip</span><span>$${tipAmt.toFixed(2)}</span></div>` : ''}
              <div style="display:flex;justify-content:space-between;padding:10px 0 4px;font-weight:bold;font-size:18px;border-top:2px solid #1A1208;margin-top:8px;"><span>TOTAL</span><span style="color:#E8190A;">$${Number(total).toFixed(2)}</span></div>
              <div style="text-align:center;font-size:11px;color:#F5A800;letter-spacing:2px;margin-top:8px;font-weight:bold;">💰 PAY AT ${orderType === 'delivery' ? 'DELIVERY' : 'PICKUP'}</div>
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
    customer: customer.firstName, total: Number(total).toFixed(2),
    phone: customer.phone, orderType, location: loc.name,
    stampAdded: !!stampResult, gotFreeWings: stampResult?.gotFree || false, loyaltyStamps: stampResult?.stamps,
    discountApplied, discountValidated,
    ghostHuntFries, ghostHuntDenied
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
      kitchenStatus: o.kitchenStatus || 'pending',
      readyNotifiedAt: o.readyNotifiedAt ? o.readyNotifiedAt.toISOString() : null,
      timeAgo: formatTimeAgo(now - new Date(o.createdAt).getTime())
    }));
    res.json({
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
    if (!database) return res.json({ status: {} });
    const doc = await database.collection('settings').findOne({ key: 'location_status' });
    res.json({ status: doc?.status || {} });
  } catch (e) {
    res.json({ status: {} });
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

// ── LOCATIONS ─────────────────────────────────────────────────
app.get('/api/locations', (req, res) => {
  const safe = Object.entries(LOCATIONS).map(([id, loc]) => ({
    id, name: loc.name, address: loc.address, phone: loc.phone, hours: loc.hours
  }));
  res.json(safe);
});

// ── FRANCHISE INQUIRY ─────────────────────────────────────────
app.post('/api/franchise', async (req, res) => {
  const { firstName, lastName, email, phone, city, budget, message } = req.body;
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });
  console.log(`\n🚀 FRANCHISE: ${firstName} ${lastName} — ${city} — ${timestamp}`);
  sendEmail({
    to: 'besaucy@wingorestaurants.com',
    subject: `🚀 Franchise Inquiry — ${firstName} ${lastName} (${city})`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0D0D0D;padding:20px;text-align:center;"><h1 style="color:#E8190A;font-size:28px;margin:0;">WING-O</h1><p style="color:#888;margin:4px 0 0;font-size:12px;letter-spacing:2px;">🚀 Franchise Inquiry</p></div>
      <div style="background:#F5F0E8;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#888;font-size:13px;width:120px;">Name</td><td style="padding:8px 0;font-weight:bold;">${firstName} ${lastName}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px;">Email</td><td><a href="mailto:${email}" style="color:#E8190A;">${email}</a></td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px;">Phone</td><td><a href="tel:${phone}" style="color:#E8190A;">${phone}</a></td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px;">City</td><td style="padding:8px 0;font-weight:bold;">${city}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px;">Budget</td><td style="padding:8px 0;">${budget || 'Not specified'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;font-size:13px;">Time</td><td style="padding:8px 0;">${timestamp}</td></tr>
        </table>
        ${message ? `<hr style="border:1px solid #E8E0D0;margin:16px 0;"><p style="background:white;border:1px solid #E8E0D0;border-radius:6px;padding:12px;margin:0;font-size:14px;">${message}</p>` : ''}
      </div>
    </div>`
  });
  res.json({ success: true });
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
