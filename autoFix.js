require('dotenv').config();
const axios = require('axios');
const Groq = require('groq-sdk');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function generateWithGroq(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.7
      });
      return response.choices[0].message.content.trim();
    } catch (error) {
      if (error.message.includes('429') || error.message.includes('rate')) {
        console.log(`   ⏳ Rate limit — waiting 10 seconds...`);
        await wait(10000);
      } else {
        throw error;
      }
    }
  }
  return null;
}

async function generateMetaDescription(product) {
  const prompt = `Write a compelling SEO meta description for this product:
Product name: ${product.title}
Product description: ${product.body_html?.replace(/<[^>]*>/g, '').slice(0, 300) || 'No description'}
Rules:
- Between 140-160 characters exactly
- Include product name naturally
- Focus on benefits and features
- No quotes or special characters
- Return ONLY the meta description, nothing else`;

  return await generateWithGroq(prompt);
}

async function generateAltText(productTitle, imageIndex) {
  const prompt = `Write SEO alt text for product image ${imageIndex + 1} of: ${productTitle}
Rules:
- Under 125 characters
- Descriptive and natural
- Include product name
- No quotes
- Return ONLY the alt text, nothing else`;

  return await generateWithGroq(prompt);
}

async function fixProduct(product) {
  console.log(`\n🔧 Fixing: ${product.title}`);
  const fixes = {};

  try {
    // Fix meta description
    const metaDesc = product.metafields_global_description_tag;
    if (!metaDesc || metaDesc.length < 100) {
      console.log('   Generating meta description...');
      const newDesc = await generateMetaDescription(product);
      if (newDesc) {
        fixes.metafields_global_description_tag = newDesc;
        console.log(`   ✅ Meta: ${newDesc.slice(0, 60)}...`);
      }
      await wait(2000);
    }

    // Fix image alt texts
    if (product.images && product.images.length > 0) {
      for (let i = 0; i < product.images.length; i++) {
        const img = product.images[i];
        if (!img.alt || img.alt.trim() === '') {
          console.log(`   Generating alt text for image ${i + 1}...`);
          const altText = await generateAltText(product.title, i);
          if (altText) {
            await shopify.put(`/products/${product.id}/images/${img.id}.json`, {
              image: { id: img.id, alt: altText }
            });
            console.log(`   ✅ Alt text saved for image ${i + 1}`);
          }
          await wait(2000);
        }
      }
    }

    // Save fixes to Shopify
    if (Object.keys(fixes).length > 0) {
      await shopify.put(`/products/${product.id}.json`, {
        product: { id: product.id, ...fixes }
      });
      console.log(`   ✅ Saved to Shopify`);
    }

  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
  }
}

async function getAllProducts() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,handle,body_html,images,metafields_global_title_tag,metafields_global_description_tag';

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
  return products;
}

// Ping Google after fixes
async function pingGoogle() {
  try {
    await axios.get('https://www.google.com/ping?sitemap=https://mynovamart.store/sitemap.xml');
    console.log('\n📡 Google pinged — sitemap resubmitted');
  } catch (error) {
    console.log('\n📡 Google ping sent');
  }
}

async function runAutoFix() {
  console.log('\n🚀 Starting SEO Auto-Fix with Groq AI...\n');

  try {
    const products = await getAllProducts();
    const toFix = products.filter(p =>
      !p.metafields_global_description_tag ||
      p.metafields_global_description_tag.length < 100 ||
      p.images?.some(img => !img.alt || img.alt.trim() === '')
    );

    console.log(`Found ${products.length} total products`);
    console.log(`${toFix.length} products need fixing\n`);

    let fixed = 0;
    for (const product of toFix) {
      await fixProduct(product);
      fixed++;
      console.log(`   Progress: ${fixed}/${toFix.length}`);
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ AUTO-FIX COMPLETE');
    console.log('='.repeat(50));
    console.log(`Products fixed: ${fixed}`);
    console.log(`Total processed: ${products.length}`);

    // Ping Google after all fixes
    await pingGoogle();

  } catch (error) {
    console.error('Auto-fix failed:', error.message);
  }
}

runAutoFix();