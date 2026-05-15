require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

const API_KEY = process.env.SHOPIFY_API_KEY;
const API_SECRET = process.env.SHOPIFY_API_SECRET;
const STORE = process.env.SHOPIFY_STORE;
const SCOPES = 'read_products,write_products,read_content,write_content,read_files,write_files,read_themes,write_themes';
const REDIRECT_URI = 'http://localhost:3000/auth/callback';

app.get('/', (req, res) => {
  const authUrl = `https://${STORE}/admin/oauth/authorize?client_id=${API_KEY}&scope=${SCOPES}&redirect_uri=${REDIRECT_URI}&grant_options[]=value`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  console.log('Code received:', code);
  try {
    const response = await axios.post(
      `https://${STORE}/admin/oauth/access_token`,
      {
        client_id: API_KEY,
        client_secret: API_SECRET,
        code: code
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    const accessToken = response.data.access_token;
    console.log('\n✅ YOUR ACCESS TOKEN:');
    console.log(accessToken);
    console.log('\nAdd this to your .env file:');
    console.log(`SHOPIFY_ACCESS_TOKEN=${accessToken}`);
    res.send(`
      <h1>Success!</h1>
      <p>Your access token is:</p>
      <h2>${accessToken}</h2>
      <p>Copy it and paste in your .env file</p>
    `);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    res.send(`Error: ${JSON.stringify(error.response?.data || error.message)}`);
  }
});

app.listen(3000, () => {
  console.log('Server running — open http://localhost:3000');
});