// UI flow tests: serves the site with a fake Supabase and drives it in headless Chrome.
// Run:  node tests/ui/run.js        (exit code 1 if anything fails)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const { findChrome } = require('../chrome');
const root = path.resolve(__dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const srv = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  if (rel === '/') rel = '/index.html';
  const p = path.join(root, rel);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(p);
  if (rel === '/index.html') {
    // Swap the real library for the fake; everything else (CSP included) is the real page.
    const html = body.toString().replace('vendor/supabase-2.45.4.min.js', 'tests/ui/fake-supabase.js');
    if (html === body.toString()) throw new Error('index.html no longer loads vendor/supabase-2.45.4.min.js');
    body = Buffer.from(html);
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  res.end(body);
}).listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${srv.address().port}/tests/ui/runner.html`;
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-ui-'));
  const chrome = spawn(findChrome(), ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${prof}`,
    '--virtual-time-budget=180000', '--dump-dom', url]);
  let out = '';
  chrome.stdout.on('data', (d) => (out += d));
  chrome.on('close', () => {
    srv.close();
    const m = out.match(/<pre id="out">([\s\S]*?)<\/pre>/);
    const text = m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&') : 'NO RESULTS\n' + out.slice(0, 2000);
    console.log(text);
    const pass = (text.match(/^PASS/gm) || []).length, fail = (text.match(/^FAIL/gm) || []).length;
    console.log(`\n${pass} passed, ${fail} failed${/DONE/.test(text) ? '' : ' (runner did not finish)'}`);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
    process.exit(fail || !/DONE/.test(text) ? 1 : 0);
  });
});
