/**
 * pollAndFix.js
 * Runs every 30 mins via GitHub Actions.
 * Fetches products created in the last 35 mins (5 min overlap buffer).
 * Calls applyPatterns() from seoPatterns.js on each new product.
 */

require('dotenv').config();

const axios = require('axios');
const { applyPatterns } = require('./seoPatterns');

const STORE = (process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '')
  .replace('https://', '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
});

// ─── Fetch products created in last N minutes ─────────────────────────────
async function fetchRecentProducts(minutesAgo = 35) {
  const since = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  console.log(`🔎 Checking products created since: ${since}`);

  const { data } = await shopify.get('/products.json', {
    params: {
      created_at_min: since,
      limit:          250,
      status:         'active',
      fields:         'id,title,handle,body_html,tags,images,variants,product_type,created_at',
    },
  });

  return data.products || [];
}

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 pollAndFix started —', new Date().toISOString());

  // 1. Fetch new products
  let products;
  try {
    products = await fetchRecentProducts(35);
  } catch (err) {
    console.error('❌ Failed to fetch products:', err.message);
    process.exit(1);
  }

  if (products.length === 0) {
    console.log('✅ No new products found. Nothing to fix.');
    return;
  }

  console.log(`\n📦 ${products.length} new product(s) found:`);
  products.forEach(p => console.log(`   → [${p.id}] ${p.title}  (${p.created_at})`));

  // 2. Fix each product sequentially (safer for Shopify rate limits)
  const results = [];
  for (const product of products) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🔧 Fixing: [${product.id}] ${product.title}`);
    try {
      const success = await applyPatterns(product);
      results.push({ product_id: product.id, title: product.title, status: success ? 'success' : 'failed' });
    } catch (err) {
      console.error(`❌ Failed [${product.id}]: ${err.message}`);
      results.push({ product_id: product.id, title: product.title, status: 'failed', error: err.message });
    }
  }

  // 3. Summary
  const succeeded = results.filter(r => r.status === 'success').length;
  const failed    = results.filter(r => r.status === 'failed').length;

  console.log(`\n${'═'.repeat(50)}`);
  console.log('📊 SUMMARY');
  console.log(`   ✅ Fixed  : ${succeeded}/${products.length}`);
  console.log(`   ❌ Failed : ${failed}/${products.length}`);
  console.log(`   🕐 Ran at : ${new Date().toISOString()}`);

  if (failed > 0) {
    results.filter(r => r.status === 'failed')
           .forEach(r => console.log(`   → [${r.product_id}] ${r.title}: ${r.error || 'AI generation failed'}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ pollAndFix crashed:', err.message);
  process.exit(1);
});