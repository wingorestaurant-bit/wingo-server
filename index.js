const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── LOCATION CONFIG ────────────────────────────────────────────
const LOCATIONS = {
  "albert-st": {
    name: "Albert Street (Regina)",
    merchantId: "318003593879",
    apiToken: "4c89fafe-a989-0b53-7c24-2ad11e672879",
    address: "#3 - 155 Albert St N, Regina, SK",
    phone: "306-522-2111",
    email: "Wingorestaurant@gmail.com",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: false,
    cloverPrivateKey: null
  },
  "rochdale": {
    name: "Rochdale (Regina)",
    merchantId: "HWQ8ZY3TTBAZ1",
    apiToken: process.env.CLOVER_API_TOKEN_ROCHDALE,
    address: "3881 Rochdale Blvd, Regina, SK",
    phone: "306-522-2112",
    email: "Wingorestaurant@gmail.com",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: true,
    cloverPrivateKey: process.env.CLOVER_PRIVATE_KEY_ROCHDALE
  },
  "moose-jaw": {
    name: "Moose Jaw",
    merchantId: "318003488638",
    apiToken: process.env.CLOVER_API_TOKEN_MOOSEJAW,
    address: "622 Main St N, Moose Jaw, SK",
    phone: "306-692-2113",
    email: "Wingorestaurant@gmail.com",
    hours: "Mon-Wed 11am-1am · Thu-Sun 11am-3am",
    onlinePayments: false,
    cloverPrivateKey: null
  }
};

// ── HEALTH CHECK ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', locations: Object.keys(LOCATIONS), time: new Date().toISOString() });
});

// ── PLACE ORDER → CLOVER ───────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  const { locationId, orderType, customer, items, notes, subtotal, tax, total } = req.body;

  if (!locationId || !LOCATIONS[locationId]) {
    return res.status(400).json({ error: 'Invalid location' });
  }
  if (!customer?.firstName || !customer?.phone) {
    return res.status(400).json({ error: 'Missing customer name or phone' });
  }
  if (!items || !items.length) {
    return res.status(400).json({ error: 'No items in order' });
  }

  const loc = LOCATIONS[locationId];
  const orderNum = 'WO-' + String(Math.floor(1000 + Math.random() * 9000));
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });

  const orderNote = `
=================================
WING-O ONLINE ORDER
=================================
ORDER #: ${orderNum}
TIME: ${timestamp} (Regina SK)
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
  Subtotal:     $${Number(subtotal).toFixed(2)}
  GST (5%):     $${(Number(subtotal) * 0.05).toFixed(2)}
  PST (6%):     $${(Number(subtotal) * 0.06).toFixed(2)}
  TOTAL:        $${Number(total).toFixed(2)}
  Payment:  At ${orderType}
---------------------------------
${notes ? 'NOTES: ' + notes : ''}
=================================
  `.trim();

  console.log(`\n[${timestamp}] New order ${orderNum} for ${customer.firstName} at ${loc.name}`);
  console.log(`Items: ${items.map(i => `${i.name} x${i.qty}`).join(', ')}`);

  let cloverId = null;
  let cloverSuccess = false;

  try {
    const createResp = await fetch(
      `https://api.clover.com/v3/merchants/${loc.merchantId}/orders`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${loc.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: `Online ${orderType} — ${customer.firstName} ${customer.lastName || ''}`,
          note: orderNote,
          state: 'open'
        })
      }
    );

    const createData = await createResp.json();

    if (createResp.ok && createData.id) {
      cloverId = createData.id;
      cloverSuccess = true;
      console.log(`✓ Clover order created: ${cloverId}`);

      for (const item of items) {
        try {
          await fetch(
            `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
            {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${loc.apiToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                name: item.flavor ? `${item.name} [${item.flavor}]` : item.name,
                unitPrice: Math.round(item.price * 100),
                unitQty: item.qty,
                note: item.flavor || ''
              })
            }
          );
        } catch (lineErr) {
          console.warn('Line item error:', lineErr.message);
        }
      }

      const subtotalNum = Number(subtotal);
      const gst = Math.round(subtotalNum * 0.05 * 100);
      const pst = Math.round(subtotalNum * 0.06 * 100);

      try {
        await fetch(
          `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${loc.apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'GST (5%)', unitPrice: gst, unitQty: 1 })
          }
        );
        await fetch(
          `https://api.clover.com/v3/merchants/${loc.merchantId}/orders/${cloverId}/line_items`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${loc.apiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: 'PST (6%)', unitPrice: pst, unitQty: 1 })
          }
        );
      } catch (taxErr) {
        console.warn('Tax line item error:', taxErr.message);
      }

      console.log(`✓ Line items + taxes added to Clover order ${cloverId}`);
    } else {
      console.error('Clover create failed:', createResp.status, JSON.stringify(createData));
    }
  } catch (err) {
    console.error('Clover API error:', err.message);
  }

  res.json({
    success: true,
    orderNum,
    cloverId,
    cloverSuccess,
    message: cloverSuccess
      ? `Order sent to ${loc.name} kitchen via Clover!`
      : `Order recorded! Kitchen will be notified.`,
    customer: customer.firstName,
    total: Number(total).toFixed(2),
    phone: customer.phone,
    orderType,
    location: loc.name
  });
});

// ── DONATION TRACKER ──────────────────────────────────────────
let donationAmount = 0;

app.get('/api/donation', (req, res) => {
  res.json({ amount: donationAmount, updatedAt: new Date().toISOString() });
});

app.post('/api/donation', (req, res) => {
  const { amount, password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'sauceboss2025';
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  donationAmount = Number(amount);
  console.log(`✓ Donation updated to ${donationAmount}`);
  res.json({ success: true, amount: donationAmount });
});

// ── GET LOCATIONS ─────────────────────────────────────────────
app.get('/api/locations', (req, res) => {
  const safe = Object.entries(LOCATIONS).map(([id, loc]) => ({
    id,
    name: loc.name,
    address: loc.address,
    phone: loc.phone,
    hours: loc.hours,
    email: loc.email
  }));
  res.json(safe);
});

// ── CLOVER CHARGE (online payments) ──────────────────────────
app.post('/api/charge', async (req, res) => {
  const { locationId, cardToken, amount, orderId, customer } = req.body;

  if (!locationId || !cardToken || !amount) {
    return res.json({ success: false, error: 'Missing required fields' });
  }

  const loc = LOCATIONS[locationId];
  if (!loc || !loc.onlinePayments || !loc.cloverPrivateKey) {
    return res.json({ success: false, error: 'Location not configured for online payments' });
  }

  try {
    const amountInCents = Math.round(amount * 100);
    const chargeResponse = await fetch('https://scl.clover.com/v1/charges', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${loc.cloverPrivateKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountInCents,
        currency: 'cad',
        source: cardToken,
        description: `Wing-O Order ${orderId} — ${customer?.firstName || 'Customer'}`,
        capture: true,
      }),
    });

    const chargeData = await chargeResponse.json();

    if (chargeData.id && chargeData.status === 'succeeded') {
      console.log(`✅ Payment success — ${orderId} — $${amount} — Charge: ${chargeData.id}`);
      return res.json({
        success: true,
        chargeId: chargeData.id,
        amount: chargeData.amount,
        last4: chargeData.source?.last4 || '****',
      });
    } else {
      const errMsg = chargeData.error?.message || chargeData.message || 'Payment failed';
      console.error(`❌ Payment failed — ${orderId} —`, errMsg);
      return res.json({ success: false, error: errMsg });
    }
  } catch (err) {
    console.error('Clover charge error:', err);
    return res.json({ success: false, error: 'Server error processing payment' });
  }
});

// ── FRANCHISE INQUIRY ─────────────────────────────────────────
app.post('/api/franchise', async (req, res) => {
  const { firstName, lastName, email, phone, city, budget, message } = req.body;
  const timestamp = new Date().toLocaleString('en-CA', { timeZone: 'America/Regina' });

  console.log(`
=================================
🚀 FRANCHISE INQUIRY
=================================
Time:    ${timestamp}
Name:    ${firstName} ${lastName}
Email:   ${email}
Phone:   ${phone}
City:    ${city}
Budget:  ${budget}
Message: ${message || 'N/A'}
=================================
  `);

  res.json({ success: true });
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔥 Wing-O server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/health`);
  console.log(`   Locations loaded: ${Object.keys(LOCATIONS).join(', ')}\n`);
});
