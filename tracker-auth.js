// tracker-auth.js
// HTTP Basic Auth middleware for the Albert Street profit tracker.
// The password check happens here, server-side, using an environment
// variable — it never appears in any HTML/JS sent to the browser.
//
// Set on Railway (same place as your KITCHEN_PW_* vars):
//   TRACKER_USER = wingo        (or whatever you want)
//   TRACKER_PASSWORD = Gur@mehar$$

function trackerAuth(req, res, next) {
  const expectedUser = process.env.TRACKER_USER || "wingo";
  const expectedPass = process.env.TRACKER_PASSWORD;

  if (!expectedPass) {
    console.error("TRACKER_PASSWORD env var is not set — refusing to serve the tracker.");
    res.status(500).send("Tracker is not configured. Set TRACKER_PASSWORD in your environment.");
    return;
  }

  const authHeader = req.headers.authorization || "";
  const [scheme, encoded] = authHeader.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);

    if (user === expectedUser && pass === expectedPass) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="WingO Albert Street Tracker"');
  res.status(401).send("Authentication required.");
}

module.exports = trackerAuth;

/* ---------------------------------------------------------------------
   HOW TO WIRE THIS INTO YOUR EXISTING index.js
   ---------------------------------------------------------------------

   1. Save this file as tracker-auth.js in the same folder as index.js.

   2. In index.js, near your other requires:
        const trackerAuth = require('./tracker-auth');
        const path = require('path'); // if not already imported

   3. Add a protected route BEFORE any general static file middleware
      that might otherwise serve the tracker unprotected:
        app.get('/tracker', trackerAuth, (req, res) => {
          res.sendFile(path.join(__dirname, 'tracker.html'));
        });

   4. Put the tracker HTML file (Albert_Street_Profit_Tracker_Server.html,
      renamed to tracker.html) in the same folder as index.js — NOT in
      your public/ static folder, so it can't be reached by a direct
      guessable URL without going through the /tracker route above.

   5. On Railway, add two environment variables to this service:
        TRACKER_USER      = wingo
        TRACKER_PASSWORD  = Gur@mehar$$
      (Pick any username you like for TRACKER_USER — it's just the
      first field of the login prompt, not a real user account.)

   6. Deploy. Visiting https://yourdomain.com/tracker will now show
      your browser's native login popup before anything loads. Wrong
      password = 401, no page content sent at all.

   To change the password later: update TRACKER_PASSWORD on Railway
   and redeploy — nothing in the HTML file needs to change.
--------------------------------------------------------------------- */
