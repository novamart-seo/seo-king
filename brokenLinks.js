/**
 * brokenLinks.js
 * Checks all product, collection, and page URLs for Nova Mart.
 *
 * FIXES OVER PREVIOUS VERSION:
 *  - Smart collections included (was missing before)
 *  - maxRedirects: 0 so 301/302 are actually detected (not silently followed)
 *  - Concurrency — checks 5 URLs at a time (was fully sequential)
 *  - Results saved to broken-links-report.json for GitHub Actions artifacts
 *  - Error types categorised: 404, redirect, timeout, other
 *  - Active products only (status=active)
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');

const STORE    = process.env.SHOPIFY_STORE;
const TOKEN    = process.env.SHOPIFY_ACCESS_TOKEN;
const SITE_URL = 'https://mynovamart.store';

const CONCURRENCY  = 5;
const TIMEOUT_MS   = 10000;
const DELAY_MS     = 200;   // between batches
const REPORT_FILE  = './broken-links-report.json';

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
// CONCURRENCY LIMITER
// ══════════════════════════════════════════════════════════════════════════

class ConcurrencyLimit {
  constructor(limit) { this.limit = limit; this.running = 0; this.queue = []; }
  async run(fn) {
    if (this.running >= this.limit)
      await new Promise(r => this.queue.push(r));
    this.running++;
    try { return await fn(); }
    finally {
      this.running--;
      if (this.queue.length > 0) this.queue.shift()();
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// URL CHECKER
// ══════════════════════════════════════════════════════════════════════════

async function checkURL(item, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(item.url, {
        timeout: TIMEOUT_MS,
        maxRedirects: 0,          // Don't follow — detect 301/302 directly
        validateStatus: s => s < 400 || s === 301 || s === 302,  // don't throw on redirects
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-King-Bot/1.0)' }
      });

      const status = response.status;

      if (status === 301 || status === 302) {
        const location = response.headers['location'] || '';
        return { ...item, status, type: 'redirect', location };
      }

      return { ...item, status, type: 'ok' };

    } catch (error) {
      const status = error.response?.status || 0;

      // 404 is definitive — no retry needed
      if (status === 404) return { ...item, status, type: 'broken' };

      // Timeout or network error — retry once
      if (i < retries - 1) { await wait(2000); continue; }

      const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
      return {
        ...item,
        status,
        type:  isTimeout ? 'timeout' : 'error',
        error: error.message,
      };
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// URL FETCHERS
// ══════════════════════════════════════════════════════════════════════════

async function getProductURLs() {
  const products = [];
  let url = '/products.json?limit=250&status=active&fields=id,title,handle';
  while (url) {
    const res  = await shopify.get(url);
    products.push(...res.data.products);
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
  }
  return products.map(p => ({ type: 'product', title: p.title, url: `${SITE_URL}/products/${p.handle}` }));
}

async function getCollectionURLs() {
  const collections = [];

  // Custom collections
  let url = '/custom_collections.json?limit=250&fields=id,title,handle';
  while (url) {
    const res = await shopify.get(url);
    collections.push(...res.data.custom_collections.map(c => ({ ...c, _kind: 'custom' })));
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
  }

  // Smart collections (was missing before)
  url = '/smart_collections.json?limit=250&fields=id,title,handle';
  while (url) {
    const res = await shopify.get(url);
    collections.push(...res.data.smart_collections.map(c => ({ ...c, _kind: 'smart' })));
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
  }

  return collections.map(c => ({
    type: 'collection',
    title: c.title,
    url: `${SITE_URL}/collections/${c.handle}`,
  }));
}

async function getPageURLs() {
  const res   = await shopify.get('/pages.json?limit=250&fields=id,title,handle');
  const pages = res.data.pages;
  return pages.map(p => ({ type: 'page', title: p.title, url: `${SITE_URL}/pages/${p.handle}` }));
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════

async function runBrokenLinkChecker() {
  console.log('\n🔍 Nova Mart — Broken Link Checker');
  console.log('='.repeat(55));

  console.log('\nGathering all URLs...');
  const [productURLs, collectionURLs, pageURLs] = await Promise.all([
    getProductURLs(),
    getCollectionURLs(),
    getPageURLs(),
  ]);

  const allURLs = [...productURLs, ...collectionURLs, ...pageURLs];

  console.log(`📦 Products    : ${productURLs.length}`);
  console.log(`🗂️  Collections : ${collectionURLs.length}`);
  console.log(`📄 Pages       : ${pageURLs.length}`);
  console.log(`🔗 Total       : ${allURLs.length}\n`);
  console.log('='.repeat(55));

  const results  = { ok: [], broken: [], redirects: [], timeouts: [], errors: [] };
  const limiter  = new ConcurrencyLimit(CONCURRENCY);
  let checked    = 0;

  // Process in batches with concurrency
  const checks = allURLs.map(item =>
    limiter.run(async () => {
      const result = await checkURL(item);
      checked++;

      const prefix = `[${checked}/${allURLs.length}]`;
      if (result.type === 'ok') {
        console.log(`${prefix} ✅ ${result.status} — ${result.title}`);
        results.ok.push(result);
      } else if (result.type === 'broken') {
        console.log(`${prefix} ❌ 404 — ${result.title}`);
        console.log(`         ${result.url}`);
        results.broken.push(result);
      } else if (result.type === 'redirect') {
        console.log(`${prefix} ↪️  ${result.status} — ${result.title} → ${result.location}`);
        results.redirects.push(result);
      } else if (result.type === 'timeout') {
        console.log(`${prefix} ⏱️  Timeout — ${result.title}`);
        results.timeouts.push(result);
      } else {
        console.log(`${prefix} ⚠️  Error ${result.status} — ${result.title}: ${result.error}`);
        results.errors.push(result);
      }

      await wait(DELAY_MS);
    })
  );

  await Promise.all(checks);

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(55));
  console.log('📊 BROKEN LINK REPORT');
  console.log('='.repeat(55));
  console.log(`✅ Working      : ${results.ok.length}`);
  console.log(`❌ Broken (404) : ${results.broken.length}`);
  console.log(`↪️  Redirects    : ${results.redirects.length}`);
  console.log(`⏱️  Timeouts     : ${results.timeouts.length}`);
  console.log(`⚠️  Other errors : ${results.errors.length}`);

  if (results.broken.length > 0) {
    console.log('\n❌ BROKEN LINKS (404):');
    results.broken.forEach(b => {
      console.log(`\n  [${b.type}] ${b.title}`);
      console.log(`  ${b.url}`);
    });
  } else {
    console.log('\n✅ No broken links found!');
  }

  if (results.redirects.length > 0) {
    console.log('\n↪️  REDIRECTS DETECTED:');
    results.redirects.forEach(r => {
      console.log(`\n  [${r.type}] ${r.title}`);
      console.log(`  From : ${r.url}`);
      console.log(`  To   : ${r.location}`);
    });
  }

  // ── Save report ───────────────────────────────────────────────────────
  const report = {
    date:      new Date().toISOString(),
    summary: {
      total:     allURLs.length,
      ok:        results.ok.length,
      broken:    results.broken.length,
      redirects: results.redirects.length,
      timeouts:  results.timeouts.length,
      errors:    results.errors.length,
    },
    broken:    results.broken,
    redirects: results.redirects,
    timeouts:  results.timeouts,
    errors:    results.errors,
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\n📄 Full report saved → ${REPORT_FILE}`);
  console.log('='.repeat(55));
}

runBrokenLinkChecker().catch(err => {
  console.error('❌ brokenLinks crashed:', err.message);
  process.exit(1);
});