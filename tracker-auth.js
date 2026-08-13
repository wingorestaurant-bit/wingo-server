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
