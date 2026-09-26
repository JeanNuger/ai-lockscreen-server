require('dotenv').config();

const express = require('express');
const session = require('express-session');
const registerRoute = require('./routes/register');
const batchRoute = require('./routes/batch');
const adminRoute = require('./routes/admin');
const internalGenerateBankRoute = require('./routes/internalGenerateBank');

// Safety net: log and keep running instead of crashing the whole process on
// an unexpected rejected promise anywhere in the app (route handlers still
// use their own try/catch + next(err) as the primary path — this is a backstop).
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

const app = express();

// Render (and most hosting platforms) put the app behind a reverse-proxy
// layer, so req.ip would otherwise report a proxy's own address for every
// request — trust proxy makes Express read the real client IP from
// X-Forwarded-For instead. Needed for express-rate-limit (src/routes/admin.js)
// to actually rate-limit per real client rather than treating every request
// as coming from the same address; express-rate-limit also refuses to start
// without this once it sees X-Forwarded-For on an untrusted proxy setup.
//
// Was `1` (trust exactly one hop) until the batch_id 19 production incident
// (2026-09-26): a phone physically in Astana, Kazakhstan got back weather
// for Frankfurt am Main — this server's own Render hosting region — meaning
// req.ip was resolving to a Render-internal proxy address, not the phone's
// real IP, and geolocation was faithfully geolocating THAT address. With
// trust proxy=1, Express's proxy-addr trusts exactly one hop closest to the
// app and returns the address just before it; if Render's edge network
// actually forwards a request through TWO hops before it reaches this
// process (its public-facing router, then an internal load-balancer/highway
// layer in front of the container — both hops append to X-Forwarded-For),
// trusting only one of them lands on that second, still-internal Render hop
// instead of the original client IP, which naturally geolocates to Render's
// own datacenter (Frankfurt) — exactly the observed symptom. Bumped to `2`
// so Express walks back two trusted hops and reaches the actual client
// entry. This is a pragmatic fix based on the observed symptom (an internal
// Render/Frankfurt IP instead of the client's) rather than a documented
// exact hop count from Render — if a future trace shows req.ip resolving to
// some OTHER unexpected address, re-check this number.
app.set('trust proxy', 2);

app.use(express.json());

// Session cookie for the admin panel only (see src/adminAuth.js). Uses the
// default in-memory store, which is fine for a single-instance admin panel —
// sessions simply reset (admin has to log in again) if the process restarts.
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-in-.env-SESSION_SECRET',
  resave: false,
  saveUninitialized: false,
  cookie: {
    // secure:true would also work once the site is served over HTTPS in
    // production; left false here so login also works during local/http
    // testing. If deploying behind HTTPS only, this can be tightened.
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24h
  },
}));

// Simple health check — useful for hosting platforms (Railway/Render) to
// confirm the deploy is alive, and for a quick manual curl check.
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    openai_configured: Boolean(process.env.OPENAI_API_KEY),
    commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null,
  });
});

app.use('/api/v1', registerRoute);
app.use('/api/v1', batchRoute);
app.use('/admin', adminRoute);
app.use('/', internalGenerateBankRoute);

// Catch-all error handler — never let an unhandled error crash the process
// or leak a stack trace to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ai-lockscreen-server listening on port ${PORT}`);
  console.log(`OpenAI configured: ${Boolean(process.env.OPENAI_API_KEY)}`);
});
