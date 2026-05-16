require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'SEO King is running' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.post('/webhook/product-created', (req, res) => {
  console.log('Webhook received:', req.body?.title);
  res.status(200).json({ received: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});