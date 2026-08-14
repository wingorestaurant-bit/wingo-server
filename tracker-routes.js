// tracker-routes.js
// Mounts the /api/tracker/* endpoints and the automatic-daily-sync cron job.
//
// Usage in index.js:
//   const trackerAuth = require('./tracker-auth');
//   const { mountTrackerRoutes } = require('./tracker-routes');
//   mountTrackerRoutes(app, trackerAuth, connectDB, LOCATIONS['albert-st']);

const express = require('express');
const cron = require('node-cron');
const { makeTrackerDb } = require('./tracker-db');
const { fetchDaySales } = require('./clover-sync');

function reginaDateStr(offsetDays = 0) {
  // "Today" (or N days ago) as YYYY-MM-DD in Regina local time (fixed UTC-6, no DST).
  const now = new Date(Date.now() - offsetDays * 86400000);
  const reginaMs = now.getTime() - 6 * 60 * 60 * 1000;
  const d = new Date(reginaMs);
  return d.toISOString().slice(0, 10);
}

function matchCatalogItem(catalog, name) {
  const norm = s => (s || '').trim().toLowerCase();
  return catalog.find(c => norm(c.name) === norm(name)) || null;
}

async function runSyncForDate(trackerDb, location, dateStr) {
  const catalog = await trackerDb.getCatalog();
  const cloverResult = await fetchDaySales(location, dateStr);

  const items = cloverResult.items.map(ci => {
    const match = matchCatalogItem(catalog, ci.name);
    return {
      name: ci.name,
      qty: ci.qty,
      unitPrice: ci.qty ? ci.revenue / ci.qty : 0,
      revenue: ci.revenue,
      cost: match ? match.cost : null, // null cost = unmatched, flagged in the UI same as before
      refundedQty: ci.refundedQty || 0
    };
  });

  const existing = await trackerDb.getDay(dateStr);
  const merged = {
    items,
    expenses: (existing && existing.expenses) || [], // never overwrite manually-entered expenses/labour
    tenders: cloverResult.tenders,
    ordersCount: cloverResult.ordersCount,
    source: 'clover-auto',
    lastSyncedAt: cloverResult.pulledAt
  };
  await trackerDb.saveDay(dateStr, merged);
  return merged;
}

function scheduleDailySync(trackerDb, location) {
  // 5:00 AM Regina time daily = 11:00 UTC (Regina has no DST, fixed UTC-6).
  // Picked deliberately later than the latest closing time (3am Thu-Sun) so
  // the previous day's orders are fully closed out before we pull them.
  cron.schedule('0 11 * * *', async () => {
    const dateStr = reginaDateStr(1); // yesterday, since it's now after close
    console.log(`[tracker-sync] Running scheduled sync for ${dateStr}...`);
    try {
      const result = await runSyncForDate(trackerDb, location, dateStr);
      console.log(`[tracker-sync] Synced ${dateStr}: ${result.items.length} items, ${result.ordersCount} orders.`);
    } catch (e) {
      console.error(`[tracker-sync] Scheduled sync FAILED for ${dateStr}:`, e.message);
    }
  }, { timezone: 'UTC' });
  console.log('[tracker-sync] Daily auto-sync scheduled for 11:00 UTC (5am Regina).');
}

function mountTrackerRoutes(app, trackerAuth, connectDB, location) {
  const router = express.Router();
  router.use(express.json());
  router.use(trackerAuth);

  router.get('/catalog', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      res.json({ success: true, items: await trackerDb.getCatalog() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.post('/catalog', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      const items = await trackerDb.saveCatalog(req.body.items || []);
      res.json({ success: true, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.get('/fixed-costs', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      res.json({ success: true, items: await trackerDb.getFixedCosts() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.post('/fixed-costs', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      const items = await trackerDb.saveFixedCosts(req.body.items || []);
      res.json({ success: true, items });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.get('/day/:date', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      const day = await trackerDb.getDay(req.params.date);
      res.json({ success: true, day });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.post('/day/:date', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      const data = await trackerDb.saveDay(req.params.date, req.body);
      res.json({ success: true, day: data });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.delete('/day/:date', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      await trackerDb.deleteDay(req.params.date);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  router.get('/days', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      res.json({ success: true, days: await trackerDb.listDays() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Manual trigger — call this to pull a specific date from Clover right now,
  // instead of waiting for the 5am job. Handy for testing and backfilling.
  router.post('/sync/:date', async (req, res) => {
    try {
      const db = await connectDB();
      const trackerDb = makeTrackerDb(db);
      const result = await runSyncForDate(trackerDb, location, req.params.date);
      res.json({ success: true, day: result });
    } catch (e) {
      console.error('[tracker-sync] Manual sync failed:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.use('/api/tracker', router);

  // Kick off the recurring job. Needs a DB connection at schedule-fire time,
  // not at startup, so we pass connectDB in and resolve it inside runSyncForDate.
  connectDB().then(db => {
    if (db) scheduleDailySync(makeTrackerDb(db), location);
    else console.error('[tracker-sync] No DB connection — auto-sync NOT scheduled.');
  });
}

module.exports = { mountTrackerRoutes, runSyncForDate };
