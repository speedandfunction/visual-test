#!/usr/bin/env node
/**
 * fetch-sitemap.js
 * Fetches all page URLs from the sitemap index and saves them
 * to ./sitemap.txt (one URL per line).
 *
 * Usage:  node fetch-sitemap.js
 */

'use strict';

require('dotenv').config();

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const SITEMAP_INDEX = process.env.SITEMAP_INDEX;
if (!SITEMAP_INDEX) {
  console.error('Error: SITEMAP_INDEX must be set in .env');
  process.exit(1);
}

const BASIC_AUTH = (process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS)
  ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASS }
  : null;
const OUT_FILE      = path.join(__dirname, 'sitemap.txt');
const TIMEOUT_MS    = 15_000;

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'VisualTestBot/1.0 (visual-regression-test)' };
    if (BASIC_AUTH) {
      const creds = Buffer.from(`${BASIC_AUTH.username}:${BASIC_AUTH.password}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
    }
    const req = client.get(
      url,
      { headers, timeout: TIMEOUT_MS },
      res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          return fetchRaw(loc).then(resolve).catch(reject);
        }
        let body = '';
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractLocs(xml) {
  const urls = [];
  for (const m of xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gs)) {
    urls.push(m[1].trim());
  }
  return urls;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nFetching sitemap index: ${SITEMAP_INDEX}\n`);

  const indexRes = await fetchRaw(SITEMAP_INDEX);
  if (indexRes.status !== 200) {
    console.error(`Error: sitemap index returned HTTP ${indexRes.status}`);
    process.exit(1);
  }

  const isSitemapIndex = indexRes.body.includes('<sitemapindex');
  const isUrlset       = indexRes.body.includes('<urlset');

  if (!isSitemapIndex && !isUrlset) {
    console.error('Error: response does not look like a valid sitemap');
    process.exit(1);
  }

  let allUrls = [];

  if (isSitemapIndex) {
    const childSitemaps = extractLocs(indexRes.body);
    console.log(`Found ${childSitemaps.length} child sitemaps. Fetching each…\n`);

    for (const childUrl of childSitemaps) {
      process.stdout.write(`  ${childUrl} … `);
      try {
        const res = await fetchRaw(childUrl);
        if (res.status !== 200) {
          console.log(`⚠ HTTP ${res.status}`);
          continue;
        }
        const urls = extractLocs(res.body);
        allUrls.push(...urls);
        console.log(`✓ ${urls.length} URLs`);
      } catch (e) {
        console.log(`✗ ${e.message}`);
      }
    }
  } else {
    allUrls = extractLocs(indexRes.body);
  }

  // Deduplicate and sort
  allUrls = [...new Set(allUrls)].sort();

  fs.writeFileSync(OUT_FILE, allUrls.join('\n') + '\n', 'utf8');
  console.log(`\n✅ ${allUrls.length} unique URLs saved to sitemap.txt`);
})();
