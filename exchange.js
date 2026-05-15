require('dotenv').config();
const axios = require('axios');

async function getToken() {
  try {
    const response = await axios.post(
      'https://ajkjky-cz.myshopify.com/admin/oauth/access_token',
      {
        client_id: '9aea0a3783db786ac2797c45f85d895a',
        client_secret: process.env.SHOPIFY_API_SECRET,
        code: '442e843a9a791ecf2df0a9aa730315a8'
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log('\n✅ YOUR ACCESS TOKEN:');
    console.log(response.data.access_token);
    console.log('\nAdd this to your .env file:');
    console.log(`SHOPIFY_ACCESS_TOKEN=${response.data.access_token}`);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

getToken();