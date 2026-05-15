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

async function getProducts() {
  try {
    const response = await shopify.get('/products.json?limit=10');
    const products = response.data.products;
    console.log(`\n✅ Connected! Found ${products.length} products:\n`);
    products.forEach(p => {
      console.log(`- ${p.title}`);
    });
  } catch (error) {
    console.error('Connection failed:', error.response?.status, error.message);
  }
}

getProducts();