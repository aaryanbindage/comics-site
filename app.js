// Capture before the client consumes the URL hash: invite/reset links need a password set.
let needPassword = /type=(invite|recovery)/.test(location.hash);

const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let isAdmin = false;

function show(id, on) { $(id).hidden = !on; }

function setMsg(id, text, err = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('err', err);
}

// ---------- Auth ----------
// No signup: accounts exist only if invited from the Supabase dashboard.
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  btn.disabled = true;
  setMsg('auth-msg', '');
  const { error } = await sb.auth.signInWithPassword({
    email: $('email').value.trim(),
    password: $('password').value,
  });
  btn.disabled = false;
  if (error) setMsg('auth-msg', error.message, true);
});

$('forgot').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  if (!email) return setMsg('auth-msg', 'Enter your email above first.', true);
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
  setMsg('auth-msg', error ? error.message : 'If that email is invited, a reset link is on its way.', !!error);
});

$('setpw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $('newpw').value });
  if (error) return setMsg('setpw-msg', error.message, true);
  needPassword = false;
  history.replaceState(null, '', location.pathname);
  const { data } = await sb.auth.getSession();
  render(data.session);
});

$('logout').addEventListener('click', () => sb.auth.signOut());

// ---------- Gallery ----------
async function loadComics() {
  const { data, error } = await sb
    .from('comics')
    .select('*')
    .order('published_on', { ascending: false })
    .order('id', { ascending: false });
  const grid = $('grid');
  grid.replaceChildren();
  if (error) { $('empty').hidden = false; $('empty').textContent = 'Could not load comics: ' + error.message; return; }
  $('empty').hidden = data.length > 0;
  $('empty').textContent = 'No comics yet.';
  if (!data.length) return;

  const { data: signed } = await sb.storage.from('comics').createSignedUrls(data.map((c) => c.image_path), 3600);
  const urls = new Map((signed || []).map((s) => [s.path, s.signedUrl]));

  for (const c of data) {
    const card = document.createElement('article');
    card.className = 'comic';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = c.title;
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
      p.textContent = c.description;
      p.style.margin = '4px 0 0';
      meta.append(p);
    }
    card.append(img, meta);
    grid.append(card);
  }
}

async function deleteComic(c) {
  if (!confirm(`Delete "${c.title}"?`)) return;
  await sb.storage.from('comics').remove([c.image_path]);
  const { error } = await sb.from('comics').delete().eq('id', c.id);
  if (error) return alert(error.message);
  loadComics();
}

// ---------- Admin upload ----------
$('upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('c-file').files[0];
  if (!file) return;
  const btn = e.submitter;
  btn.disabled = true;
  setMsg('upload-msg', 'Uploading…');

  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from('comics').upload(path, file, { contentType: file.type });
  if (up.error) { btn.disabled = false; return setMsg('upload-msg', up.error.message, true); }

  const { error } = await sb.from('comics').insert({
    title: $('c-title').value.trim(),
    description: $('c-desc').value.trim() || null,
    published_on: $('c-date').value,
    image_path: path,
  });
  btn.disabled = false;
  if (error) {
    await sb.storage.from('comics').remove([path]);
    return setMsg('upload-msg', error.message, true);
  }
  e.target.reset();
  $('c-date').valueAsDate = new Date();
  setMsg('upload-msg', 'Uploaded!');
  loadComics();
});

// ---------- Session handling ----------
async function render(session) {
  if (!session) {
    isAdmin = false;
    show('setpw', false); show('auth', true); show('gallery', false); show('admin', false); show('userbar', false);
    $('grid').replaceChildren();
    return;
  }
  if (needPassword) {
    show('auth', false); show('gallery', false); show('admin', false); show('userbar', false); show('setpw', true);
    return;
  }
  show('setpw', false);
  const { data } = await sb.from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
  isAdmin = !!data;
  $('who').textContent = session.user.email + (isAdmin ? ' (admin)' : '');
  show('auth', false); show('userbar', true); show('gallery', true); show('admin', isAdmin);
  $('c-date').valueAsDate = new Date();
  loadComics();
}

// Don't await Supabase calls inside this callback (can deadlock); defer instead.
sb.auth.onAuthStateChange((_event, session) => setTimeout(() => render(session), 0));
