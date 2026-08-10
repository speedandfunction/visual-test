#!/usr/bin/env node
/**
 * list-screenshots.js
 * Lists all screenshot timestamps available in R2.
 *
 * Usage:  node list-screenshots.js
 */

'use strict';

const r2 = require('./r2');

(async () => {
  console.log(`\nBucket: ${r2.BUCKET_NAME}\n`);

  const keys = await r2.listKeys('screenshots/');

  if (keys.length === 0) {
    console.log('No screenshot sets found. Run take-screenshots.js first.');
    return;
  }

  // Extract unique timestamps from keys like "screenshots/2026-08-07_16-51-03/index.png"
  const timestamps = [...new Set(
    keys.map(k => k.split('/')[1]).filter(Boolean)
  )].sort();

  console.log('Available screenshot timestamps:\n');
  for (const ts of timestamps) {
    const count = keys.filter(k => k.startsWith(`screenshots/${ts}/`)).length;
    console.log(`  ${ts}  (${count} pages)`);
  }

  if (timestamps.length >= 2) {
    console.log(`\nExample comparison:`);
    console.log(`  node compare-screenshots.js ${timestamps[0]} ${timestamps[timestamps.length - 1]}`);
  }
})();
