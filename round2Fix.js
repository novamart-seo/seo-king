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

// Fix URL handle — shorten to under 50 chars
function fixHandle(handle, title) {
  if (handle.length <= 50) return null;
  const shortened = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-$/g, '');
  return shortened;
}

// Generate better meta title
async function generateMetaTitle(product) {
  const prompt = `Write a concise SEO meta title for this product:
Product name: ${product.title}
Rules:
- Between 50-60 characters exactly
- Include main keyword naturally
- No quotes or special characters
- Make it compelling and clickable
- Return ONLY the meta title, nothing else`;

  return await generateWithGroq(prompt);
}

// Generate meta description
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

async function fixProduct(product) {
  console.log(`\n🔧 Fixing: ${product.title}`);
  const fixes = {};
  let hasChanges = false;

  try {
    // Fix meta title
    const metaTitle = product.metafields_global_title_tag || product.title || '';
    if (metaTitle.length > 60 || metaTitle.length < 30) {
      console.log(`   Fixing meta title (${metaTitle.length} chars)...`);
      const newTitle = await generateMetaTitle(product);
      if (newTitle) {
        fixes.metafields_global_title_tag = newTitle;
        console.log(`   ✅ New title: ${newTitle}`);
        hasChanges = true;
      }
      await wait(2000);
    }

    // Fix missing meta description
    const metaDesc = product.metafields_global_description_tag || '';
    if (!metaDesc || metaDesc.length < 100) {
      console.log(`   Fixing meta description...`);
      const newDesc = await generateMetaDescription(product);
      if (newDesc) {
        fixes.metafields_global_description_tag = newDesc;
        console.log(`   ✅ New description: ${newDesc.slice(0, 60)}...`);
        hasChanges = true;
      }
      await wait(2000);
    }

    // Fix URL handle
    const newHandle = fixHandle(product.handle, product.title);
    if (newHandle && newHandle !== product.handle) {
      fixes.handle = newHandle;
      console.log(`   ✅ New handle: ${newHandle}`);
      hasChanges = true;
    }

    // Save all fixes to Shopify
    if (hasChanges) {
      await shopify.put(`/products/${product.id}.json`, {
        product: { id: product.id, ...fixes }
      });
      console.log(`   ✅ Saved to Shopify`);
    } else {
      console.log(`   ⏭️ No fixes needed`);
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

async function runRound2() {
  console.log('\n🚀 Starting Round 2 SEO Fix for Nova Mart...\n');

  try {
    const products = await getAllProducts();

    const toFix = products.filter(p => {
      const metaTitle = p.metafields_global_title_tag || p.title || '';
      const metaDesc = p.metafields_global_description_tag || '';
      const handleTooLong = p.handle && p.handle.length > 50;
      const titleTooLong = metaTitle.length > 60;
      const titleTooShort = metaTitle.length < 30;
      const missingDesc = !metaDesc || metaDesc.length < 100;
      return handleTooLong || titleTooLong || titleTooShort || missingDesc;
    });

    console.log(`Found ${products.length} total products`);
    console.log(`${toFix.length} products need Round 2 fixes\n`);

    let fixed = 0;
    for (const product of toFix) {
      await fixProduct(product);
      fixed++;
      console.log(`   Progress: ${fixed}/${toFix.length}`);
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ ROUND 2 COMPLETE');
    console.log('='.repeat(50));
    console.log(`Products fixed: ${fixed}`);
    console.log(`Total processed: ${products.length}`);

  } catch (error) {
    console.error('Round 2 failed:', error.message);
  }
}

runRound2();