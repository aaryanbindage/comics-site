// Render build step: writes config.js from environment variables.
// The anon key is designed to be public; access is enforced by Row Level Security.
const fs = require('fs');
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.');
  process.exit(1);
}
fs.writeFileSync(
  'config.js',
  `window.SUPABASE_URL = ${JSON.stringify(url)};\nwindow.SUPABASE_ANON_KEY = ${JSON.stringify(key)};\n`
);
console.log('config.js written');
