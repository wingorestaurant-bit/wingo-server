// ── TV LIVE SLIDES ─────────────────────────────────────────────
// Slides the TVs add by themselves, on top of what's uploaded at /tv-admin:
//
//  • Game day: Jets games come from the NHL schedule automatically; Riders (and any other) games
//    are added by hand at /tv-admin. On game day the store's TVs count down to puck drop / kickoff
//    with the game-night deal, then go back to normal 3 hours after the start.
//  • Cold weather: when it feels like −25 or colder at a store (threshold set at /tv-admin), its TVs
//    show "Too cold to cook. We got you." Weather from Open-Meteo (free, no key).
//  • Bragging stats from Clover: orders today, wing orders today, the most ordered flavour this week
//    and how many flavours got tried. Only shown when the numbers are worth bragging about.
//  • Pickup wait: the current online pickup wait (auto or manual) in the corner of every slide.
//  • Instagram: the newest post on the account whose token is in IG_ACCESS_TOKEN (Railway).
//  • Phone alerts: TV-down / back-on alerts also go to the ntfy app on the owner's phone
//    (free push notifications: install "ntfy", subscribe to the topic shown at /tv-admin).
//
// Everything here fails quietly: if a source is down, its slide just doesn't show.

module.exports = function setupTvLive(ctx) {
  const { app, connectDB, LOCATIONS, SEASON_CLOSED, locTz, signageAuth, storeLocalNow, storeOpenNow, getLiveSettings, fetch, fs, path } = ctx;
  const stores = () => Object.keys(LOCATIONS).filter(l => !SEASON_CLOSED.includes(l));
  const hasClover = l => !!(LOCATIONS[l] && LOCATIONS[l].merchantId && LOCATIONS[l].apiToken);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const warn = (what, e) => console.warn(`TV live (${what}):`, e && e.message ? e.message : e);

  // Where each store is, for the weather (city-level is plenty)
  const COORDS = { 'albert-st': [50.4501, -104.6178, 'Regina'], 'east-regina': [50.4466, -104.5400, 'Regina'],
    'winnipeg': [49.8290, -97.1030, 'Winnipeg'], 'regina-beach': [50.7860, -105.1990, 'Regina Beach'] };
  const REGINA_STORES = Object.keys(LOCATIONS).filter(l => /regina/i.test(l) || l === 'albert-st');

  // ── settings (Mongo, key 'tv_auto') ──
  const DEFAULTS = {
    gameday: { enabled: true, deal: 'Order ahead so your wings land before the game starts', teams: { jets: ['winnipeg'], riders: REGINA_STORES }, games: [] },
    weather: { enabled: true, threshold: -25 },
    stats: { enabled: true, minOrders: 25 },
    wait: { enabled: true },
    insta: { enabled: true },
    alerts: { topic: '' },
  };
  let cache = null;
  async function settings(fresh) {
    if (!fresh && cache && Date.now() - cache.at < 20000) return cache.v;
    const database = await connectDB();
    const d = database ? await database.collection('settings').findOne({ key: 'tv_auto' }) : null;
    const v = JSON.parse(JSON.stringify(DEFAULTS));
    if (d) for (const k of Object.keys(DEFAULTS)) if (d[k] && typeof d[k] === 'object') v[k] = Object.assign(v[k], d[k]);
    cache = { at: Date.now(), v };
    return v;
  }
  async function save(patch) {
    const database = await connectDB();
    await database.collection('settings').updateOne({ key: 'tv_auto' }, { $set: { key: 'tv_auto', ...patch, updatedAt: new Date() } }, { upsert: true });
    return settings(true);
  }
  async function getJson(url, opts) {
    const r = await fetch(url, Object.assign({ headers: { 'User-Agent': 'wingo-tv/1.0' } }, opts || {}));
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) { const e = new Error((d && (d.error && d.error.message || d.message)) || `HTTP ${r.status}`); e.status = r.status; throw e; }
    return d;
  }

  // A wall-clock time in a store's time zone → a real moment (UTC). Works across daylight saving.
  function zonedToUtc(date, time, tz) {
    const [Y, M, D] = date.split('-').map(Number), [h, m] = time.split(':').map(Number);
    let t = Date.UTC(Y, M - 1, D, h, m);
    for (let i = 0; i < 2; i++) {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(t)).reduce((o, x) => (o[x.type] = x.value, o), {});
      const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      t += Date.UTC(Y, M - 1, D, h, m) - shown;
    }
    return new Date(t);
  }
  const localDate = (d, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

  // ══ GAME DAY ═══════════════════════════════════════════════
  const NHL = { ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks',
    COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
    LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montréal Canadiens', NSH: 'Nashville Predators', NJD: 'New Jersey Devils', NYI: 'New York Islanders',
    NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken',
    STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights',
    WSH: 'Washington Capitals', WPG: 'Winnipeg Jets' };
  const TEAM = { jets: { name: 'Jets', sport: 'hockey', start: 'puck drop' }, riders: { name: 'Riders', sport: 'football', start: 'kickoff' }, other: { name: 'Game', sport: 'game', start: 'game time' } };
  let jets = { games: [], at: 0, error: null };
  async function refreshJets() {
    try {
      const d = await getJson('https://api-web.nhle.com/v1/club-schedule-season/WPG/now');
      // The nickname ("Oilers", "Maple Leafs") is what fits on a TV
      const teamName = t => {
        if (!t) return '';
        const common = t.commonName && t.commonName.default;
        return common || (NHL[t.abbrev] ? NHL[t.abbrev].replace(/^(Anaheim|Boston|Buffalo|Calgary|Carolina|Chicago|Colorado|Columbus|Dallas|Detroit|Edmonton|Florida|Los Angeles|Minnesota|Montréal|Nashville|New Jersey|New York|Ottawa|Philadelphia|Pittsburgh|San Jose|Seattle|St\. Louis|Tampa Bay|Toronto|Utah|Vancouver|Vegas|Washington|Winnipeg) /, '') : t.abbrev || '');
      };
      jets = { at: Date.now(), error: null, games: (Array.isArray(d.games) ? d.games : [])
        .filter(g => g && g.startTimeUTC && g.homeTeam && g.awayTeam && (g.homeTeam.abbrev === 'WPG' || g.awayTeam.abbrev === 'WPG') && g.gameType !== 1)
        .map(g => { const home = g.homeTeam.abbrev === 'WPG';
          return { id: 'nhl-' + (g.id || g.startTimeUTC), team: 'jets', home, opponent: teamName(home ? g.awayTeam : g.homeTeam), start: new Date(g.startTimeUTC).toISOString(),
            playoff: g.gameType === 3, state: g.gameState || '' }; }) };
    } catch (e) { jets.error = e.message; warn('Jets schedule', e); }
  }
  // Today's game for a store, if any: from the store's local midnight until 3 hours after the start
  async function gameFor(loc) {
    const st = (await settings()).gameday;
    if (!st.enabled) return null;
    const tz = locTz(LOCATIONS[loc]), today = localDate(new Date(), tz), now = Date.now();
    const auto = (st.teams.jets || []).includes(loc) ? jets.games : [];
    const manual = (st.games || []).filter(g => (g.stores && g.stores.length ? g.stores : (st.teams[g.team] || [])).includes(loc));
    return auto.concat(manual)
      .filter(g => { const t = new Date(g.start).getTime(); return localDate(new Date(t), tz) === today && now < t + 3 * 3600e3; })
      .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
  }

  // ══ WEATHER ════════════════════════════════════════════════
  const weather = {};   // loc -> { temp, feels, wind, at }
  async function refreshWeather() {
    for (const loc of stores()) {
      const c = COORDS[loc]; if (!c) continue;
      try {
        const d = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${c[0]}&longitude=${c[1]}&current=temperature_2m,apparent_temperature,wind_speed_10m&timezone=auto`);
        const cur = d.current || {};
        if (typeof cur.temperature_2m === 'number') weather[loc] = { temp: Math.round(cur.temperature_2m), feels: Math.round(typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : cur.temperature_2m),
          wind: Math.round(cur.wind_speed_10m || 0), city: c[2], at: Date.now() };
      } catch (e) { warn('weather ' + loc, e); }
      await sleep(300);
    }
  }

  // ══ CLOVER STATS ═══════════════════════════════════════════
  // The flavour list, read from the ordering page (public/index.html, `var FLAVORS = {...}`)
  let flavourIndex = null;
  function flavours() {
    if (flavourIndex) return flavourIndex;
    const norm = s => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    const map = new Map();
    try {
      const src = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      const start = src.indexOf('var FLAVORS = {');
      let i = src.indexOf('{', start), depth = 0, quote = null, end = -1;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") quote = ch; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = i; break; }
      }
      const F = require('vm').runInNewContext('(' + src.slice(src.indexOf('{', start), end + 1) + ')', {}, { timeout: 1000 });
      Object.values(F).forEach(list => (list || []).forEach(full => {
        const short = String(full).split(' (')[0].trim();
        map.set(norm(full), short); map.set(norm(short), short);
      }));
    } catch (e) { warn('flavour list', e); }
    flavourIndex = { map, norm, total: new Set(map.values()).size };
    return flavourIndex;
  }
  // Flavours named in some text: a Clover modifier ("Honey Garlic") or an order note ("Honey Garlic, Buffalo")
  function flavoursIn(text) {
    const F = flavours(), out = [];
    String(text || '').split(/[,;\n|]+/).forEach(piece => {
      let p = piece.replace(/^\s*(\d+\s*x\s*|x\s*\d+\s*)/i, '').replace(/^[^:]{0,20}:\s*/, '').replace(/\s*x\s*\d+\s*$/i, '').trim();
      if (!p) return;
      const hit = F.map.get(F.norm(p)) || F.map.get(F.norm(p.split(' (')[0]));
      if (hit) out.push(hit);
    });
    return out;
  }
  const isWing = name => /wing/i.test(String(name || ''));
  // The business day starts at 5 AM (stores are open till 3 AM)
  function dayStart(loc) { const n = storeLocalNow(loc); const minsSince = (n.mins - 300 + 1440) % 1440; return Date.now() - minsSince * 60e3 - new Date().getSeconds() * 1000; }

  async function cloverOrdersSince(loc, since) {
    const L = LOCATIONS[loc], out = [];
    for (let page = 0; page < 40; page++) {
      const q = `filter=${encodeURIComponent('createdTime>=' + since)}&expand=${encodeURIComponent('lineItems,lineItems.modifications')}&limit=200&offset=${page * 200}`;
      const d = await getJson(`https://api.clover.com/v3/merchants/${L.merchantId}/orders?${q}`, { headers: { Authorization: `Bearer ${L.apiToken}` } });
      const el = Array.isArray(d.elements) ? d.elements : [];
      out.push(...el);
      if (el.length < 200) break;
      await sleep(250);
    }
    return out;
  }
  const stats = {};   // loc -> { ordersToday, wingOrdersToday, topFlavour, topCount, tried, total, source, at, error }
  async function refreshStats(loc) {
    const today = dayStart(loc), week = Date.now() - 7 * 86400e3;
    const counts = {}; let ordersToday = 0, wingOrdersToday = 0, source = 'clover';
    const add = (f, q) => { counts[f] = (counts[f] || 0) + (q || 1); };
    try {
      if (hasClover(loc)) {
        const orders = await cloverOrdersSince(loc, week);
        for (const o of orders) {
          if (!(Number(o.total) > 0) || /deleted|void/i.test(String(o.state || ''))) continue;
          const items = (o.lineItems && o.lineItems.elements) || [];
          if (Number(o.createdTime) >= today) { ordersToday++; if (items.some(li => isWing(li.name))) wingOrdersToday++; }
          for (const li of items) {
            if (li.refunded) continue;
            const mods = ((li.modifications && li.modifications.elements) || []).map(m => m.name).join(',');
            new Set(flavoursIn(mods + ',' + (li.note || ''))).forEach(f => add(f, 1));
          }
        }
      } else {
        // No Clover connection: count the website's own orders instead
        source = 'website';
        const database = await connectDB();
        const rows = await database.collection('orders').find({ locationId: loc, createdAt: { $gte: new Date(week) } }, { projection: { createdAt: 1, items: 1 } }).toArray();
        for (const o of rows) {
          const items = o.items || [];
          if (new Date(o.createdAt).getTime() >= today) { ordersToday++; if (items.some(i => isWing(i.name))) wingOrdersToday++; }
          items.forEach(i => new Set(flavoursIn(i.flavor)).forEach(f => add(f, Number(i.qty) || 1)));
        }
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      stats[loc] = { ordersToday, wingOrdersToday, topFlavour: top ? top[0] : null, topCount: top ? top[1] : 0, tried: Object.keys(counts).length,
        total: flavours().total, source, at: Date.now(), error: null };
    } catch (e) { stats[loc] = Object.assign(stats[loc] || {}, { error: e.message, at: Date.now() }); warn('stats ' + loc, e); }
  }
  async function refreshAllStats() {
    if (!(await settings()).stats.enabled) return;
    for (const loc of stores()) { if (storeOpenNow(loc) || !stats[loc]) await refreshStats(loc); await sleep(500); }
  }

  // ══ INSTAGRAM ══════════════════════════════════════════════
  // A long-lived token from "Instagram API with Instagram Login". It's refreshed weekly (they last 60 days);
  // the refreshed one is kept in Mongo so the Railway variable only needs setting once.
  let insta = { post: null, username: '', at: 0, error: null };
  async function igToken() {
    const database = await connectDB();
    const d = database ? await database.collection('settings').findOne({ key: 'tv_auto_secret' }) : null;
    const env = process.env.IG_ACCESS_TOKEN || '';
    // A new token pasted on Railway wins over the one saved from an earlier refresh
    if (d && d.igToken && d.igFrom === env) return { token: d.igToken, refreshedAt: d.igRefreshedAt };
    return env ? { token: env, refreshedAt: null } : null;
  }
  async function refreshInsta() {
    const t = await igToken();
    if (!t) { insta = { post: null, username: '', at: Date.now(), error: 'not-set-up' }; return; }
    try {
      if (!t.refreshedAt || Date.now() - new Date(t.refreshedAt).getTime() > 7 * 86400e3) {
        try {
          const r = await getJson(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.token)}`);
          if (r.access_token) {
            const database = await connectDB();
            await database.collection('settings').updateOne({ key: 'tv_auto_secret' },
              { $set: { key: 'tv_auto_secret', igToken: r.access_token, igFrom: process.env.IG_ACCESS_TOKEN || '', igRefreshedAt: new Date() } }, { upsert: true });
            t.token = r.access_token;
          }
        } catch (e) { warn('Instagram token refresh', e); }
      }
      const me = await getJson(`https://graph.instagram.com/me?fields=username&access_token=${encodeURIComponent(t.token)}`);
      const m = await getJson(`https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=6&access_token=${encodeURIComponent(t.token)}`);
      const post = (m.data || []).map(p => ({ id: p.id, img: p.media_type === 'VIDEO' ? p.thumbnail_url : p.media_url, caption: String(p.caption || ''), at: p.timestamp, link: p.permalink }))
        .filter(p => p.img)[0] || null;
      insta = { post, username: me.username || '', at: Date.now(), error: null };
    } catch (e) { insta = Object.assign(insta, { error: e.message, at: Date.now() }); warn('Instagram', e); }
  }

  // ══ PHONE ALERTS (ntfy) ════════════════════════════════════
  async function phone(title, message, tags) {
    try {
      const topic = (await settings()).alerts.topic;
      if (!topic) return false;
      const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body: String(message).slice(0, 1000),
        headers: { Title: String(title).replace(/[^\x20-\x7E]/g, '').trim().slice(0, 200) || 'Wing-O', Priority: 'high', Tags: tags || 'tv' } });
      return r.ok;
    } catch (e) { warn('phone alert', e); return false; }
  }

  // ══ WHAT ONE TV SHOWS ══════════════════════════════════════
  async function forScreen(loc) {
    const st = await settings(), out = { slides: [], wait: null };
    if (!LOCATIONS[loc]) return out;
    const open = storeOpenNow(loc);
    const g = await gameFor(loc).catch(() => null);
    if (g) {
      const T = TEAM[g.team] || TEAM.other;
      out.slides.push({ id: 'auto-gameday', kind: 'gameday', seconds: 15, priority: true,
        game: { team: g.team, teamName: g.team === 'other' ? (g.label || 'Game') : T.name, opponent: g.opponent || '', home: g.home !== false, start: g.start, startWord: T.start, sport: T.sport, playoff: !!g.playoff },
        deal: st.gameday.deal || '' });
    }
    const w = weather[loc];
    if (st.weather.enabled && w && Date.now() - w.at < 3 * 3600e3 && w.feels <= Number(st.weather.threshold))
      out.slides.push({ id: 'auto-weather', kind: 'weather', seconds: 12, temp: w.temp, feels: w.feels, wind: w.wind, city: w.city, qr: `/images/tv-qr-${loc}.svg` });
    const s = stats[loc];
    if (st.stats.enabled && s && !s.error && Date.now() - s.at < 6 * 3600e3) {
      const showOrders = s.ordersToday >= Number(st.stats.minOrders || 0);
      const showFlavour = s.topFlavour && s.topCount >= 5;
      if (showOrders || showFlavour)
        out.slides.push({ id: 'auto-stats', kind: 'stats', seconds: 12, ordersToday: showOrders ? s.ordersToday : null, wingOrdersToday: showOrders && s.wingOrdersToday >= 5 ? s.wingOrdersToday : null,
          topFlavour: showFlavour ? s.topFlavour : null, topCount: showFlavour ? s.topCount : 0, tried: s.tried >= 10 ? s.tried : null, total: s.total });
    }
    if (st.insta.enabled && insta.post && Date.now() - insta.at < 6 * 3600e3)
      out.slides.push({ id: 'auto-insta-' + insta.post.id, kind: 'insta', seconds: 12, img: insta.post.img, caption: insta.post.caption.slice(0, 220), handle: insta.username, at: insta.post.at });
    if (st.wait.enabled && open) {
      // Same default as online ordering and the auto wait: 20 minutes until one is picked in /admin
      const mins = Number(((await getLiveSettings()).wait || {})[loc]) || 20;
      out.wait = mins > 0 ? mins : null;
    }
    return out;
  }
  // Mix the automatic slides into the uploaded ones: the game-day slide first (and again halfway on a
  // long playlist), the rest spread out evenly
  function mix(items, auto) {
    if (!auto.length) return items;
    const lead = auto.filter(a => a.priority), rest = auto.filter(a => !a.priority);
    const out = items.slice();
    rest.forEach((a, k) => { const at = Math.min(out.length, Math.round((k + 1) * out.length / (rest.length + 1)) + k); out.splice(at, 0, a); });
    if (lead.length) { out.unshift(...lead); if (out.length >= 6) out.splice(Math.floor(out.length / 2), 0, ...lead.map(a => Object.assign({}, a, { id: a.id + '-2' }))); }
    return out;
  }

  // ══ ADMIN API (/tv-admin) ══════════════════════════════════
  const guard = (req, res) => { if (!signageAuth(req)) { res.status(401).json({ error: 'Wrong password' }); return false; } return true; };
  const storeList = v => (Array.isArray(v) ? v : []).map(String).filter(l => LOCATIONS[l]);
  async function state() {
    const st = await settings(true), now = Date.now();
    return {
      settings: st,
      jets: { next: jets.games.filter(g => new Date(g.start).getTime() + 3 * 3600e3 > now).slice(0, 5), error: jets.error, at: jets.at },
      stores: stores().map(l => ({ id: l, name: LOCATIONS[l].name, clover: hasClover(l), weather: weather[l] || null, stats: stats[l] || null, open: storeOpenNow(l) })),
      insta: { ready: !!insta.post, username: insta.username, error: insta.error, at: insta.at, post: insta.post ? { img: insta.post.img, at: insta.post.at } : null },
    };
  }
  app.get('/api/tvauto/state', async (req, res) => {
    if (!guard(req, res)) return;
    try { res.json(await state()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/tvauto/settings', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const b = (req.body || {}).patch || {}, cur = await settings(true), patch = {};
      const bool = (v, d) => typeof v === 'boolean' ? v : d;
      if (b.gameday) {
        const G = cur.gameday, t = b.gameday.teams || {};
        patch.gameday = { enabled: bool(b.gameday.enabled, G.enabled), deal: typeof b.gameday.deal === 'string' ? b.gameday.deal.slice(0, 140) : G.deal,
          teams: { jets: t.jets ? storeList(t.jets) : G.teams.jets, riders: t.riders ? storeList(t.riders) : G.teams.riders }, games: G.games };
        if (Array.isArray(b.gameday.games)) {
          const games = [];
          for (const g of b.gameday.games.slice(0, 60)) {
            const team = ['jets', 'riders', 'other'].includes(g.team) ? g.team : 'other';
            let start = g.start && !isNaN(new Date(g.start)) ? new Date(g.start) : null;
            if (!start && /^\d{4}-\d{2}-\d{2}$/.test(g.date || '') && /^\d{1,2}:\d{2}$/.test(g.time || '')) {
              const where = storeList(g.stores)[0] || (patch.gameday.teams[team] || [])[0] || 'albert-st';
              start = zonedToUtc(g.date, g.time, locTz(LOCATIONS[where]));
            }
            if (!start) continue;
            // A double tap on "Add game" doesn't add it twice
            if (games.some(x => x.team === team && x.start === start.toISOString() && x.opponent === String(g.opponent || '').slice(0, 60))) continue;
            games.push({ id: String(g.id || ('m-' + start.getTime() + '-' + Math.random().toString(36).slice(2, 6))).slice(0, 40), team,
              label: String(g.label || '').slice(0, 30), opponent: String(g.opponent || '').slice(0, 60), home: g.home !== false,
              start: start.toISOString(), stores: storeList(g.stores) });
          }
          // Games more than a day old are tidied away
          patch.gameday.games = games.filter(g => new Date(g.start).getTime() > Date.now() - 86400e3).sort((a, b) => new Date(a.start) - new Date(b.start));
        }
      }
      if (b.weather) { const n = Number(b.weather.threshold); patch.weather = { enabled: bool(b.weather.enabled, cur.weather.enabled), threshold: Number.isFinite(n) ? Math.min(0, Math.max(-50, Math.round(n))) : cur.weather.threshold }; }
      if (b.stats) { const n = Number(b.stats.minOrders); patch.stats = { enabled: bool(b.stats.enabled, cur.stats.enabled), minOrders: Number.isFinite(n) ? Math.min(500, Math.max(0, Math.round(n))) : cur.stats.minOrders }; }
      if (b.wait) patch.wait = { enabled: bool(b.wait.enabled, cur.wait.enabled) };
      if (b.insta) patch.insta = { enabled: bool(b.insta.enabled, cur.insta.enabled) };
      if (b.alerts) {
        const topic = String(b.alerts.topic || '').trim();
        if (topic && !/^[A-Za-z0-9_-]{12,64}$/.test(topic)) return res.status(400).json({ error: 'The alert code must be 12–64 letters, numbers, - or _.' });
        patch.alerts = { topic };
      }
      await save(patch);
      if (patch.stats && patch.stats.enabled) refreshAllStats().catch(() => {});
      res.json(await state());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/tvauto/test-alert', async (req, res) => {
    if (!guard(req, res)) return;
    const ok = await phone('Wing-O test alert', 'If you can read this, TV alerts will reach your phone. 📺', 'white_check_mark');
    res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'Could not send. Check the alert code is saved first.' });
  });
  app.post('/api/tvauto/refresh', async (req, res) => {
    if (!guard(req, res)) return;
    await Promise.allSettled([refreshJets(), refreshWeather(), refreshInsta(), (async () => { for (const l of stores()) await refreshStats(l); })()]);
    res.json(await state());
  });

  // ── schedule ──
  setTimeout(() => { refreshJets(); refreshWeather(); refreshInsta(); refreshAllStats(); }, 20e3);
  setInterval(refreshJets, 6 * 3600e3);
  setInterval(refreshWeather, 20 * 60e3);
  setInterval(() => refreshAllStats().catch(e => warn('stats', e)), 15 * 60e3);
  setInterval(refreshInsta, 30 * 60e3);

  return { forScreen, mix, phone, _test: { refreshJets, refreshWeather, refreshStats, refreshInsta, flavoursIn, zonedToUtc, gameFor, jets: () => jets, weather, stats } };
};
