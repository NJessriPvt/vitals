'use strict';
/**
 * Fail the build on a root-absolute URL in public/.
 *
 * A DEPLOY-ONLY class of bug: the app is served at / locally but under a path
 * prefix in the fleet, and the balancer strips that prefix before proxying. So
 * "/style.css" resolves against the ingress root, works perfectly on a laptop, and
 * 404s in production — shipping an unstyled, scriptless page. Nothing at runtime
 * catches it, so it is caught here.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
// href="/x", src='/x', url(/x), fetch('/x') — but not "//host", not a data: URI.
const PATTERNS = [
  { re: /(?:href|src)\s*=\s*["'](\/(?!\/)[^"']*)["']/g, what: 'attribute' },
  { re: /url\(\s*["']?(\/(?!\/)[^)"']*)["']?\s*\)/g, what: 'css url()' },
  { re: /\b(?:fetch|EventSource)\s*\(\s*["'`](\/(?!\/)[^"'`]*)["'`]/g, what: 'request' },
];

let bad = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(html|css|js)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const { re, what } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        process.stderr.write(
          `${path.relative(process.cwd(), full)}:${line}  root-absolute ${what}: ${m[1]}\n`,
        );
        bad++;
      }
    }
  }
}

walk(ROOT);

if (bad) {
  process.stderr.write(`\n${bad} root-absolute URL(s) in public/. Use a relative path ("./x").\n`);
  process.exit(1);
}
process.stdout.write('check-paths: ok\n');
