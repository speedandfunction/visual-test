#!/usr/bin/env node
/**
 * fetch-sitemap.js
 * Fetches all page URLs from the sitemap index, drops any URL that
 * redirects (3xx), and saves the rest to ./sitemap.txt (one URL per line).
 * Skipped redirects are written to ./sitemap.redirects.txt as
 * "<url> -> <location>" for review.
 *
 * Usage:  node fetch-sitemap.js [--no-redirect-check]
 *
 * Env (optional):
 *   CHECK_CONCURRENCY   parallel URL checks (default 8)
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
const OUT_FILE       = path.join(__dirname, 'sitemap.txt');
const REDIRECTS_FILE = path.join(__dirname, 'sitemap.redirects.txt');
const TIMEOUT_MS     = 15_000;
const CONCURRENCY    = Math.max(1, parseInt(process.env.CHECK_CONCURRENCY, 10) || 8);
const CHECK_REDIRECTS = !process.argv.includes('--no-redirect-check');

const REDIRECT_CODES = [301, 302, 303, 307, 308];

function buildHeaders() {
  const headers = { 'User-Agent': 'VisualTestBot/1.0 (visual-regression-test)' };
  if (BASIC_AUTH) {
    const creds = Buffer.from(`${BASIC_AUTH.username}:${BASIC_AUTH.password}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  }
  return headers;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(
      url,
      { headers: buildHeaders(), timeout: TIMEOUT_MS },
      res => {
        if (REDIRECT_CODES.includes(res.statusCode) && res.headers.location) {
          res.resume();
          const loc = new URL(res.headers.location, url).href;
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

/**
 * Requests a URL WITHOUT following redirects and returns
 * { status, location }. Uses HEAD; falls back to GET if HEAD isn't allowed.
 */
function checkStatus(url, method = 'HEAD') {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.request(
      url,
      { method, headers: buildHeaders(), timeout: TIMEOUT_MS },
      res => {
        res.resume(); // discard body
        if (method === 'HEAD' && [405, 501].includes(res.statusCode)) {
          req.destroy();
          return checkStatus(url, 'GET').then(resolve).catch(reject);
        }
        const location = res.headers.location
          ? new URL(res.headers.location, url).href
          : null;
        resolve({ status: res.statusCode, location });
        if (method === 'GET') req.destroy(); // don't download the page
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function extractLocs(xml) {
  const urls = [];
  for (const m of xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gs)) {
    urls.push(m[1].trim().replace(/&amp;/g, '&'));
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

  // ── Redirect check ──────────────────────────────────────────────────────────
  const redirects = [];
  const errors    = [];

  if (CHECK_REDIRECTS && allUrls.length) {
    console.log(`\nChecking ${allUrls.length} URLs for redirects (concurrency ${CONCURRENCY})…\n`);
    let done = 0;

    const checks = await mapLimit(allUrls, CONCURRENCY, async url => {
      let result;
      try {
        result = await checkStatus(url);
      } catch (e) {
        result = { error: e.message };
      }
      done++;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r  ${done}/${allUrls.length}`);
      }
      return result;
    });
    if (process.stdout.isTTY) process.stdout.write('\n');

    const kept = [];
    allUrls.forEach((url, i) => {
      const r = checks[i];
      if (r.error) {
        errors.push(url);
        console.log(`  ✗ ${url} (${r.error}) — kept`);
        kept.push(url);
      } else if (r.status >= 300 && r.status < 400) {
        redirects.push(`${url} -> ${r.location || '(no Location header)'} [${r.status}]`);
        console.log(`  ↪ ${r.status} ${url} → ${r.location || '?'} — skipped`);
      } else {
        if (r.status >= 400) console.log(`  ⚠ HTTP ${r.status} ${url} — kept`);
        kept.push(url);
      }
    });
    allUrls = kept;

    if (redirects.length) {
      fs.writeFileSync(REDIRECTS_FILE, redirects.join('\n') + '\n', 'utf8');
    } else if (fs.existsSync(REDIRECTS_FILE)) {
      fs.unlinkSync(REDIRECTS_FILE);
    }
  }

  fs.writeFileSync(OUT_FILE, allUrls.join('\n') + '\n', 'utf8');
  console.log(`\n✅ ${allUrls.length} unique URLs saved to sitemap.txt`);
  if (redirects.length) {
    console.log(`↪  ${redirects.length} redirecting URLs skipped (see sitemap.redirects.txt)`);
  }
  if (errors.length) {
    console.log(`⚠  ${errors.length} URLs could not be checked and were kept`);
  }
})();
