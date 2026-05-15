require('dotenv').config();
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

async function verifySEO() {
  const response = await shopify.get('/products.json?limit=250&fields=id,title');
  const products = response.data.products;

  const target = products.find(p => p.title.includes('MOLLE Tactical'));

  if (!target) {
    console.log('Product not found');
    return;
  }

  const metafields = await shopify.get(`/products/${target.id}/metafields.json`);

  console.log('\n📦 Product:', target.title);
  console.log('='.repeat(50));

  metafields.data.metafields.forEach(m => {
    if (m.namespace === 'global') {
      console.log(`\nField: ${m.key}`);
      console.log(`Value: ${m.value}`);
      console.log(`Created: ${m.created_at}`);
      console.log(`Updated: ${m.updated_at}`);
    }
  });
}

verifySEO();