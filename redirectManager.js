/**
 * redirectManager.js
 * Tracks URL changes for products, collections, and pages.
 * Auto-creates Shopify redirects when handles change.
 * Redirects deleted products/collections to their parent path.
 *
 * FIXES OVER PREVIOUS VERSION:
 *  - Collections + pages tracked (not just products)
 *  - Active products only (no draft/archived)
 *  - First run saves snapshot AND continues (no wasted nightly run)
 *  - Deleted items auto-redirect to parent (/collections, /pages, /)
 *  - Redirect list is paginated (was capped at 250)
 *  - Results saved to redirect-report.json for GitHub Actions artifacts
 *  - Duplicate redirect check before creating (avoids noisy warnings)
 *
 * Usage:
 *   node redirectManager.js           — check + create redirects (nightly)
 *   node redirectManager.js snapshot  — force save fresh snapshot
 *   node redirectManager.js list      — list all existing redirects
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');

const STORE = (process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '')
  .replace('https://', '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const SNAPSHOT_FILE = './url-snapshot.json';
const REPORT_FILE   = './redirect-report.json';

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
// FETCH ALL URLS
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
  const snapshot = {};
  products.forEach(p => {
    snapshot[`product_${p.id}`] = {
      kind:   'product',
      title:  p.title,
      handle: p.handle,
      url:    `/products/${p.handle}`,
      parent: '/collections/all',
    };
  });
  return snapshot;
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

  // Smart collections
  url = '/smart_collections.json?limit=250&fields=id,title,handle';
  while (url) {
    const res = await shopify.get(url);
    collections.push(...res.data.smart_collections.map(c => ({ ...c, _kind: 'smart' })));
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
  }

  const snapshot = {};
  collections.forEach(c => {
    snapshot[`collection_${c.id}`] = {
      kind:   'collection',
      title:  c.title,
      handle: c.handle,
      url:    `/collections/${c.handle}`,
      parent: '/collections',
    };
  });
  return snapshot;
}

async function getPageURLs() {
  const res   = await shopify.get('/pages.json?limit=250&fields=id,title,handle');
  const pages = res.data.pages;
  const snapshot = {};
  pages.forEach(p => {
    snapshot[`page_${p.id}`] = {
      kind:   'page',
      title:  p.title,
      handle: p.handle,
      url:    `/pages/${p.handle}`,
      parent: '/',
    };
  });
  return snapshot;
}

async function getAllCurrentURLs() {
  const [products, collections, pages] = await Promise.all([
    getProductURLs(),
    getCollectionURLs(),
    getPageURLs(),
  ]);
  return { ...products, ...collections, ...pages };
}

// ══════════════════════════════════════════════════════════════════════════
// REDIRECT HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function getExistingRedirects() {
  const redirects = new Set();
  let url = '/redirects.json?limit=250';
  while (url) {
    const res = await shopify.get(url);
    res.data.redirects.forEach(r => redirects.add(r.path));
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
  }
  return redirects;
}

async function createRedirect(fromPath, toPath, existing) {
  // Skip if redirect already exists
  if (existing.has(fromPath)) {
    console.log(`   ⏭️  Already exists: ${fromPath}`);
    return 'skipped';
  }
  try {
    await shopify.post('/redirects.json', { redirect: { path: fromPath, target: toPath } });
    console.log(`   ✅ Created: ${fromPath} → ${toPath}`);
    existing.add(fromPath); // update local cache
    return 'created';
  } catch (err) {
    console.error(`   ❌ Failed: ${fromPath} — ${err.message}`);
    return 'error';
  }
}

// ══════════════════════════════════════════════════════════════════════════
// SAVE SNAPSHOT
// ══════════════════════════════════════════════════════════════════════════

async function saveSnapshot(current) {
  if (!current) current = await getAllCurrentURLs();
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(current, null, 2));
  const counts = {
    products:    Object.values(current).filter(v => v.kind === 'product').length,
    collections: Object.values(current).filter(v => v.kind === 'collection').length,
    pages:       Object.values(current).filter(v => v.kind === 'page').length,
  };
  console.log(`📸 Snapshot saved — ${counts.products} products | ${counts.collections} collections | ${counts.pages} pages`);
}

// ══════════════════════════════════════════════════════════════════════════
// CHECK + CREATE REDIRECTS
// ══════════════════════════════════════════════════════════════════════════

async function checkAndCreateRedirects() {
  console.log('\n🔍 Checking for URL changes...\n');

  // Fetch current state + existing redirects in parallel
  const [current, existing] = await Promise.all([
    getAllCurrentURLs(),
    getExistingRedirects(),
  ]);

  // First run — no snapshot yet
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.log('📸 No snapshot found — saving baseline and continuing.\n');
    await saveSnapshot(current);
    console.log('\n✅ Baseline saved. No redirects needed on first run.');
    saveReport({ changesFound: 0, redirectsCreated: 0, redirectsSkipped: 0, errors: 0, details: [] });
    return;
  }

  const old = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));

  let changesFound     = 0;
  let redirectsCreated = 0;
  let redirectsSkipped = 0;
  let errors           = 0;
  const details        = [];

  // ── Check for handle changes ──────────────────────────────────────────
  for (const [key, curr] of Object.entries(current)) {
    const prev = old[key];

    if (!prev) {
      console.log(`🆕 New ${curr.kind}: ${curr.title}`);
      continue;
    }

    if (prev.handle !== curr.handle) {
      changesFound++;
      console.log(`\n🔄 ${curr.kind} URL changed: "${curr.title}"`);
      console.log(`   Old: ${prev.url}`);
      console.log(`   New: ${curr.url}`);

      const result = await createRedirect(prev.url, curr.url, existing);
      if (result === 'created')  redirectsCreated++;
      if (result === 'skipped')  redirectsSkipped++;
      if (result === 'error')    errors++;

      details.push({ kind: curr.kind, title: curr.title, from: prev.url, to: curr.url, result });
      await wait(300);
    }
  }

  // ── Check for deleted items → redirect to parent ──────────────────────
  for (const [key, prev] of Object.entries(old)) {
    if (!current[key]) {
      changesFound++;
      console.log(`\n🗑️  Deleted ${prev.kind}: "${prev.title}"`);
      console.log(`   Old URL: ${prev.url}`);
      console.log(`   Redirecting to: ${prev.parent}`);

      const result = await createRedirect(prev.url, prev.parent, existing);
      if (result === 'created')  redirectsCreated++;
      if (result === 'skipped')  redirectsSkipped++;
      if (result === 'error')    errors++;

      details.push({ kind: prev.kind, title: prev.title, from: prev.url, to: prev.parent, result, deleted: true });
      await wait(300);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(55));
  console.log('📊 REDIRECT REPORT');
  console.log('='.repeat(55));
  console.log(`🔄 URL changes detected : ${changesFound}`);
  console.log(`✅ Redirects created    : ${redirectsCreated}`);
  console.log(`⏭️  Already existed      : ${redirectsSkipped}`);
  console.log(`❌ Errors               : ${errors}`);

  if (changesFound === 0) console.log('\n✅ No URL changes detected — all good!');

  // Update snapshot to current state
  await saveSnapshot(current);
  console.log('📸 Snapshot updated for next run');

  saveReport({ changesFound, redirectsCreated, redirectsSkipped, errors, details });
}

// ══════════════════════════════════════════════════════════════════════════
// LIST ALL REDIRECTS
// ══════════════════════════════════════════════════════════════════════════

async function listRedirects() {
  console.log('\n📋 All redirects in your store:\n');
  const all = [];
  let url = '/redirects.json?limit=250';
  while (url) {
    const res = await shopify.get(url);
    all.push(...res.data.redirects);
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
  }

  if (all.length === 0) { console.log('No redirects found.'); return; }
  all.forEach(r => console.log(`  ${r.path} → ${r.target}`));
  console.log(`\nTotal redirects: ${all.length}`);
}

// ══════════════════════════════════════════════════════════════════════════
// REPORT
// ══════════════════════════════════════════════════════════════════════════

function saveReport(data) {
  fs.writeFileSync(REPORT_FILE, JSON.stringify({ date: new Date().toISOString(), ...data }, null, 2));
  console.log(`📄 Report saved → ${REPORT_FILE}`);
}

// ══════════════════════════════════════════════════════════════════════════
// ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════

async function run() {
  console.log('\n🚀 Nova Mart — Redirect Manager');
  console.log('='.repeat(55));

  const arg = process.argv[2];
  if (arg === 'snapshot') {
    await saveSnapshot();
  } else if (arg === 'list') {
    await listRedirects();
  } else {
    await checkAndCreateRedirects();
  }
}

run().catch(err => {
  console.error('❌ redirectManager crashed:', err.message);
  process.exit(1);
});