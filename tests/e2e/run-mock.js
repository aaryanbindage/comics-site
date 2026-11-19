// Runs the full reader journey from live.js offline: the real page and real supabase-js library,
// talking to tests/e2e/mock-server.js instead of the real project.
//   node tests/e2e/run-mock.js
const path = require('path');
const { spawn } = require('child_process');
const { start } = require('./mock-server');

const srv = start(0, (port) => {
  const child = spawn(process.execPath, [path.join(__dirname, process.env.LIVE_FILE || 'live.js')], {
    stdio: 'inherit',
    env: { ...process.env, SITE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_KEY: 'mock-service-key', E2E_MOCK: '1' },
  });
  child.on('exit', (code) => { srv.close(); process.exit(code); });
});
