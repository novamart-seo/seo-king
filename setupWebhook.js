require('dotenv').config();
const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const RAILWAY_URL = 'https://seo-king-production.up.railway.app';

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

async function setupWebhooks() {
  console.log('\n🔔 Setting up Shopify Webhooks...\n');

  const webhooks = [
    {
      topic: 'products/create',
      address: `${RAILWAY_URL}/webhook/product-created`,
      description: 'New product created — trigger instant SEO fix'
    },
    {
      topic: 'products/update',
      address: `${RAILWAY_URL}/webhook/product-created`,
      description: 'Product updated — check and fix SEO'
    }
  ];

  for (const webhook of webhooks) {
    try {
      const response = await shopify.post('/webhooks.json', {
        webhook: {
          topic: webhook.topic,
          address: webhook.address,
          format: 'json'
        }
      });
      console.log(`✅ Webhook created: ${webhook.topic}`);
      console.log(`   URL: ${webhook.address}`);
      console.log(`   ID: ${response.data.webhook.id}\n`);
    } catch (error) {
      if (error.response?.data?.errors?.address?.includes('taken')) {
        console.log(`⚠️ Webhook already exists: ${webhook.topic}`);
      } else {
        console.error(`❌ Failed: ${webhook.topic}`, error.response?.data || error.message);
      }
    }
  }

  // List all webhooks
  console.log('\n📋 All registered webhooks:');
  const list = await shopify.get('/webhooks.json');
  list.data.webhooks.forEach(w => {
    console.log(`  - ${w.topic} → ${w.address}`);
  });

  console.log('\n✅ Webhook setup complete!');
  console.log('New products will now be instantly SEO optimized!');
}

setupWebhooks();