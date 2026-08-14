// tracker-db.js
// Mongo-backed storage for the Albert Street profit tracker, replacing
// the browser localStorage version so a server-side cron job can write
// data and any device can read the same numbers.
//
// Collections used (created lazily, no special indexes required beyond
// the defaults — low volume, one location, one row per day):
//   tracker_settings  — single docs keyed by _id: 'catalog' | 'fixed-costs'
//   tracker_days      — one doc per date, _id: 'YYYY-MM-DD'

const SEED_CATALOG = [
  { name: "Half Order Wings", category: "Wings", price: 7.99, cost: 2.05 },
  { name: "One Order Wings", category: "Wings", price: 13.99, cost: 3.69 },
  { name: "Two Order Wings", category: "Wings", price: 25.99, cost: 7.38 },
  { name: "Three Order Wings", category: "Wings", price: 37.99, cost: 11.07 },
  { name: "Four Order Wings", category: "Wings", price: 49.99, cost: 14.76 },
  { name: "Half Order Boneless Wings", category: "Boneless & Fingers", price: 7.00, cost: 2.40 },
  { name: "Full Order Chicken Fingers", category: "Boneless & Fingers", price: 13.99, cost: 4.00 },
  { name: "Combo for 1", category: "Combos & Platters", price: 17.45, cost: 4.91 },
  { name: "Combo for 2", category: "Combos & Platters", price: 42.48, cost: 9.10 },
  { name: "Combo for 3", category: "Combos & Platters", price: 57.49, cost: 17.51 },
  { name: "The Tough Guy", category: "Combos & Platters", price: 18.99, cost: 5.49 },
  { name: "A Bit of Other Platter", category: "Combos & Platters", price: 32.99, cost: 12.64 },
  { name: "Tinseltown Nacho", category: "Combos & Platters", price: 29.99, cost: 8.76 },
  { name: "Chicken Poutine", category: "Combos & Platters", price: 14.99, cost: 4.41 },
  { name: "Lunch Deal", category: "Combos & Platters", price: 10.00, cost: 3.18 },
  { name: "Side Sauce", category: "Sides", price: 0.99, cost: 0.10 },
  { name: "Caesar Salad (sm)", category: "Sides", price: 6.99, cost: 1.50 },
  { name: "Cans", category: "Drinks", price: 1.99, cost: 0.50 },
  { name: "Mango Breeze", category: "Drinks", price: 5.95, cost: 1.25 },
  { name: "Glow Lemonade", category: "Drinks", price: 4.95, cost: 1.00 },
  { name: "Watermelon Lemonade", category: "Drinks", price: 4.95, cost: 1.00 },
  { name: "Deep Fried Oreos 6pc", category: "Desserts", price: 5.99, cost: 1.50 },
];

const SEED_FIXED_COSTS = [
  { name: "Rent", monthly: 4300 },
  { name: "Utilities", monthly: 2000 },
  { name: "WiFi", monthly: 160 },
];

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function makeTrackerDb(db) {
  const settings = () => db.collection('tracker_settings');
  const days = () => db.collection('tracker_days');

  async function getCatalog() {
    const doc = await settings().findOne({ _id: 'catalog' });
    if (doc && Array.isArray(doc.items) && doc.items.length) return doc.items;
    const seeded = SEED_CATALOG.map(i => ({ id: uid(), ...i }));
    await settings().updateOne({ _id: 'catalog' }, { $set: { items: seeded } }, { upsert: true });
    return seeded;
  }

  async function saveCatalog(items) {
    await settings().updateOne({ _id: 'catalog' }, { $set: { items } }, { upsert: true });
    return items;
  }

  async function getFixedCosts() {
    const doc = await settings().findOne({ _id: 'fixed-costs' });
    if (doc && Array.isArray(doc.items) && doc.items.length) return doc.items;
    const seeded = SEED_FIXED_COSTS.map(i => ({ id: uid(), ...i }));
    await settings().updateOne({ _id: 'fixed-costs' }, { $set: { items: seeded } }, { upsert: true });
    return seeded;
  }

  async function saveFixedCosts(items) {
    await settings().updateOne({ _id: 'fixed-costs' }, { $set: { items } }, { upsert: true });
    return items;
  }

  // Delivery commission rate — applied to Uber Eats/DoorDash/Skip revenue.
  // Default 30% (their standard delivery commission); editable in the UI.
  async function getCommissionRate() {
    const doc = await settings().findOne({ _id: 'commission-rate' });
    if (doc && typeof doc.rate === 'number') return doc.rate;
    const seeded = 30;
    await settings().updateOne({ _id: 'commission-rate' }, { $set: { rate: seeded } }, { upsert: true });
    return seeded;
  }

  async function saveCommissionRate(rate) {
    const clean = Number(rate) || 0;
    await settings().updateOne({ _id: 'commission-rate' }, { $set: { rate: clean } }, { upsert: true });
    return clean;
  }

  // Packaging (box) cost per order — applied to every order EXCEPT platters
  // (platters use bigger containers, tracked separately if ever needed).
  async function getPackagingCost() {
    const doc = await settings().findOne({ _id: 'packaging-cost' });
    if (doc && typeof doc.perOrder === 'number') return doc.perOrder;
    const seeded = 0.42; // $42/case of 100 boxes
    await settings().updateOne({ _id: 'packaging-cost' }, { $set: { perOrder: seeded } }, { upsert: true });
    return seeded;
  }

  async function savePackagingCost(perOrder) {
    const clean = Number(perOrder) || 0;
    await settings().updateOne({ _id: 'packaging-cost' }, { $set: { perOrder: clean } }, { upsert: true });
    return clean;
  }

  async function getDay(date) {
    const doc = await days().findOne({ _id: date });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  }

  async function saveDay(date, data) {
    await days().updateOne({ _id: date }, { $set: data }, { upsert: true });
    return data;
  }

  async function deleteDay(date) {
    await days().deleteOne({ _id: date });
  }

  async function listDays() {
    const docs = await days().find({}).sort({ _id: 1 }).toArray();
    return docs.map(d => {
      const { _id, ...rest } = d;
      return { date: _id, ...rest };
    });
  }

  return { getCatalog, saveCatalog, getFixedCosts, saveFixedCosts, getCommissionRate, saveCommissionRate, getPackagingCost, savePackagingCost, getDay, saveDay, deleteDay, listDays };
}

module.exports = { makeTrackerDb, SEED_CATALOG, SEED_FIXED_COSTS };
