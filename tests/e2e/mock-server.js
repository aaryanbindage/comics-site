// A small stand-in for the Supabase HTTP API (auth, REST, storage), mounted at /sb on the same server
// as the site. The REAL supabase-js library and the real page talk to it, so the full reader journey in
// live.js can run offline. Behaviour mirrors what test-invite.ps1 confirmed against the real project:
// re-invite replaces the code, codes are single-use, existing accounts get 422 on invite, etc.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.resolve(__dirname, '..', '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

exports.start = function start(port, onListening) {
  const users = new Map();    // id -> { id, email, password, meta, confirmed, otps }
  const tokens = new Map();   // access token -> user id
  const refresh = new Map();  // refresh token -> user id
  const comics = [
    { id: 1, title: 'Mock comic two', description: 'Second one', image_path: 'two.png', published_on: '2026-11-15' },
    { id: 2, title: 'Mock comic one', description: null, image_path: 'one.png', published_on: '2026-11-08' },
  ];
  const byEmail = (e) => [...users.values()].find((u) => u.email === String(e || '').toLowerCase());
  const otp = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const now = () => new Date().toISOString();
  const pub = (u) => ({
    id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
    email_confirmed_at: u.confirmed ? now() : null, user_metadata: u.meta,
    app_metadata: { provider: 'email', providers: ['email'] }, created_at: now(), updated_at: now(),
  });
  const session = (u) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const at = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp, session_id: crypto.randomUUID() })}.${crypto.randomBytes(8).toString('hex')}`;
    const rt = crypto.randomBytes(8).toString('hex');
    tokens.set(at, u.id);
    refresh.set(rt, u.id);
    return { access_token: at, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user: pub(u) };
  };
  const who = (req) => {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!tokens.has(t)) return { none: true };
    const u = users.get(tokens.get(t));
    return u ? { u } : { deleted: true };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
      const p = url.pathname;

      if (p.startsWith('/sb/')) {
        const api = p.slice(3);
        const m = req.method;
        if (m === 'POST' && api === '/auth/v1/admin/generate_link') {
          const email = String(body.email).toLowerCase();
          let u = byEmail(email);
          if (body.type === 'invite') {
            if (u && u.confirmed) return send(422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
            if (!u) { u = { id: crypto.randomUUID(), email, password: null, meta: { ...(body.data || {}) }, confirmed: false, otps: {} }; users.set(u.id, u); }
          } else if (!u) return send(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
          u.otps = { [body.type]: otp() };
          return send(200, { ...pub(u), email_otp: u.otps[body.type], hashed_token: 'x', verification_type: body.type, redirect_to: body.redirect_to });
        }
        if (m === 'DELETE' && api.startsWith('/auth/v1/admin/users/')) { users.delete(api.split('/').pop()); return send(200, {}); }
        if (m === 'POST' && api === '/auth/v1/verify') {
          const u = byEmail(body.email);
          if (!u || !u.otps[body.type] || u.otps[body.type] !== body.token) return send(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
          delete u.otps[body.type];
          u.confirmed = true;
          return send(200, session(u));
        }
        if (m === 'POST' && api === '/auth/v1/token') {
          if (url.searchParams.get('grant_type') === 'refresh_token') {
            const u = users.get(refresh.get(body.refresh_token));
            return u ? send(200, session(u)) : send(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
          }
          const u = byEmail(body.email);
          if (!u || !u.password || u.password !== body.password) return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          return send(200, session(u));
        }
        if (api === '/auth/v1/user') {
          const w = who(req);
          if (w.deleted) return send(403, { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' });
          if (!w.u) return send(401, { code: 401, error_code: 'no_authorization', msg: 'This endpoint requires a Bearer token' });
          if (m === 'PUT') {
            if (body.password) w.u.password = body.password;
            if (body.data) Object.assign(w.u.meta, body.data);
          }
          return send(200, pub(w.u));
        }
        if (m === 'POST' && api === '/auth/v1/logout') { res.writeHead(204); return res.end(); }
        if (m === 'GET' && api === '/rest/v1/comics') return send(200, who(req).u ? comics.slice().sort((a, b) => b.published_on.localeCompare(a.published_on)) : []);
        if (m === 'GET' && api === '/rest/v1/admins') return send(200, []);
        if (m === 'POST' && api === '/storage/v1/object/sign/comics') {
          if (!who(req).u) return send(400, { statusCode: '403', error: 'Unauthorized', message: 'not allowed' });
          return send(200, body.paths.map((x) => ({ error: null, path: x, signedURL: `/object/sign/comics/${x}?token=t${Date.now()}` })));
        }
        if (m === 'POST' && api.startsWith('/storage/v1/object/sign/comics/')) {
          const x = api.split('/').pop();
          return send(200, { signedURL: `/object/sign/comics/${x}?token=t${Date.now()}` });
        }
        if (m === 'GET' && api.startsWith('/storage/v1/object/sign/comics/')) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(PNG); }
        return send(404, { msg: 'mock: no route ' + m + ' ' + api });
      }

      // The site itself, with config.js pointing at this mock.
      if (p === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        return res.end(`window.SUPABASE_URL = "http://127.0.0.1:${server.address().port}/sb";\nwindow.SUPABASE_ANON_KEY = "mock-anon-key-0000000000000000000000000000000000";\n`);
      }
      const rel = p === '/' ? '/index.html' : decodeURIComponent(p);
      const f = path.join(root, rel);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
  });
  server.listen(port, '127.0.0.1', () => onListening && onListening(server.address().port));
  return server;
};
