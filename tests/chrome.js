// Shared by the test scripts: find a Chrome/Edge to run headless.
const fs = require('fs'), path = require('path');

exports.findChrome = function findChrome() {
  const c = [process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];
  const found = c.find((p) => p && fs.existsSync(p));
  if (!found) throw new Error('Chrome/Edge not found; set CHROME_PATH');
  return found;
};
