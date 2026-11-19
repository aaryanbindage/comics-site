const $ = (id) => document.getElementById(id);
const SECTIONS = ['auth', 'accept', 'setpw', 'admin', 'gallery', 'userbar'];

// Invite / reset links look like /?otp=123456&type=invite. The code is only used when the person
// submits the form with the invited email, so link scanners and chat previews can't use it up,
// and a stray link alone isn't enough to get in.
const qs = new URLSearchParams(location.search);
const linkType = qs.get('type');
let pendingToken = qs.get('otp') && ['invite', 'recovery'].includes(linkType)
  ? { token: qs.get('otp'), type: linkType } : null;

// Links sent by Supabase's own emails arrive as #...&type=invite (or #error_description=... if bad).
let needPassword = /type=(invite|recovery)/.test(location.hash);
const linkError = new URLSearchParams(location.hash.slice(1)).get('error_description');

let isAdmin = false;
let shownUserId = null; // whose gallery is on screen, so re-sent auth events don't reload it
let loadSeq = 0;        // ignore results from an older gallery load

if (!window.supabase || !window.SUPABASE_URL) {
  $('loading').textContent = 'The site could not load. Please refresh the page.';
  throw new Error('Supabase library or config missing');
}
const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

// Reject instead of hanging forever if a request never answers.
function withTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('request timed out')), ms)),
  ]);
}

function show(id, on) { $(id).hidden = !on; }
function showOnly(...ids) { SECTIONS.forEach((id) => show(id, ids.includes(id))); }

function setMsg(id, text, err = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('err', err);
}

// Turn Supabase's technical errors into something a reader understands.
function friendly(error) {
  const m = (error && error.message) || String(error);
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password. If you haven\'t set a password yet, use your invitation link.';
  if (/email not confirmed/i.test(m)) return 'You haven\'t accepted your invitation yet. Use your invitation link, or ask us for a new one.';
  if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a few minutes and try again.';
  if (/failed to fetch|networkerror|load failed|timed out/i.test(m)) return 'Can\'t reach the server. Check your internet connection and try again.';
  if (/should be different/i.test(m)) return 'Please choose a different password from your old one.';
  if (/password/i.test(m) && /characters|weak|short/i.test(m)) return 'That password is too weak. Use at least 8 characters.';
  return m;
}

// Today's date in the viewer's time zone (valueAsDate would use UTC and can be a day ahead).
function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// ---------- Log in ----------
// No signup: accounts exist only if invited.
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  btn.disabled = true;
  setMsg('auth-msg', '');
  try {
    const { error } = await withTimeout(sb.auth.signInWithPassword({
      email: $('email').value.trim().toLowerCase(),
      password: $('password').value,
    }));
    if (error) setMsg('auth-msg', friendly(error), true);
  } catch (err) {
    setMsg('auth-msg', friendly(err), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Accept invitation ----------
$('accept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('accept-btn');
  btn.disabled = true;
  setMsg('accept-msg', '');
  needPassword = true;
  // Clear first so the sign-in event below renders the next step instead of this form again.
  const tok = pendingToken;
  pendingToken = null;
  const email = $('accept-email').value.trim().toLowerCase();
  try {
    const { data: cur } = await withTimeout(sb.auth.getSession());
    const { error } = await withTimeout(sb.auth.verifyOtp({ email, token: tok.token, type: tok.type }));
    if (error) {
      needPassword = false;
      // Link already used, but this browser is already signed in as that same person
      // (e.g. they closed the tab before setting a password): carry on from where they were.
      if (cur.session && cur.session.user.email?.toLowerCase() === email) {
        history.replaceState(null, '', location.pathname);
        return await render(cur.session);
      }
      pendingToken = tok;
      // A wrong email leaves the link usable, so the right person can still retry.
      return setMsg('accept-msg', /rate limit|too many/i.test(error.message)
        ? friendly(error)
        : 'That email doesn\'t match this invitation, or the link has expired or was already used. Check the email and try again, or ask us for a new link.', true);
    }
    history.replaceState(null, '', location.pathname);
    const { data } = await withTimeout(sb.auth.getSession());
    await render(data.session);
  } catch (err) {
    console.error('accept failed', err);
    needPassword = false;
    pendingToken = tok;
    showOnly('accept');
    setMsg('accept-msg', friendly(err), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Set password ----------
$('setpw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pw = $('newpw').value;
  if (pw !== $('newpw2').value) return setMsg('setpw-msg', 'The two passwords don\'t match.', true);
  const btn = $('setpw-btn');
  btn.disabled = true;
  setMsg('setpw-msg', '');
  try {
    const { data: upd, error } = await withTimeout(sb.auth.updateUser({ password: pw, data: { needs_password: false } }));
    if (error) {
      if (/sub claim|does not exist|not found/i.test(error.message)) {
        await sb.auth.signOut({ scope: 'local' });
        return setMsg('auth-msg', 'Your login is no longer valid. Please ask us for a new invitation link.', true);
      }
      return setMsg('setpw-msg', friendly(error), true);
    }
    needPassword = false;
    e.target.reset();
    history.replaceState(null, '', location.pathname);
    const { data } = await sb.auth.getSession();
    await render({ ...data.session, user: upd.user });
  } catch (err) {
    setMsg('setpw-msg', friendly(err), true);
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  const { error } = await sb.auth.signOut();
  if (error) await sb.auth.signOut({ scope: 'local' }); // still log out on this device if offline
});

// ---------- Gallery ----------
async function loadComics() {
  const seq = ++loadSeq;
  const { data, error } = await sb
    .from('comics')
    .select('*')
    .order('published_on', { ascending: false })
    .order('id', { ascending: false });
  if (seq !== loadSeq) return;
  const empty = $('empty');
  if (error) {
    $('grid').replaceChildren();
    empty.hidden = false;
    empty.textContent = 'Could not load comics. Please refresh the page.';
    return;
  }
  empty.hidden = data.length > 0;
  empty.textContent = 'No comics yet. Check back soon!';
  if (!data.length) return $('grid').replaceChildren();

  const { data: signed } = await sb.storage.from('comics').createSignedUrls(data.map((c) => c.image_path), 3600);
  if (seq !== loadSeq) return;
  const urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));

  const frag = document.createDocumentFragment();
  for (const c of data) {
    const card = document.createElement('article');
    card.className = 'comic';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = c.title;
    // Image links expire after an hour; if one fails (tab left open), fetch a fresh link once.
    img.addEventListener('error', async () => {
      if (img.dataset.retried) return;
      img.dataset.retried = '1';
      const { data: fresh } = await sb.storage.from('comics').createSignedUrl(c.image_path, 3600);
      if (fresh) img.src = fresh.signedUrl;
    });
    img.src = urls.get(c.image_path) || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const row = document.createElement('div');
    row.className = 'row';
    const h = document.createElement('h3');
    h.textContent = c.title;
    row.append(h);
    if (isAdmin) {
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => deleteComic(c));
      row.append(del);
    }
    const date = document.createElement('small');
    date.className = 'muted';
    date.textContent = new Date(c.published_on + 'T00:00:00').toLocaleDateString(undefined, { dateStyle: 'long' });
    meta.append(row, date);
    if (c.description) {
      const p = document.createElement('p');
      p.className = 'desc';
      p.textContent = c.description;
      meta.append(p);
    }
    card.append(img, meta);
    frag.append(card);
  }
  $('grid').replaceChildren(frag);
}

async function deleteComic(c) {
  if (!confirm(`Delete "${c.title}"?`)) return;
  // Row first: if that fails, the image is still there and nothing is half-deleted.
  const { error } = await sb.from('comics').delete().eq('id', c.id);
  if (error) return alert(friendly(error));
  await sb.storage.from('comics').remove([c.image_path]);
  loadComics();
}

// ---------- Admin upload ----------
$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('c-file').files[0];
  if (!file) return;
  const btn = $('upload-btn');
  btn.disabled = true;
  setMsg('upload-msg', 'Uploading…');
  try {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const path = `${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from('comics').upload(path, file, { contentType: file.type });
    if (up.error) return setMsg('upload-msg', friendly(up.error), true);

    const { error } = await sb.from('comics').insert({
      title: $('c-title').value.trim(),
      description: $('c-desc').value.trim() || null,
      published_on: $('c-date').value,
      image_path: path,
    });
    if (error) {
      await sb.storage.from('comics').remove([path]);
      return setMsg('upload-msg', friendly(error), true);
    }
    e.target.reset();
    $('c-date').value = today();
    setMsg('upload-msg', 'Uploaded!');
    loadComics();
  } catch (err) {
    setMsg('upload-msg', friendly(err), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Which screen to show ----------
async function render(session) {
  show('loading', false);

  // An invite link always wins, even if this browser is already logged in as someone else.
  if (pendingToken) {
    shownUserId = null;
    return showOnly('accept');
  }

  if (!session) {
    isAdmin = false;
    shownUserId = null;
    loadSeq++;
    $('grid').replaceChildren();
    showOnly('auth');
    if (linkError) setMsg('auth-msg', linkError + '. Please ask us for a new invitation link.', true);
    return;
  }

  const mustSetPassword = needPassword || session.user.user_metadata?.needs_password;
  // Supabase re-announces the login on tab switches; don't rebuild a gallery that's already showing.
  if (!mustSetPassword && shownUserId === session.user.id) return;
  shownUserId = mustSetPassword ? null : session.user.id;

  // A saved login can outlive its account (user deleted / re-invited): confirm with the server.
  // Only a definite "no such user" logs out; a network blip must not.
  const { error: userErr } = await sb.auth.getUser();
  if (userErr && (userErr.status === 401 || userErr.status === 403 || /sub claim|does not exist|not found/i.test(userErr.message))) {
    shownUserId = null;
    await sb.auth.signOut({ scope: 'local' });
    setMsg('auth-msg', 'Your login is no longer valid. Log in again, or ask us for a new invitation link.', true);
    return;
  }

  if (mustSetPassword) return showOnly('setpw');

  const { data } = await sb.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
  isAdmin = !!data;
  $('who').textContent = session.user.email + (isAdmin ? ' (admin)' : '');
  showOnly('userbar', 'gallery', ...(isAdmin ? ['admin'] : []));
  $('c-date').value = today();
  loadComics();
}

// Don't await Supabase calls inside this callback (can deadlock); defer instead.
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'TOKEN_REFRESHED') return; // same user, nothing on screen changes
  setTimeout(() => render(session), 0);
});
