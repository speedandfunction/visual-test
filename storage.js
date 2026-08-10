#!/usr/bin/env node
/**
 * storage.js
 * Shows R2 bucket storage usage broken down by prefix,
 * compared against the Cloudflare free tier limits.
 *
 * Usage:  node storage.js
 */

'use strict';

const r2 = require('./r2');

const FREE_TIER_BYTES = 10 * 1024 ** 3; // 10 GB

function fmt(bytes) {
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB';
  if (bytes >= 1024)      return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function bar(used, total, width = 30) {
  const filled = Math.round((used / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

(async () => {
  console.log(`\nBucket: ${r2.BUCKET_NAME}`);
  process.stdout.write('Listing all objects… ');

  const all = await r2.listAll();
  console.log(`${all.length} objects\n`);

  // Group by top-level prefix
  const groups = {};
  let total = 0;

  for (const { key, size } of all) {
    const prefix = key.split('/')[0];
    groups[prefix] = groups[prefix] || { count: 0, size: 0 };
    groups[prefix].count++;
    groups[prefix].size += size;
    total += size;
  }

  // Print breakdown
  console.log('Storage by prefix:\n');
  for (const [prefix, { count, size }] of Object.entries(groups).sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${prefix.padEnd(14)} ${fmt(size).padStart(10)}   (${count} files)`);
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`  ${'Total'.padEnd(14)} ${fmt(total).padStart(10)}   (${all.length} files)`);
  console.log('');

  const pct = ((total / FREE_TIER_BYTES) * 100).toFixed(1);
  console.log(`  Free tier usage: ${pct}% of 10 GB`);
  console.log(`  ${bar(total, FREE_TIER_BYTES)}  ${fmt(total)} / ${fmt(FREE_TIER_BYTES)}`);
  console.log(`  Remaining: ${fmt(FREE_TIER_BYTES - total)}\n`);
})();
