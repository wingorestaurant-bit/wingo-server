const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { MongoClient } = require('mongodb');
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
app.use(express.static(path.join(__dirname, 'public')));

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
    merchantId: "5376RB8DAZMH1",
    apiToken: process.env.CLOVER_API_TOKEN_ALBERT,
    address: "#3 - 155 Albert St N, Regina, SK",
    phone: "306-522-2111",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: true,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_ALBERT
  },
  "rochdale": {
    name: "Rochdale (Regina)",
    merchantId: "HWQ8ZY3TTBAZ1",
    apiToken: process.env.CLOVER_API_TOKEN_ROCHDALE,
    address: "3881 Rochdale Blvd, Regina, SK",
    phone: "306-522-2112",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: true,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_ROCHDALE
  },
  "east-regina": {
    name: "East Regina (Wing-O East)",
    merchantId: "4BB1SFERQNQF1",
    apiToken: process.env.CLOVER_API_TOKEN_EAST,
    address: "534 University Park Drive, Regina, SK",
    phone: "306-522-2114",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: true,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_EAST
  },
  "moose-jaw": {
    name: "Moose Jaw",
    merchantId: "Z0S7JA8VG9CR1",
    apiToken: process.env.CLOVER_API_TOKEN_MOOSEJAW,
    address: "622 Main St N, Moose Jaw, SK",
    phone: "306-692-2113",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: true,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_MOOSEJAW
  }
};

// ── EMAIL (Resend) ─────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('No RESEND_API_KEY'); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Wing-O <besaucy@wingorestaurants.com>', to, subject, html })
    });
    const d = await r.json();
    if (d.id) console.log(`✉️ Email sent: ${subject}`);
    else console.warn('Email error:', JSON.stringify(d));
  } catch (e) { console.warn('Email failed:', e.message); }
}

// ── AUTO STAMP (called internally after confirmed order) ───────
async function autoAddStamp(phone, orderNum, customerName) {
  if (!phone || !orderNum) return null;
  const cleanPhone = phone.replace(/\D/g, '');

  try {
    const database = await connectDB();
    if (!database) return null;

    const member = await database.collection('loyalty').findOne({ phone: cleanPhone });
    if (!member) return null; // Not a loyalty member, skip silently

    // Prevent duplicate stamps for same order
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
      { phone: cleanPhone },
      {
        $set: {
          stamps: finalStamps,
          totalOrders: newTotalOrders,
          freeEarned: newFreeEarned,
          history: newHistory,
          updatedAt: new Date()
        },
        $push: { usedOrderNums: orderNum }
      }
    );

    console.log(`🍗 AUTO-STAMP: ${member.name} — Order ${orderNum} — Stamp ${newTotalOrders} — Free: ${gotFree}`);

    // Notify if free wings earned
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

// ── CREATE CLOVER ORDER WITH LINE ITEMS ────────────────────────
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
---------------------------------
${notes ? 'NOTES: ' + notes : ''}
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
          body: JSON.stringify({
            name: itemName,
            price: Math.round(item.price * 100),
            unitQty: 1000,
            note: item.flavor || ''
          })
        }
      );
      const lineData = await lineResp.json();
      console.log(`  Line item: ${itemName} — ${lineResp.status} — id:${lineData.id||'?'}`);

      // If qty > 1, add extra line items (Clover counts each separately)
      if (item.qty > 1) {
        for (let q = 1; q < item.qty; q++) {
          await fetch(
            `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: itemName,
                price: Math.round(item.price * 100),
                unitQty: 1000,
                note: item.flavor || ''
              })
            }
          );
        }
      }
    } catch (e) { console.warn('Line item error:', e.message); }
  }

  console.log(`✓ Line items added to ${cloverId}`);
  return cloverId;
}

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', locations: Object.keys(LOCATIONS), time: new Date().toISOString() });
});

// ── PUSH ADMIN PANEL ───────────────────────────────────────────
app.get('/push-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'push-admin.html'));
});

// ── PLACE ORDER → CLOVER (pickup/delivery, pay at store) ───────
app.post('/api/orders', async (req, res) => {
  const { locationId, orderType, customer, items, notes, subtotal, tax, total, preOrder, openTime } = req.body;

  if (!locationId || !LOCATIONS[locationId]) return res.status(400).json({ error: 'Invalid location' });
  if (!customer?.firstName || !customer?.phone) return res.status(400).json({ error: 'Missing customer info' });
  if (!items || !items.length) return res.status(400).json({ error: 'No items' });

  const loc = LOCATIONS[locationId];
  const orderNum = 'WO-' + String(Math.floor(1000 + Math.random() * 9000));
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });

  console.log(`\n[${timestamp}] Order ${orderNum} for ${customer.firstName} at ${loc.name}`);

  let cloverId = null;
  let cloverSuccess = false;
  try {
    cloverId = await createCloverOrder(loc, orderNum, orderType, customer, items, subtotal, notes, timestamp);
    cloverSuccess = !!cloverId;
  } catch (e) { console.error('Clover error:', e.message); }

  // ── AUTO STAMP: fires only on real confirmed order ──
  const stampResult = await autoAddStamp(customer.phone, orderNum, customer.firstName);

  // Send email notification
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
          ${stampResult ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Loyalty</td><td style="padding:6px 0;color:#F5A800;">🍗 Stamp #${stampResult.totalOrders} added${stampResult.gotFree ? ' — 🎉 FREE WINGS EARNED!' : ''}</td></tr>` : ''}
        </table>
        <hr style="border:1px solid #E8E0D0;margin:16px 0;">
        ${items.map(i => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #E8E0D0;"><div><div style="font-weight:bold;font-size:14px;">${i.name} x${i.qty}</div>${i.flavor ? `<div style="color:#E8190A;font-size:12px;">${i.flavor}</div>` : ''}</div><div style="font-weight:bold;">$${(i.price * i.qty).toFixed(2)}</div></div>`).join('')}
        <div style="margin-top:12px;">
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>Subtotal</span><span>$${Number(subtotal).toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>GST (5%)</span><span>$${(Number(subtotal)*0.05).toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#888;font-size:13px;"><span>PST (6%)</span><span>$${(Number(subtotal)*0.06).toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:bold;font-size:18px;border-top:2px solid #0D0D0D;margin-top:8px;"><span>TOTAL</span><span style="color:#E8190A;">$${Number(total).toFixed(2)}</span></div>
        </div>
        ${notes ? `<div style="background:#FFF8EE;border:1px solid #F5D98A;border-radius:6px;padding:10px;margin-top:12px;"><strong>Notes:</strong> ${notes}</div>` : ''}
      </div>
    </div>`
  });

  res.json({
    success: true, orderNum, cloverId, cloverSuccess,
    message: cloverSuccess ? `Order sent to ${loc.name} kitchen!` : 'Order recorded!',
    customer: customer.firstName, total: Number(total).toFixed(2),
    phone: customer.phone, orderType, location: loc.name,
    stampAdded: !!stampResult,
    gotFreeWings: stampResult?.gotFree || false,
    loyaltyStamps: stampResult?.stamps
  });
});

// ── CLOVER CHARGE + CREATE ORDER (online payment) ──────────────
app.post('/api/charge', async (req, res) => {
  const { locationId, cardToken, amount, orderId, customer, items, subtotal, notes, orderType } = req.body;

  if (!locationId || !cardToken || !amount) return res.json({ success: false, error: 'Missing fields' });

  const loc = LOCATIONS[locationId];
  if (!loc || !loc.onlinePayments || !loc.cloverPrivateKey) {
    return res.json({ success: false, error: 'Location not configured for online payments' });
  }

  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });

  try {
    // Step 1: Charge the card
    const amountInCents = Math.round(amount * 100);
    const chargeResponse = await fetch('https://scl.clover.com/v1/charges', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${loc.cloverPrivateKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: amountInCents,
        currency: 'cad',
        source: cardToken,
        description: `Wing-O Order ${orderId} — ${customer?.firstName || 'Customer'}`,
        capture: true
      })
    });
    const chargeData = await chargeResponse.json();

    if (!chargeData.id || chargeData.status !== 'succeeded') {
      const errMsg = chargeData.error?.message || chargeData.message || 'Payment failed';
      console.error(`Payment failed — ${orderId} —`, errMsg);
      return res.json({ success: false, error: errMsg });
    }

    console.log(`✅ Payment success — ${orderId} — $${amount} — Charge: ${chargeData.id}`);

    // Step 2: Create Clover order
    let cloverId = null;
    if (items && items.length && loc.apiToken) {
      try {
        cloverId = await createCloverOrder(
          loc, orderId, orderType || 'pickup',
          customer || { firstName: 'Customer', phone: 'N/A' },
          items, subtotal || amount, notes || '', timestamp
        );
      } catch (e) { console.warn('Post-payment order creation error:', e.message); }
    }

    // Step 2b: Mark Clover order as PAID
    if (cloverId && loc.apiToken) {
      try {
        const totalCents = Math.round(amount * 100);
        // Record the payment against the order
        await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/payments`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            order: { id: cloverId },
            amount: totalCents,
            tipAmount: 0,
            taxAmount: Math.round((subtotal || amount) * 0.11 * 100),
            result: 'SUCCESS',
            cardTransaction: {
              authCode: chargeData.id,
              referenceId: chargeData.id,
              transactionNo: chargeData.id,
              last4: chargeData.source?.last4 || '0000',
              cardType: 'MC',
              type: 'AUTH',
              state: 'CLOSED'
            }
          })
        });
        // Also update order state to locked/paid
        await fetch(`https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${loc.apiToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: 'locked' })
        });
        console.log(`✅ Clover order ${cloverId} marked as paid`);
      } catch (e) { console.warn('Mark paid error:', e.message); }
    }

    // Step 3: AUTO STAMP — only fires after payment confirmed ✅
    const stampResult = await autoAddStamp(customer?.phone, orderId, customer?.firstName);

    // Step 4: Send email
    sendEmail({
      to: 'besaucy@wingorestaurants.com',
      subject: `💳 PAID ${orderId} — ${loc.name} — $${amount}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#0D0D0D;padding:20px;text-align:center;"><h1 style="color:#E8190A;font-size:28px;margin:0;">WING-O</h1><p style="color:#48BB78;margin:4px 0 0;font-size:12px;letter-spacing:2px;">💳 PAYMENT RECEIVED</p></div>
        <div style="background:#F5F0E8;padding:24px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Order #</td><td style="padding:6px 0;font-weight:bold;font-size:16px;color:#E8190A;">${orderId}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Location</td><td style="padding:6px 0;font-weight:bold;">${loc.name}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Paid</td><td style="padding:6px 0;font-weight:bold;color:#276749;">$${amount} · Card ending ${chargeData.source?.last4 || '****'}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Customer</td><td style="padding:6px 0;">${customer?.firstName || ''} — ${customer?.phone || ''}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Time</td><td style="padding:6px 0;">${timestamp}</td></tr>
            ${stampResult ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Loyalty</td><td style="padding:6px 0;color:#F5A800;">🍗 Stamp #${stampResult.totalOrders} added${stampResult.gotFree ? ' — 🎉 FREE WINGS EARNED!' : ''}</td></tr>` : ''}
          </table>
          ${items ? '<hr style="border:1px solid #E8E0D0;margin:16px 0;">' + items.map(i => `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #E8E0D0;"><div><div style="font-weight:bold;font-size:14px;">${i.name} x${i.qty}</div>${i.flavor ? `<div style="color:#E8190A;font-size:12px;">${i.flavor}</div>` : ''}</div><div style="font-weight:bold;">$${(i.price * i.qty).toFixed(2)}</div></div>`).join('') : ''}
        </div>
      </div>`
    });

    return res.json({
      success: true,
      chargeId: chargeData.id,
      cloverId: cloverId,
      amount: chargeData.amount,
      last4: chargeData.source?.last4 || '****',
      stampAdded: !!stampResult,
      gotFreeWings: stampResult?.gotFree || false,
      loyaltyStamps: stampResult?.stamps
    });

  } catch (err) {
    console.error('Charge error:', err);
    return res.json({ success: false, error: 'Server error processing payment' });
  }
});

// ── DONATION TRACKER ──────────────────────────────────────────
let donationAmount = 27000;

app.get('/api/donation', (req, res) => {
  res.json({ amount: donationAmount, updatedAt: new Date().toISOString() });
});
app.post('/api/donation', (req, res) => {
  const { amount, password } = req.body;
  if (password !== (process.env.ADMIN_PASSWORD || 'sauceboss2025')) return res.status(401).json({ error: 'Wrong password' });
  donationAmount = Number(amount);
  console.log(`✓ Donation updated to ${donationAmount}`);
  res.json({ success: true, amount: donationAmount });
});

// ── GET LOCATIONS ─────────────────────────────────────────────
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

// ── LOYALTY PROGRAM (MongoDB) ────────────────────────────────

// SIGNUP
app.post('/api/loyalty/signup', async (req, res) => {
  const { name, email, phone } = req.body;
  if (!name || !email || !phone) return res.json({ success: false, error: 'Missing fields' });
  const cleanPhone = phone.replace(/\D/g, '');

  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });

    const existing = await database.collection('loyalty').findOne({ phone: cleanPhone });
    if (existing) return res.json({ success: false, error: 'Phone already registered' });

    const member = {
      name, email,
      phone: cleanPhone,
      stamps: 0,
      totalOrders: 0,
      freeEarned: 0,
      usedOrderNums: [],
      history: [],
      joinDate: new Date().toISOString(),
      createdAt: new Date()
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

    res.json({ success: true, member });
  } catch (e) {
    console.error('Loyalty signup error:', e.message);
    res.json({ success: false, error: 'Signup failed' });
  }
});

// LOOKUP by phone or email
app.get('/api/loyalty/lookup', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ success: false, error: 'Missing search' });
  const cleanPhone = q.replace(/\D/g, '');

  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });

    const member = await database.collection('loyalty').findOne({
      $or: [
        { phone: cleanPhone },
        { email: q.toLowerCase().trim() }
      ]
    });

    if (!member) return res.json({ success: false, error: 'Member not found' });
    res.json({ success: true, member });
  } catch (e) {
    console.error('Loyalty lookup error:', e.message);
    res.json({ success: false, error: 'Lookup failed' });
  }
});

// ADD STAMP (manual — admin use only, requires password)
app.post('/api/loyalty/stamp', async (req, res) => {
  const { phone, orderNum, password } = req.body;
  const cleanPhone = phone.replace(/\D/g, '');
  if (!cleanPhone || !orderNum) return res.json({ success: false, error: 'Missing fields' });

  // Require admin password for manual stamp
  if (!password || password !== (process.env.ADMIN_PASSWORD || 'sauceboss2025')) {
    return res.status(401).json({ success: false, error: 'Unauthorized — admin password required' });
  }

  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });

    const member = await database.collection('loyalty').findOne({ phone: cleanPhone });
    if (!member) return res.json({ success: false, error: 'Member not found' });

    if (member.usedOrderNums && member.usedOrderNums.includes(orderNum)) {
      return res.json({ success: false, error: 'Order number already used' });
    }

    const newStamps = (member.stamps || 0) + 1;
    const newTotalOrders = (member.totalOrders || 0) + 1;
    const gotFree = newStamps >= 10;
    const finalStamps = gotFree ? 0 : newStamps;
    const newFreeEarned = gotFree ? (member.freeEarned || 0) + 1 : (member.freeEarned || 0);
    const newHistory = [
      { orderNum, date: new Date().toLocaleDateString('en-CA'), stamp: newTotalOrders, manual: true },
      ...(member.history || [])
    ].slice(0, 50);

    await database.collection('loyalty').updateOne(
      { phone: cleanPhone },
      {
        $set: {
          stamps: finalStamps,
          totalOrders: newTotalOrders,
          freeEarned: newFreeEarned,
          history: newHistory,
          updatedAt: new Date()
        },
        $push: { usedOrderNums: orderNum }
      }
    );

    const updated = await database.collection('loyalty').findOne({ phone: cleanPhone });
    console.log(`🍗 MANUAL STAMP: ${member.name} — ${orderNum} — Total: ${newTotalOrders} — Free: ${gotFree}`);

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

    res.json({ success: true, member: updated, gotFree, stamps: finalStamps, totalOrders: newTotalOrders });
  } catch (e) {
    console.error('Loyalty stamp error:', e.message);
    res.json({ success: false, error: 'Failed to add stamp' });
  }
});

// GET MEMBER
app.get('/api/loyalty/member/:phone', async (req, res) => {
  const cleanPhone = req.params.phone.replace(/\D/g, '');
  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });
    const member = await database.collection('loyalty').findOne({ phone: cleanPhone });
    if (!member) return res.json({ success: false, error: 'Member not found' });
    res.json({ success: true, member });
  } catch (e) {
    res.json({ success: false, error: 'Lookup failed' });
  }
});

// ADMIN — view all members (password protected)
app.get('/api/loyalty/admin/members', async (req, res) => {
  if (req.query.password !== (process.env.ADMIN_PASSWORD || 'sauceboss2025')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const database = await connectDB();
    const members = await database.collection('loyalty').find({}).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, count: members.length, members });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────

// Save subscription when customer allows notifications
app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, info } = req.body;
  if (!subscription || !subscription.endpoint) return res.json({ success: false, error: 'Invalid subscription' });

  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });

    // Upsert — don't create duplicates
    await database.collection('push_subs').updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: {
          subscription,
          updatedAt: new Date(),
          userAgent: info?.userAgent || '',
          location: info?.location || ''
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    console.log(`🔔 Push subscriber saved: ${subscription.endpoint.slice(-30)}`);
    res.json({ success: true });
  } catch (e) {
    console.error('Push subscribe error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Unsubscribe
app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body;
  try {
    const database = await connectDB();
    if (database) await database.collection('push_subs').deleteOne({ endpoint });
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// Get subscriber count (admin)
app.get('/api/push/count', async (req, res) => {
  if (req.query.password !== (process.env.ADMIN_PASSWORD || 'sauceboss2025')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const database = await connectDB();
    const count = await database.collection('push_subs').countDocuments();
    res.json({ success: true, count });
  } catch (e) {
    res.json({ success: false, count: 0 });
  }
});

// Send push notification to all subscribers (admin only)
app.post('/api/push/send', async (req, res) => {
  const { password, title, body, url, icon } = req.body;

  if (password !== (process.env.ADMIN_PASSWORD || 'sauceboss2025')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!title || !body) return res.json({ success: false, error: 'Title and body required' });

  try {
    const database = await connectDB();
    if (!database) return res.json({ success: false, error: 'Database unavailable' });

    const subs = await database.collection('push_subs').find({}).toArray();
    if (!subs.length) return res.json({ success: true, sent: 0, message: 'No subscribers yet' });

    if (!webpush) return res.json({ success: false, error: 'Push notifications not available — web-push not installed' });

    const payload = JSON.stringify({
      title: title || 'Wing-O 🍗',
      body,
      icon: icon || '/images/logo.jpg',
      badge: '/images/logo.jpg',
      url: url || '/',
      timestamp: Date.now()
    });

    let sent = 0, failed = 0, expired = [];

    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub.subscription, payload);
        sent++;
      } catch (e) {
        failed++;
        // 410 Gone = subscription expired, remove it
        if (e.statusCode === 410 || e.statusCode === 404) {
          expired.push(sub.endpoint);
        }
        console.warn(`Push failed for ${sub.endpoint.slice(-20)}: ${e.message}`);
      }
    }));

    // Clean up expired subscriptions
    if (expired.length) {
      await database.collection('push_subs').deleteMany({ endpoint: { $in: expired } });
      console.log(`🧹 Removed ${expired.length} expired push subscriptions`);
    }

    console.log(`🔔 Push sent: ${sent} success, ${failed} failed`);
    res.json({ success: true, sent, failed, total: subs.length });

  } catch (e) {
    console.error('Push send error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔥 Wing-O server on port ${PORT}`);
  console.log(`   Locations: ${Object.keys(LOCATIONS).join(', ')}\n`);
});
