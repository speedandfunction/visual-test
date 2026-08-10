#!/usr/bin/env node
/**
 * delete-set.js
 * Deletes a screenshot set and all its associated diff/report files from R2.
 *
 * Usage:
 *   node delete-set.js <timestamp>          # preview what would be deleted
 *   node delete-set.js <timestamp> --confirm  # actually delete
 *
 * Example:
 *   node delete-set.js 2026-08-07_16-51-03
 *   node delete-set.js 2026-08-07_16-51-03 --confirm
 */

'use strict';

const r2 = require('./r2');

const ts      = process.argv[2];
const confirm = process.argv.includes('--confirm');

if (!ts) {
  console.error('Usage: node delete-set.js <timestamp> [--confirm]');
  console.error('Run "node list-screenshots.js" to see available timestamps.');
  process.exit(1);
}

(async () => {
  console.log(`\nBucket: ${r2.BUCKET_NAME}`);
  console.log(`Timestamp: ${ts}\n`);

  // Collect all keys to delete
  process.stdout.write('Scanning R2… ');
  const all = await r2.listAll();

  const toDelete = all
    .map(o => o.key)
    .filter(k =>
      k.startsWith(`screenshots/${ts}/`) ||      // the screenshot set itself
      k.startsWith(`diffs/${ts}_vs_`) ||          // diffs where this is "before"
      k.includes(`_vs_${ts}/`) ||                 // diffs where this is "after"
      k.startsWith(`reports/${ts}_vs_`) ||        // reports where this is "before"
      k.includes(`_vs_${ts}/reports/`) ||         // (alternate nesting)
      k.startsWith(`reports/`) && k.includes(ts)  // reports mentioning this ts
    );

  console.log(`${toDelete.length} objects to delete\n`);

  if (toDelete.length === 0) {
    console.log('Nothing found for that timestamp.');
    return;
  }

  // Group for display
  const screenshots = toDelete.filter(k => k.startsWith('screenshots/'));
  const diffs       = toDelete.filter(k => k.startsWith('diffs/'));
  const reports     = toDelete.filter(k => k.startsWith('reports/'));

  if (screenshots.length) console.log(`  📸 ${screenshots.length} screenshot files  (screenshots/${ts}/)`);
  if (diffs.length)       console.log(`  🔴 ${diffs.length} diff files`);
  if (reports.length)     console.log(`  📄 ${reports.length} report files`);

  if (!confirm) {
    console.log('\nThis is a preview. Add --confirm to actually delete:\n');
    console.log(`  node delete-set.js ${ts} --confirm\n`);
    return;
  }

  // Delete
  console.log('\nDeleting…');
  let done = 0;
  for (const key of toDelete) {
    await r2.deleteObject(key);
    done++;
    if (done % 50 === 0 || done === toDelete.length) {
      process.stdout.write(`\r  ${done}/${toDelete.length} deleted`);
    }
  }

  console.log(`\n\n✅ Deleted ${toDelete.length} objects.`);
})();
