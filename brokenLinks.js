require('dotenv').config();
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SITE_URL = 'https://mynovamart.store';

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Check if a URL is accessible
async function checkURL(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        maxRedirects: 5,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SEO-King-Bot/1.0)'
        }
      });
      return { url, status: response.status, ok: true };
    } catch (error) {
      if (i === retries - 1) {
        return {
          url,
          status: error.response?.status || 0,
          ok: false,
          error: error.message
        };
      }
      await wait(2000);
    }
  }
}

// Get all product URLs
async function getProductURLs() {
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

  return products.map(p => ({
    title: p.title,
    url: `${SITE_URL}/products/${p.handle}`
  }));
}

// Get all collection URLs
async function getCollectionURLs() {
  const response = await shopify.get('/custom_collections.json?limit=250&fields=id,title,handle');
  const collections = response.data.custom_collections;
  return collections.map(c => ({
    title: c.title,
    url: `${SITE_URL}/collections/${c.handle}`
  }));
}

// Get all page URLs
async function getPageURLs() {
  const response = await shopify.get('/pages.json?limit=250&fields=id,title,handle');
  const pages = response.data.pages;
  return pages.map(p => ({
    title: p.title,
    url: `${SITE_URL}/pages/${p.handle}`
  }));
}

// Run broken link checker
async function runBrokenLinkChecker() {
  console.log('\n🔍 Starting Broken Link Checker for Nova Mart...\n');

  try {
    // Gather all URLs
    console.log('Gathering all URLs...');
    const productURLs = await getProductURLs();
    const collectionURLs = await getCollectionURLs();
    const pageURLs = await getPageURLs();

    const allURLs = [
      ...productURLs,
      ...collectionURLs,
      ...pageURLs
    ];

    console.log(`Found ${productURLs.length} products`);
    console.log(`Found ${collectionURLs.length} collections`);
    console.log(`Found ${pageURLs.length} pages`);
    console.log(`Total URLs to check: ${allURLs.length}\n`);
    console.log('='.repeat(50));

    const broken = [];
    const redirected = [];
    const ok = [];

    let checked = 0;
    for (const item of allURLs) {
      const result = await checkURL(item.url);
      checked++;

      if (!result.ok && result.status === 404) {
        broken.push({ ...item, status: result.status });
        console.log(`❌ 404: ${item.title}`);
        console.log(`   ${item.url}`);
      } else if (result.status === 301 || result.status === 302) {
        redirected.push({ ...item, status: result.status });
        console.log(`⚠️ Redirect: ${item.title}`);
      } else if (result.ok) {
        ok.push(item);
        console.log(`✅ OK: ${item.title}`);
      } else {
        console.log(`⚠️ Error ${result.status}: ${item.title}`);
      }

      console.log(`   Progress: ${checked}/${allURLs.length}`);
      await wait(500);
    }

    console.log('\n' + '='.repeat(50));
    console.log('\n📊 BROKEN LINK REPORT');
    console.log('='.repeat(50));
    console.log(`Total URLs checked: ${allURLs.length}`);
    console.log(`✅ Working: ${ok.length}`);
    console.log(`⚠️ Redirects: ${redirected.length}`);
    console.log(`❌ Broken (404): ${broken.length}`);

    if (broken.length > 0) {
      console.log('\n❌ BROKEN LINKS TO FIX:');
      broken.forEach(b => {
        console.log(`\n  Product: ${b.title}`);
        console.log(`  URL: ${b.url}`);
        console.log(`  Status: ${b.status}`);
      });
    } else {
      console.log('\n✅ No broken links found!');
    }

  } catch (error) {
    console.error('Broken link checker failed:', error.message);
  }
}

runBrokenLinkChecker();