'use strict';
/**
 * Minimal .env loader, shared by server.js and the test runner (it used to be
 * copy-pasted into each). A real environment variable always wins over the file:
 * in the fleet the secrets come from infra, and a stale committed .env quietly
 * overriding them would be a miserable thing to debug.
 */

const fs = require('fs');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

module.exports = { loadEnvFile };
