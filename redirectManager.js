require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const SNAPSHOT_FILE = 'url-snapshot.json';

// Get all current product URLs
async function getCurrentURLs() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,handle';

  while (url) {
    const response = await shopify.get(url);
    products = [...products, ...response.data.products];
    const linkHeader = response.headers['link'];
    if (linkHeader && linkHeader.includes('rel="next"')) {
      const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = match ? match[1].replace(`https://${STORE}/admin/api/2024-01`, '') : null;
    } else {
      url = null;
    }
  }

  const snapshot = {};
  products.forEach(p => {
    snapshot[p.id] = {
      title: p.title,
      handle: p.handle,
      url: `/products/${p.handle}`
    };
  });
  return snapshot;
}

// Save current URLs as snapshot
async function saveSnapshot() {
  console.log('\n📸 Saving URL snapshot...\n');
  const current = await getCurrentURLs();
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(current, null, 2));
  console.log(`✅ Snapshot saved — ${Object.keys(current).length} product URLs recorded`);
  console.log(`📁 Saved to: ${SNAPSHOT_FILE}`);
}

// Create a redirect in Shopify
async function createRedirect(fromPath, toPath) {
  try {
    await shopify.post('/redirects.json', {
      redirect: {
        path: fromPath,
        target: toPath
      }
    });
    console.log(`   ✅ Redirect created: ${fromPath} → ${toPath}`);
    return true;
  } catch (error) {
    if (error.response?.data?.errors?.path?.includes('taken')) {
      console.log(`   ⚠️ Redirect already exists: ${fromPath}`);
    } else {
      console.error(`   ❌ Failed to create redirect: ${error.message}`);
    }
    return false;
  }
}

// Compare snapshots and create redirects for changed URLs
async function checkAndCreateRedirects() {
  console.log('\n🔍 Checking for URL changes...\n');

  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.log('No snapshot found — saving current URLs as baseline first.');
    await saveSnapshot();
    console.log('\nRun this script again after making URL changes to detect and fix them.');
    return;
  }

  const oldSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const currentSnapshot = await getCurrentURLs();

  let changesFound = 0;
  let redirectsCreated = 0;

  for (const [id, current] of Object.entries(currentSnapshot)) {
    const old = oldSnapshot[id];

    if (!old) {
      console.log(`🆕 New product: ${current.title}`);
      continue;
    }

    if (old.handle !== current.handle) {
      changesFound++;
      console.log(`\n🔄 URL changed for: ${current.title}`);
      console.log(`   Old: ${old.url}`);
      console.log(`   New: ${current.url}`);

      const created = await createRedirect(old.url, current.url);
      if (created) redirectsCreated++;
      await wait(500);
    }
  }

  // Check for deleted products
  for (const [id, old] of Object.entries(oldSnapshot)) {
    if (!currentSnapshot[id]) {
      console.log(`\n🗑️ Deleted product: ${old.title}`);
      console.log(`   Old URL: ${old.url} — consider redirecting to a similar product`);
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 REDIRECT REPORT');
  console.log('='.repeat(50));
  console.log(`URL changes detected: ${changesFound}`);
  console.log(`Redirects created: ${redirectsCreated}`);

  if (changesFound === 0) {
    console.log('\n✅ No URL changes detected — all good!');
  }

  // Update snapshot
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentSnapshot, null, 2));
  console.log('\n📸 Snapshot updated for next run');
}

// Show all existing redirects
async function listRedirects() {
  console.log('\n📋 Current redirects in your store:\n');
  const response = await shopify.get('/redirects.json?limit=250');
  const redirects = response.data.redirects;

  if (redirects.length === 0) {
    console.log('No redirects found');
    return;
  }

  redirects.forEach(r => {
    console.log(`  ${r.path} → ${r.target}`);
  });
  console.log(`\nTotal redirects: ${redirects.length}`);
}

// Main
async function run() {
  const arg = process.argv[2];

  if (arg === 'snapshot') {
    await saveSnapshot();
  } else if (arg === 'list') {
    await listRedirects();
  } else {
    await checkAndCreateRedirects();
  }
}

run();