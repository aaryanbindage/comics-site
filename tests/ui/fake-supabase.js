// Fake supabase-js client driven by window.parent.__scenario, for UI flow tests (tests/ui/run.js).
// Records CSP violations and uncaught errors so the runner can fail on them.
(function () {
  const S = window.parent.__scenario;
  document.addEventListener('securitypolicyviolation', (e) => S.csp.push(e.violatedDirective + ' ' + e.blockedURI));
  window.addEventListener('error', (e) => S.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => S.errors.push('unhandled: ' + (e.reason && e.reason.message || e.reason)));
  if (S.noLib) return; // simulate the library failing to load

  let session = S.session ? JSON.parse(JSON.stringify(S.session)) : null;
  const cbs = [];
  const emit = (ev) => cbs.forEach((cb) => cb(ev, session));
  window.__emit = emit;
  window.__setSession = (s) => { session = s; };
  const delay = (v, ms = 5) => new Promise((r) => setTimeout(() => r(v), ms));
  const IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  function query(table) {
    const st = { filters: {}, op: 'select' };
    const b = {
      select() { return b; }, order() { return b; },
      eq(k, v) { st.filters[k] = v; return b; },
      maybeSingle() { return b; },
      insert(row) { st.op = 'insert'; st.row = row; return b; },
      delete() { st.op = 'delete'; return b; },
      then(res, rej) { return run().then(res, rej); },
    };
    function run() {
      S.calls.push(table + ':' + st.op);
      if (table === 'comics' && st.op === 'select') {
        if (S.comicsError) return delay({ data: null, error: { message: 'boom' } });
        return delay({ data: S.comics.slice(), error: null });
      }
      if (table === 'admins') {
        const ok = S.admins.includes(st.filters.user_id);
        return delay({ data: ok ? { user_id: st.filters.user_id } : null, error: null });
      }
      if (st.op === 'insert') { S.inserted = st.row; S.comics.unshift({ id: 999, ...st.row }); return delay({ data: null, error: null }); }
      if (st.op === 'delete') { S.comics = S.comics.filter((c) => c.id !== st.filters.id); return delay({ data: null, error: null }); }
      return delay({ data: null, error: null });
    }
    return b;
  }

  window.supabase = {
    createClient() {
      return {
        auth: {
          onAuthStateChange(cb) {
            cbs.push(cb);
            if (!S.neverInit) setTimeout(() => cb('INITIAL_SESSION', session), 0);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          getSession() { return delay({ data: { session }, error: null }); },
          getUser() {
            S.getUserCalls = (S.getUserCalls || 0) + 1;
            if (S.getUserHang) return new Promise(() => {});
            if (S.getUserError) return delay({ data: { user: null }, error: S.getUserError });
            return delay({ data: { user: session && session.user }, error: null }, S.getUserDelay || 5);
          },
          signInWithPassword({ email, password }) {
            S.loginEmail = email;
            const u = S.users[email];
            if (u && u.password === password) {
              session = { access_token: 't', user: JSON.parse(JSON.stringify(u.user)) };
              setTimeout(() => emit('SIGNED_IN'), 0);
              return delay({ data: { session }, error: null });
            }
            return delay({ data: {}, error: { message: 'Invalid login credentials', status: 400 } });
          },
          verifyOtp({ email, token, type }) {
            S.verifyCalls = (S.verifyCalls || 0) + 1;
            if (S.verifyHang) return new Promise(() => {});
            const i = S.codes.findIndex((c) => c.email === email && c.token === token && c.type === type);
            if (i < 0) return delay({ data: {}, error: { message: 'Token has expired or is invalid', status: 403 } });
            S.codes.splice(i, 1);
            session = { access_token: 't', user: JSON.parse(JSON.stringify(S.users[email].user)) };
            setTimeout(() => emit('SIGNED_IN'), 0);
            return delay({ data: { session }, error: null });
          },
          // Like the real library: the request goes out, then USER_UPDATED is announced *before*
          // updateUser() returns to the caller.
          async updateUser({ password, data }) {
            await delay(null);
            if (S.updateError) return { data: { user: null }, error: S.updateError };
            Object.assign(session.user.user_metadata, data || {});
            S.users[session.user.email].password = password;
            S.users[session.user.email].user.user_metadata = { ...session.user.user_metadata };
            emit('USER_UPDATED');
            return { data: { user: session.user }, error: null };
          },
          signOut() { session = null; S.signedOut = true; setTimeout(() => emit('SIGNED_OUT'), 0); return delay({ error: null }); },
        },
        from: query,
        storage: {
          from() {
            return {
              createSignedUrls(paths) {
                S.signCalls = (S.signCalls || 0) + 1;
                return delay({ data: paths.map((p) => ({ path: p, signedUrl: (S.badUrls || {})[p] || IMG })), error: null });
              },
              createSignedUrl(p) { S.resigned = (S.resigned || []).concat(p); return delay({ data: { signedUrl: IMG } }); },
              upload(path, file, opts) { S.uploaded = { path, opts }; return delay({ error: null }); },
              remove() { return delay({ error: null }); },
            };
          },
        },
      };
    },
  };
})();
