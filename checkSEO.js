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

async function checkSEOFields() {
  const response = await shopify.get('/products.json?limit=1');
  const product = response.data.products[0];
  
  console.log('Product ID:', product.id);
  console.log('Title:', product.title);
  console.log('\nSEO fields on product:');
  console.log('metafields_global_title_tag:', product.metafields_global_title_tag);
  console.log('metafields_global_description_tag:', product.metafields_global_description_tag);
  
  const metafields = await shopify.get(`/products/${product.id}/metafields.json`);
  console.log('\nAll metafields stored:');
  console.log(JSON.stringify(metafields.data.metafields, null, 2));
}

checkSEOFields();