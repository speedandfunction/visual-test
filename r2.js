/**
 * r2.js
 * Cloudflare R2 client using the Cloudflare REST API (Bearer token auth).
 * No AWS SDK needed — works with a Cloudflare API token that has R2 permissions.
 *
 * Bucket layout:
 *   screenshots/<timestamp>/<filename>.png   ← screenshot sets
 *   diffs/<before>_vs_<after>/<filename>.png ← pixel-diff images
 */

'use strict';

require('dotenv').config();

const fetch = require('node-fetch');

// ── Credentials (loaded from .env) ────────────────────────────────────────────
const ACCOUNT_ID  = process.env.CF_ACCOUNT_ID;
const API_TOKEN   = process.env.CF_API_TOKEN;
const BUCKET_NAME = process.env.R2_BUCKET;

if (!ACCOUNT_ID || !API_TOKEN || !BUCKET_NAME) {
  console.error('Error: CF_ACCOUNT_ID, CF_API_TOKEN, and R2_BUCKET must be set in .env');
  process.exit(1);
}

const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2`;

const AUTH = { Authorization: `Bearer ${API_TOKEN}` };

// ── Bucket setup ──────────────────────────────────────────────────────────────

/** Create the bucket if it doesn't already exist. */
async function ensureBucket() {
  // Check if it exists
  const check = await fetch(`${BASE}/buckets/${BUCKET_NAME}`, { headers: AUTH });
  if (check.ok) return; // Already exists

  // Create it
  const res = await fetch(`${BASE}/buckets`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BUCKET_NAME }),
  });

  if (!res.ok) {
    const body = await res.text();
    // 409 = already exists (race condition) — that's fine
    if (res.status !== 409) {
      throw new Error(`Failed to create R2 bucket "${BUCKET_NAME}": ${res.status} ${body}`);
    }
  } else {
    console.log(`  ✓ Created R2 bucket: ${BUCKET_NAME}`);
  }
}

// ── Object operations ─────────────────────────────────────────────────────────

/**
 * Upload a Buffer to R2.
 * @param {string} key       e.g. "screenshots/2026-08-07_10-00-00/index.png"
 * @param {Buffer} buffer
 * @param {string} contentType
 */
async function upload(key, buffer, contentType = 'image/png') {
  const res = await fetch(`${BASE}/buckets/${BUCKET_NAME}/objects/${key}`, {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': contentType },
    body: buffer,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`R2 upload failed for "${key}": ${res.status} ${body}`);
  }
}

/**
 * Download an object from R2 as a Buffer, with automatic retry on transient errors.
 * @param {string} key
 * @param {number} retries
 * @returns {Promise<Buffer>}
 */
async function download(key, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${BASE}/buckets/${BUCKET_NAME}/objects/${key}`, {
      headers: AUTH,
    });

    if (res.ok) return Buffer.from(await res.arrayBuffer());

    // Transient Cloudflare / server errors — retry with backoff
    const transient = [429, 500, 502, 503, 504, 523, 524];
    if (transient.includes(res.status) && attempt < retries) {
      const wait = attempt * 2000; // 2s, 4s, 6s
      process.stderr.write(` [${res.status}, retry ${attempt}/${retries - 1} in ${wait / 1000}s]`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    throw new Error(`R2 download failed for "${key}": ${res.status}`);
  }
}

/**
 * List objects in R2 with an optional prefix.
 * Returns an array of key strings.
 * @param {string} prefix  e.g. "screenshots/2026-08-07_10-00-00/"
 * @returns {Promise<string[]>}
 */
async function listKeys(prefix = '') {
  const keys = [];
  let cursor = null;

  do {
    const url = new URL(`${BASE}/buckets/${BUCKET_NAME}/objects`);
    if (prefix) url.searchParams.set('prefix', prefix);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), { headers: AUTH });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`R2 list failed (prefix="${prefix}"): ${res.status} ${body}`);
    }

    const data = await res.json();
    if (!data.success) throw new Error(`R2 list error: ${JSON.stringify(data.errors)}`);

    // result is a flat array of objects
    const objects = Array.isArray(data.result) ? data.result : (data.result.objects || []);
    for (const obj of objects) {
      keys.push(obj.key);
    }

    // pagination: cursor lives in result_info or result metadata
    const info = data.result_info || {};
    cursor = info.cursor || null;
  } while (cursor);

  return keys;
}

/**
 * List unique top-level "folders" under a prefix (simulated with delimiter=/).
 * e.g. listPrefixes('screenshots/') → ['screenshots/2026-08-07_10-00-00/', ...]
 * @param {string} prefix
 * @returns {Promise<string[]>}
 */
async function listPrefixes(prefix = '') {
  const url = new URL(`${BASE}/buckets/${BUCKET_NAME}/objects`);
  if (prefix) url.searchParams.set('prefix', prefix);
  url.searchParams.set('delimiter', '/');

  const res = await fetch(url.toString(), { headers: AUTH });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`R2 list prefixes failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  if (!data.success) throw new Error(`R2 list error: ${JSON.stringify(data.errors)}`);

  return data.result.delimitedPrefixes || [];
}

/**
 * Delete a single object from R2.
 * @param {string} key
 */
async function deleteObject(key) {
  const res = await fetch(`${BASE}/buckets/${BUCKET_NAME}/objects/${key}`, {
    method: 'DELETE',
    headers: AUTH,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`R2 delete failed for "${key}": ${res.status} ${body}`);
  }
}

/**
 * List ALL objects in the bucket with their sizes.
 * Returns array of { key, size }.
 */
async function listAll() {
  const items = [];
  let cursor = null;

  do {
    const url = new URL(`${BASE}/buckets/${BUCKET_NAME}/objects`);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), { headers: AUTH });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`R2 list failed: ${res.status} ${body}`);
    }

    const data = await res.json();
    if (!data.success) throw new Error(`R2 list error: ${JSON.stringify(data.errors)}`);

    const objects = Array.isArray(data.result) ? data.result : (data.result.objects || []);
    for (const obj of objects) {
      items.push({ key: obj.key, size: obj.size || 0 });
    }

    const info = data.result_info || {};
    cursor = info.cursor || null;
  } while (cursor);

  return items;
}

module.exports = { ensureBucket, upload, download, listKeys, listPrefixes, deleteObject, listAll, BUCKET_NAME };
