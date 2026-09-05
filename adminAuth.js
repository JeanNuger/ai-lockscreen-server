// Simple single-admin auth: one username + bcrypt-hashed password from env
// vars, backed by an express-session cookie. No user accounts, no roles —
// this is a personal admin panel for one operator, not a multi-user system.

function requireAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  // For API calls (fetch from the admin JS), respond with JSON 401 so the
  // frontend can redirect to /admin/login itself, rather than the browser
  // silently following a redirect into a JSON endpoint.
  //
  // Note: req.path here is relative to this router's mount point (/admin),
  // so an API route registered as router.get('/api/devices', ...) shows up
  // as req.path === '/api/devices', not '/admin/api/devices'.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  return res.redirect('/admin/login');
}

module.exports = { requireAdminAuth };
