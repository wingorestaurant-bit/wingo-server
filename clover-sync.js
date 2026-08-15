// clover-sync.js
// Pulls a day's real orders + line items from the Clover REST API for
// Albert Street and aggregates them into the shape the tracker expects.
//
// Clover API notes (confirmed against Clover's docs, Aug 2026):
// - GET /v3/merchants/{mId}/orders?filter=clientCreatedTime>={start}&filter=clientCreatedTime<{end}&expand=lineItems
// - Use a separate `filter=` param for each clause — do NOT chain with &.
// - The end bound must be EXCLUSIVE (<), not <=, or Clover ignores it (documented quirk).
// - state:"locked" = a completed/paid order.
// - lineItems.elements[]: { id, name, price (cents), refunded (bool), unitQty }
// - Payments: GET /v3/merchants/{mId}/payments?filter=clientCreatedTime>=...&expand=tender
//   tender.label gives things like "Cash", "Visa", "Uber Eats", "DoorDash" etc.

const fetch = require('node-fetch');

const CLOVER_BASE = 'https://api.clover.com';

// Regina, SK does not observe DST — fixed UTC-6 year round.
const REGINA_UTC_OFFSET_HOURS = 6;

function reginaDateToUtcRangeMs(dateStr) {
  // dateStr = "YYYY-MM-DD" in Regina local time. Returns [startMs, endMs) in UTC.
  const [y, m, d] = dateStr.split('-').map(Number);
  const startUtc = Date.UTC(y, m - 1, d, REGINA_UTC_OFFSET_HOURS, 0, 0, 0);
  const endUtc = startUtc + 24 * 60 * 60 * 1000;
  return [startUtc, endUtc];
}

async function cloverFetch(path, apiToken) {
  const url = `${CLOVER_BASE}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Clover API ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchAllPages(basePath, apiToken, extraQuery) {
  const limit = 1000;
  let offset = 0;
  let all = [];
  while (true) {
    const sep = basePath.includes('?') ? '&' : '?';
    const path = `${basePath}${sep}${extraQuery}&limit=${limit}&offset=${offset}`;
    const data = await cloverFetch(path, apiToken);
    const elements = (data && data.elements) || [];
    all = all.concat(elements);
    if (elements.length < limit) break;
    offset += limit;
    if (offset > 20000) break; // safety valve
  }
  return all;
}

// Categorize a Clover tender label into our five tracked payment channels.
function classifyTender(label) {
  const l = (label || '').toLowerCase();
  if (l.includes('uber')) return 'uberEats';
  if (l.includes('doordash') || l.includes('door dash')) return 'doorDash';
  if (l.includes('skip')) return 'skip';
  if (l.includes('cash')) return 'cash';
  return 'card'; // visa/mastercard/interac/credit/debit/etc fall here
}

/**
 * Pull one Regina-local day of orders + payments for a location and
 * return the aggregated shape the tracker's Daily Entry expects.
 *
 * @param {object} location - LOCATIONS['albert-st'] style object with merchantId + apiToken
 * @param {string} dateStr - "YYYY-MM-DD" in Regina local time
 */
async function fetchDaySales(location, dateStr) {
  const { merchantId, apiToken } = location;
  if (!merchantId || !apiToken) {
    throw new Error('Missing merchantId or apiToken for this location.');
  }
  const [startMs, endMs] = reginaDateToUtcRangeMs(dateStr);
  const timeFilter = `filter=clientCreatedTime>=${startMs}&filter=clientCreatedTime<${endMs}`;

  // 1. Orders + line items
  const orders = await fetchAllPages(
    `/v3/merchants/${merchantId}/orders`,
    apiToken,
    `${timeFilter}&expand=lineItems`
  );

  const itemAgg = {}; // cleanName -> {qty, revenue, refundedQty, refundedRevenue}
  let ordersCount = 0;

  // Tax lines (GST/PST/HST) sometimes come through as pseudo line items — never real food, always excluded.
  const TAX_LINE_RE = /^(GST|PST|HST|QST|Tax)\b/i;

  function cleanItemName(rawName){
    let n = (rawName || 'Unnamed item').trim();
    n = n.replace(/^\?\s*/, '');           // strip leading "? " (Clover's unlinked-item marker)
    n = n.replace(/\s*\[[^\]]*\]\s*$/, ''); // strip trailing "[Sauce Choice]" modifier suffix
    n = n.replace(/\s*—\s*Order\s*#\d+\s*(\(\d+%\s*OFF\))?\s*$/i, ''); // strip "— Order #2 (50% OFF)"
    n = n.replace(/^Pickle'?d\s+Up\s+Poutine$/i, "Pickle'd Poutine"); // two Clover button names, same item
    n = n.replace(/^WING\s*NIGHT$/i, "One Order Wings"); // Thursday BOGO-50%-off promo — same wings, just discounted
    return n.trim();
  }

  for (const order of orders) {
    if (order.state !== 'locked') continue; // skip open/unfinished orders
    ordersCount++;
    const lineItems = (order.lineItems && order.lineItems.elements) || [];
    for (const li of lineItems) {
      const rawName = li.name || 'Unnamed item';
      if (TAX_LINE_RE.test(rawName)) continue; // not a real item — skip entirely
      const name = cleanItemName(rawName);
      const priceDollars = (Number(li.price) || 0) / 100;
      // Clover reports unitQty in THOUSANDTHS when the field is present at all (custom/ad-hoc
      // line items, mainly) — but regular catalog-linked items often omit it entirely, in which
      // case each line item represents exactly 1 unit. Dividing an absent field would be wrong,
      // so only divide when Clover actually sent a value.
      const qty = (li.unitQty != null && Number(li.unitQty) > 0) ? Number(li.unitQty) / 1000 : 1;
      if (!itemAgg[name]) {
        itemAgg[name] = { qty: 0, revenue: 0, refundedQty: 0, refundedRevenue: 0 };
      }
      if (li.refunded) {
        itemAgg[name].refundedQty += qty;
        itemAgg[name].refundedRevenue += priceDollars;
        // still counts as qty sold (food was made) but $0 net revenue — handled below
        itemAgg[name].qty += qty;
      } else {
        itemAgg[name].qty += qty;
        itemAgg[name].revenue += priceDollars;
      }
    }
  }

  const items = Object.entries(itemAgg).map(([name, v]) => ({
    name: v.refundedQty > 0 ? name : name, // keep name plain; refund info tracked separately
    qty: v.qty,
    revenue: Math.round(v.revenue * 100) / 100,
    refundedQty: v.refundedQty,
    refundedRevenue: Math.round(v.refundedRevenue * 100) / 100
  }));

  // 2. Payments, for the tender/payment-channel breakdown
  let tenders = { card: 0, cash: 0, uberEats: 0, skip: 0, doorDash: 0 };
  try {
    const payments = await fetchAllPages(
      `/v3/merchants/${merchantId}/payments`,
      apiToken,
      `${timeFilter}&expand=tender`
    );
    for (const p of payments) {
      if (p.result !== 'SUCCESS') continue;
      const label = (p.tender && p.tender.label) || (p.tender && p.tender.id) || '';
      const bucket = classifyTender(label);
      tenders[bucket] += (Number(p.amount) || 0) / 100;
    }
    Object.keys(tenders).forEach(k => { tenders[k] = Math.round(tenders[k] * 100) / 100; });
  } catch (e) {
    console.error('[clover-sync] payments fetch failed (non-fatal):', e.message);
  }

  return { date: dateStr, items, tenders, ordersCount, source: 'clover-auto', pulledAt: new Date().toISOString() };
}

module.exports = { fetchDaySales, reginaDateToUtcRangeMs };
