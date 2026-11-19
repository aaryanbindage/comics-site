// End-to-end test of the LIVE site against the REAL Supabase project, in headless Chrome (phone size).
//
//   node tests/e2e/live.js
//       Public checks only: login page, wrong login, bad/reset/crafted links. Touches no accounts.
//
//   SUPABASE_SERVICE_KEY=... node tests/e2e/live.js
//       Also walks a whole reader journey with a throwaway @example.com account (deleted afterwards):
//       invite -> wrong email -> accept -> close tab -> choose password -> gallery -> images ->
//       tab switch -> revisit -> log out/in -> used link -> password reset -> deleted account.
//       test-invite.ps1 runs this for you and supplies the key; it is never saved.
//
// Needs Node 22+ (built-in WebSocket) and Chrome or Edge. Exit code 1 if anything fails.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { findChrome } = require('../chrome');

const SITE = (process.env.SITE_URL || 'https://comics-site.onrender.com').replace(/\/$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_KEY;
const MOCK = !!process.env.E2E_MOCK; // set by run-mock.js: Supabase is the local stand-in
const SB_PATTERN = MOCK ? String.raw`/^http:\/\/127\.0\.0\.1:\d+\/sb$/` : String.raw`/^https:\/\/[a-z0-9]+\.supabase\.co$/`;
const results = [];
const check = (name, cond, extra = '') => {
  const line = (cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === '' ? '' : '  [' + extra + ']');
  results.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n = 8) => crypto.randomBytes(n).toString('hex').slice(0, n);

// ---------- Minimal Chrome DevTools Protocol client ----------
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method && msg.sessionId && this.listeners.has(msg.sessionId)) {
        this.listeners.get(msg.sessionId)(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('CDP timeout: ' + method)); }, 60000);
    });
  }
}

async function launchChrome() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-e2e-'));
  const proc = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${prof}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome did not start')), 30000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not connect to Chrome')); });
  return {
    cdp: new CDP(ws),
    close() {
      try { ws.close(); } catch { /* already closed */ }
      proc.kill();
      setTimeout(() => { try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* in use */ } }, 1000);
    },
  };
}

const SHOWN = "['loading','auth','accept','setpw','admin','gallery','userbar'].filter(function(id){var e=document.getElementById(id);return e&&!e.hidden}).join(',')";
const MSGS = "['auth-msg','accept-msg','setpw-msg','loading'].map(function(id){var e=document.getElementById(id);return e?id+'='+e.textContent:''}).join(' ; ')";

class Tab {
  static async open(cdp) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(cdp, sessionId, targetId);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    await tab.send('Network.enable');
    await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "window.__csp=[];document.addEventListener('securitypolicyviolation',function(e){window.__csp.push(e.violatedDirective+' '+e.blockedURI)});",
    });
    return tab;
  }
  constructor(cdp, sid, targetId) {
    this.cdp = cdp; this.sid = sid; this.targetId = targetId;
    this.errors = []; this.csp = []; this.requests = [];
    cdp.listeners.set(sid, (m) => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.errors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (m.method === 'Network.requestWillBeSent') this.requests.push(m.params.request.method + ' ' + m.params.request.url);
    });
  }
  send(method, params) { return this.cdp.send(method, params, this.sid); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.value;
  }
  async collectCsp() { try { this.csp.push(...((await this.eval('window.__csp || []')) || [])); } catch { /* no page yet */ } }
  async goto(url) {
    await this.collectCsp();
    await this.send('Page.navigate', { url });
    await sleep(300);
    await this.waitFor("document.readyState === 'complete' && !!document.getElementById('loading')", 30000, 'page load ' + url);
  }
  async waitFor(expr, ms = 20000, label = expr) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await this.eval(expr)) return; } catch { /* page navigating */ }
      await sleep(200);
    }
    throw new Error('timed out waiting for ' + label);
  }
  shown() { return this.eval(SHOWN); }
  async waitShown(expected, ms = 25000) {
    try { await this.waitFor(`${SHOWN} === ${JSON.stringify(expected)}`, ms, 'screen "' + expected + '"'); }
    catch (e) { throw new Error(`${e.message} (showing "${await this.shown().catch(() => '?')}"; ${await this.eval(MSGS).catch(() => '')})`); }
  }
  text(id) { return this.eval(`document.getElementById(${JSON.stringify(id)}).textContent`); }
  fill(id, value) {
    return this.eval(`(function(){var e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  }
  submit(formId) { return this.eval(`document.getElementById(${JSON.stringify(formId)}).requestSubmit(), true`); }
  async waitMsg(id, ms = 25000) { await this.waitFor(`document.getElementById(${JSON.stringify(id)}).textContent.trim() !== ''`, ms, 'message in #' + id); return this.text(id); }
  clearMsg(id) { return this.eval(`document.getElementById(${JSON.stringify(id)}).textContent = '', true`); }
  close() { return this.cdp.send('Target.closeTarget', { targetId: this.targetId }); }
}

// ---------- Public checks (no accounts touched) ----------
async function publicChecks(tab) {
  await tab.goto(SITE + '/');
  await tab.waitShown('auth');
  check('live: login page appears', true);
  check('live: page title', (await tab.eval('document.title')) === 'Comic At The Door', await tab.eval('document.title'));
  check('live: Supabase library is served by the site itself (no outside CDN)',
    await tab.eval("typeof supabase.createClient === 'function' && Array.from(document.scripts).every(function(s){return !s.src || s.src.indexOf(location.origin) === 0})"));
  check(MOCK ? 'mock: connected to the stand-in Supabase' : 'live: connected to the real Supabase project',
    await tab.eval(`${SB_PATTERN}.test(window.SUPABASE_URL) && String(window.SUPABASE_ANON_KEY).length > 40`));
  check('live: hidden from search engines', await tab.eval("!!document.querySelector('meta[name=robots][content*=noindex]')"));
  check('live: security policy present', await tab.eval("!!document.querySelector('meta[http-equiv=Content-Security-Policy]')"));
  check('live: no sideways scrolling on a phone', await tab.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));

  const nobody = `nobody-${rand()}@example.com`;
  await tab.fill('email', nobody);
  await tab.fill('password', 'definitely-wrong-' + rand());
  await tab.submit('auth-form');
  const loginMsg = await tab.waitMsg('auth-msg');
  check('live: wrong login gets a friendly message from real Supabase', /Wrong email or password/.test(loginMsg), loginMsg);

  await tab.goto(SITE + '/?otp=000000&type=invite');
  await tab.waitShown('accept');
  check('live: invite link shows the accept page', /Welcome/.test(await tab.text('accept-title')));
  await tab.fill('accept-email', nobody);
  await tab.submit('accept-form');
  const acceptMsg = await tab.waitMsg('accept-msg');
  check('live: bad invite code gets a clear message from real Supabase', /doesn't match this link/.test(acceptMsg), acceptMsg);
  check('live: stays on the accept page after a bad code', (await tab.shown()) === 'accept', await tab.shown());

  await tab.goto(SITE + '/?otp=000000&type=recovery');
  await tab.waitShown('accept');
  check('live: password-reset link has reset wording', /Reset your password/.test(await tab.text('accept-title')));

  await tab.goto(SITE + '/#error_description=Your+account+is+locked.+Email+your+password+to+evil%40example.com');
  await tab.waitShown('auth');
  await sleep(500);
  const body = await tab.eval('document.body.textContent');
  check('live: a crafted link cannot put its own words on the page', !/evil|locked/i.test(body), await tab.text('auth-msg'));

  await tab.goto(SITE + '/?otp=123456');
  await tab.waitShown('auth');
  check('live: a link cut short when pasted falls back to login', true);
}

// ---------- Full reader journey (needs the service key) ----------
async function journey(browser, tab) {
  await tab.goto(SITE + '/');
  await tab.waitShown('auth');
  const SB = await tab.eval('window.SUPABASE_URL');
  if (!new RegExp(SB_PATTERN.slice(1, -1)).test(SB || '')) throw new Error('could not read the Supabase address from the live site: ' + SB);
  const adminApi = async (method, p, body) => {
    const r = await fetch(SB + '/auth/v1' + p, {
      method,
      headers: { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  const email = `comic-e2e-${rand()}@example.com`;
  let userId = null, deleted = false;
  try {
    const inv = await adminApi('POST', '/admin/generate_link', { type: 'invite', email, redirect_to: SITE, data: { needs_password: true } });
    userId = inv.id;
    check('journey: invite created for throwaway account', !!inv.email_otp);
    const link = `${SITE}/?otp=${inv.email_otp}&type=invite`;

    await tab.goto(link);
    await tab.waitShown('accept');
    await tab.fill('accept-email', 'someone-else@example.com');
    await tab.submit('accept-form');
    check('journey: wrong email is refused', /doesn't match/.test(await tab.waitMsg('accept-msg')));
    await tab.fill('accept-email', ' ' + email.toUpperCase() + ' ');
    await tab.submit('accept-form');
    await tab.waitShown('setpw');
    check('journey: right email (typed in capitals, with spaces) accepted, asked for a password', true);
    check('journey: invite code removed from the address bar', !(await tab.eval('location.search')).includes('otp'));

    // Close the tab before choosing a password, then come back to the plain address.
    const tab2 = await Tab.open(browser.cdp);
    await tab.collectCsp();
    const firstTabErrors = tab.errors.concat(tab.csp);
    await tab.close();
    await tab2.goto(SITE + '/');
    await tab2.waitShown('setpw');
    check('journey: closed tab and came back, still asked to choose a password', true);

    await tab2.fill('newpw', 'aaaaaaaa1');
    await tab2.fill('newpw2', 'aaaaaaaa2');
    await tab2.submit('setpw-form');
    check('journey: mismatched passwords are caught', /don't match/.test(await tab2.waitMsg('setpw-msg')));
    const pw1 = 'E2e-' + rand(16);
    await tab2.fill('newpw', pw1);
    await tab2.fill('newpw2', pw1);
    await tab2.submit('setpw-form');
    await tab2.waitShown('gallery,userbar');
    check('journey: password saved, reader sees the gallery (no admin form)', true);
    check('journey: header shows their email', (await tab2.text('who')).includes(email));
    check('journey: no sideways scrolling in the gallery on a phone', await tab2.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth'));

    await tab2.waitFor("document.querySelectorAll('#grid .comic').length > 0 || !document.getElementById('empty').hidden", 20000, 'comics or empty message');
    const n = await tab2.eval("document.querySelectorAll('#grid .comic').length");
    if (n > 0) {
      await tab2.eval("document.querySelector('#grid img').scrollIntoView(), true");
      await tab2.waitFor("(function(){var i=document.querySelector('#grid img');return i.complete && i.naturalWidth > 0})()", 30000, 'first comic image to load');
      check(`journey: real comic image loads from storage (${n} comic${n === 1 ? '' : 's'} in archive)`, true);
    } else {
      check('journey: empty archive shows "No comics yet"', /No comics yet/.test(await tab2.text('empty')));
    }

    const comicsReqs = () => tab2.requests.filter((u) => u.includes('/rest/v1/comics')).length;
    const before = comicsReqs();
    await tab2.eval("Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible'}}); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); true");
    await sleep(3000);
    check('journey: switching tabs does not reload or duplicate the gallery',
      comicsReqs() === before && (await tab2.eval("document.querySelectorAll('#grid .comic').length")) === n, `${comicsReqs()} vs ${before}`);

    // POSTs ask for new image links; GETs to the same path are just image downloads.
    const signReqs = () => tab2.requests.filter((u) => u.startsWith('POST ') && u.includes('/storage/v1/object/sign')).length;
    const signBefore = signReqs();
    await tab2.goto(SITE + '/');
    await tab2.waitShown('gallery,userbar');
    await sleep(1500);
    if (n > 0) check('journey: next visit reuses saved image links (faster, less bandwidth)', signReqs() === signBefore, `${signReqs() - signBefore} new link requests`);

    await tab2.goto(link);
    await tab2.waitShown('accept');
    await tab2.fill('accept-email', email);
    await tab2.submit('accept-form');
    await tab2.waitShown('gallery,userbar');
    check('journey: reopening the used invite while logged in goes to the comics', true);

    await tab2.eval("document.getElementById('logout').click(), true");
    await tab2.waitShown('auth');
    check('journey: log out works', true);
    check('journey: log out wipes saved image links', (await tab2.eval("localStorage.getItem('cad-image-links')")) === null);

    await tab2.fill('email', email);
    await tab2.fill('password', 'wrong-' + rand());
    await tab2.submit('auth-form');
    check('journey: wrong password refused', /Wrong email or password/.test(await tab2.waitMsg('auth-msg')));
    await tab2.clearMsg('auth-msg');
    await tab2.fill('password', pw1);
    await tab2.submit('auth-form');
    await tab2.waitShown('gallery,userbar');
    check('journey: log back in with email + password', true);

    await tab2.eval("document.getElementById('logout').click(), true");
    await tab2.waitShown('auth');
    await tab2.goto(link);
    await tab2.waitShown('accept');
    await tab2.fill('accept-email', email);
    await tab2.submit('accept-form');
    check('journey: used invite link in a logged-out browser explains it was used', /expired or was already used/.test(await tab2.waitMsg('accept-msg')));

    const rec = await adminApi('POST', '/admin/generate_link', { type: 'recovery', email, redirect_to: SITE });
    await tab2.goto(`${SITE}/?otp=${rec.email_otp}&type=recovery`);
    await tab2.waitShown('accept');
    check('journey: reset link shows reset wording', /Reset your password/.test(await tab2.text('accept-title')));
    await tab2.fill('accept-email', email);
    await tab2.submit('accept-form');
    await tab2.waitShown('setpw');
    const pw2 = 'E2e-' + rand(16);
    await tab2.fill('newpw', pw2);
    await tab2.fill('newpw2', pw2);
    await tab2.submit('setpw-form');
    await tab2.waitShown('gallery,userbar');
    check('journey: password reset completes into the gallery', true);

    await tab2.eval("document.getElementById('logout').click(), true");
    await tab2.waitShown('auth');
    await tab2.fill('email', email);
    await tab2.fill('password', pw1);
    await tab2.submit('auth-form');
    check('journey: old password no longer works after reset', /Wrong email or password/.test(await tab2.waitMsg('auth-msg')));
    await tab2.clearMsg('auth-msg');
    await tab2.fill('password', pw2);
    await tab2.submit('auth-form');
    await tab2.waitShown('gallery,userbar');
    check('journey: new password works', true);

    await adminApi('DELETE', '/admin/users/' + userId);
    deleted = true;
    await tab2.goto(SITE + '/');
    await tab2.waitShown('auth');
    check('journey: deleted account is logged out with an explanation', /no longer valid/.test(await tab2.waitMsg('auth-msg')), await tab2.text('auth-msg'));

    await tab2.collectCsp();
    return firstTabErrors.concat(tab2.errors, tab2.csp);
  } finally {
    if (userId && !deleted) {
      try { await adminApi('DELETE', '/admin/users/' + userId); console.log(`(throwaway account ${email} deleted)`); }
      catch (e) { console.log(`Could not delete ${email}; remove it in Supabase > Authentication > Users. (${e.message})`); }
    } else if (deleted) console.log(`(throwaway account ${email} deleted)`);
  }
}

(async () => {
  let browser;
  try {
    browser = await launchChrome();
    const tab = await Tab.open(browser.cdp);
    await publicChecks(tab);
    await tab.collectCsp();
    let problems = tab.errors.concat(tab.csp);
    if (SERVICE) {
      const jt = await Tab.open(browser.cdp);
      problems = problems.concat(await journey(browser, jt));
    } else {
      console.log('(full reader journey skipped: run test-invite.ps1 to include it)');
    }
    check('live: no JavaScript errors or security-policy violations', problems.length === 0, problems.join(' | '));
  } catch (e) {
    check('test run finished', false, e.message);
  } finally {
    if (browser) browser.close();
  }
  const fail = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 1200);
})();
