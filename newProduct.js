require('dotenv').config();

const axios = require('axios');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRODUCT_ID = process.env.NEW_PRODUCT_ID;

// ─── AI Setup ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = 'llama-3.3-70b-versatile';

let geminiExhausted = false;
let groqExhausted = false;

// ─── Shopify Client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Gemini Generator ─────────────────────────────────────────────────────
async function generateWithGemini(prompt, retries = 3) {
  if (geminiExhausted) return null;
  let backoff = 60000;
  for (let i = 0; i < retries; i++) {
    try {
      const result = await geminiModel.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      const msg = error.message || '';
      if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
        console.log('   🔄 Gemini quota exhausted — switching to Groq...');
        geminiExhausted = true;
        return null;
      }
      if (msg.includes('429')) {
        if (i < retries - 1) { await wait(backoff); backoff = Math.min(backoff * 2, 120000); }
        else { geminiExhausted = true; return null; }
      } else { return null; }
    }
  }
  return null;
}

// ─── Groq Generator ───────────────────────────────────────────────────────
async function generateWithGroq(prompt, retries = 3) {
  if (groqExhausted) return null;
  let backoff = 15000;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500,
        temperature: 0.7
      });
      return response.choices[0].message.content.trim();
    } catch (error) {
      const msg = error.message || '';
      if (msg.includes('401')) { process.exit(1); }
      if (msg.includes('429') || msg.includes('rate_limit')) {
        if (i < retries - 1) { await wait(backoff); backoff = Math.min(backoff * 2, 60000); }
        else { groqExhausted = true; return null; }
      } else { return null; }
    }
  }
  return null;
}

// ─── Smart Generator ──────────────────────────────────────────────────────
async function generate(prompt) {
  if (!geminiExhausted) {
    const result = await generateWithGemini(prompt);
    if (result) return { text: result, engine: 'Gemini' };
  }
  if (!groqExhausted) {
    console.log('   🔄 Using Groq fallback...');
    const result = await generateWithGroq(prompt);
    if (result) return { text: result, engine: 'Groq' };
  }
  return null;
}

// ─── SEO Generators ───────────────────────────────────────────────────────
async function generateH1Title(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 300) || '';
  return await generate(`Generate an H1 product title following this EXACT pattern:
[Full Product Name] – [Key Material or Feature] [Size/Quantity if applicable]

Product: ${product.title}
Existing description: ${desc}

Rules:
- Between 50-70 characters
- Must include the FULL product name — never shorten or abbreviate
- Must add key material or standout feature after a dash
- Add size/quantity/set info at the end if available
- No quotes, no punctuation at end
- Return ONLY the H1 title, nothing else

Examples:
1 Million EDT Unisex Perfume – Fresh Spicy Alcohol Scent 100ml
Marvel Iron Man ANC TWS Earbuds – HiFi 13mm Drivers 2-Piece
MOLLE Tactical Backpack – Waterproof Nylon 30L 45L 80L`);
}

async function generateMetaTitle(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 200) || '';
  return await generate(`Generate a meta title following this EXACT pattern:
[Full Product Name] – [Most Specific Feature with number or spec] | Nova Mart

Product: ${product.title}
Product info: ${desc}

Rules:
- Between 50-60 characters
- Must include the full product name
- Most specific unique feature — use real numbers or specs
- Must end with | Nova Mart
- No quotes
- Never use: quality, best, amazing, perfect
- Return ONLY the meta title, nothing else

Examples:
1 Million EDT Unisex Perfume – Fresh Spicy 100ml | Nova Mart
Marvel Iron Man ANC Earbuds – 13mm HiFi 15H | Nova Mart`);
}

async function generateMetaDescription(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 400) || '';
  return await generate(`Generate an appealing and specific meta description.

Product: ${product.title}
Product details: ${desc}

Rules:
- Between 140-160 characters exactly
- NO quotes anywhere
- Emotional hook that makes customer want to click
- Include 2 specific features with real numbers/specs
- Must end with exactly: Free Delivery at Nova Mart!
- Never use: Experience, Enjoy, Discover, Amazing, Best, Quality, Perfect
- Return ONLY the meta description, nothing else

Examples:
Turn heads with 1 Million EDT — fresh spicy scent that lasts all day. 100ml unisex formula. Free Delivery at Nova Mart!
Block the noise. Own the sound. 13mm HiFi drivers and 15H battery in Marvel Iron Man ANC earbuds. Free Delivery at Nova Mart!`);
}

async function generateBodyHTML(product) {
  const desc = product.body_html?.replace(/<[^>]*>/g, '').slice(0, 500) || '';
  return await generate(`Write a complete product description for Nova Mart Shopify store.

Product: ${product.title}
Existing info: ${desc}

BRAND VOICE: Nova Mart — sophisticated, minimalist, confident.
Short punchy sentences. Never generic. Rewrite uniquely in Nova Mart voice.

Follow this EXACT HTML structure:

<p><em>[ONE punchy 8-12 word sentence. Core benefit. No fluff.]</em></p>

<h2>Key Features</h2>
<ul>
<li><b>[Feature Name]:</b> [Why it matters. Real specs.]</li>
[5-7 bullets total]
</ul>

<h2>Why It Works For You</h2>
<p>[3-4 sentences. Speak to customer directly.]</p>

<h2>What Makes Nova Mart Different</h2>
<p>[2-3 sentences. Free delivery, curated products, trust.]</p>

<h2>Technical Specifications</h2>
<table>
<tr><th>Specification</th><th>Details</th></tr>
[5-8 rows with real specs]
</table>

<h2>Frequently Asked Questions</h2>
<details><summary>[Common question]</summary><p>[Answer 2-3 sentences.]</p></details>
<details><summary>[Usage or compatibility question]</summary><p>[Answer.]</p></details>
<details><summary>[Delivery or returns question]</summary><p>[Mention Nova Mart free delivery.]</p></details>

Rules:
- Minimum 800 words
- Never use: Experience, Enjoy, Amazing, Best, Quality, Perfect
- Return ONLY the HTML, nothing else`);
}

async function generateTags(product) {
  const res = await generate(`Generate SEO tags for this Shopify product.

Product: ${product.title}

Rules:
- 8-10 tags
- Mix broad and specific keywords
- Cover: product type, material, feature, use case, audience, style
- Each tag under 25 characters
- Comma separated, no quotes
- Return ONLY the comma-separated tags, nothing else`);
  if (!res) return null;
  const tags = res.text.split(',').map(t => t.trim()).filter(t => t.length > 0);
  return { text: tags, engine: res.engine };
}

// ─── Metafield Saver ───────────────────────────────────────────────────────
async function saveMetafield(productId, key, value) {
  try {
    const res = await shopify.get(`/products/${productId}/metafields.json`);
    const existing = res.data.metafields.find(m => m.namespace === 'global' && m.key === key);
    if (existing) {
      await shopify.put(`/products/${productId}/metafields/${existing.id}.json`, {
        metafield: { id: existing.id, value, type: 'string' }
      });
    } else {
      await shopify.post(`/products/${productId}/metafields.json`, {
        metafield: { namespace: 'global', key, value, type: 'string' }
      });
    }
  } catch (error) {
    console.error(`   ❌ Metafield error: ${error.message}`);
  }
}

// ─── Main Fix Function ─────────────────────────────────────────────────────
async function fixNewProduct() {
  console.log('\n⚡ Nova Mart — Instant SEO Fix');
  console.log('='.repeat(50));

  if (!PRODUCT_ID) {
    console.log('❌ No product ID provided. Set NEW_PRODUCT_ID env variable.');
    process.exit(1);
  }

  console.log(`\n📦 Fetching product ID: ${PRODUCT_ID}...`);

  try {
    const response = await shopify.get(`/products/${PRODUCT_ID}.json`);
    const product = response.data.product;

    console.log(`✅ Found: "${product.title}"`);
    console.log(`🔗 URL: https://${STORE}/admin/products/${product.id}`);
    console.log('\n🤖 Running SEO patterns...\n');

    const updates = {};

    // 1. H1 Title
    console.log('   [1/5] H1 Title...');
    const h1 = await generateH1Title(product);
    if (h1) {
      updates.title = h1.text;
      console.log(`   ✅ H1 [${h1.engine}]: ${h1.text}`);
    }

    // 2. Meta Title
    console.log('   [2/5] Meta Title...');
    const metaTitle = await generateMetaTitle(product);
    if (metaTitle) {
      await saveMetafield(product.id, 'title_tag', metaTitle.text);
      console.log(`   ✅ Meta Title [${metaTitle.engine}]: ${metaTitle.text}`);
    }

    // 3. Meta Description
    console.log('   [3/5] Meta Description...');
    const metaDesc = await generateMetaDescription(product);
    if (metaDesc) {
      await saveMetafield(product.id, 'description_tag', metaDesc.text);
      console.log(`   ✅ Meta Desc [${metaDesc.engine}]: ${metaDesc.text.length} chars`);
    }

    // 4. Body HTML
    console.log('   [4/5] Body HTML...');
    const body = await generateBodyHTML(product);
    if (body) {
      updates.body_html = body.text;
      console.log(`   ✅ Body HTML [${body.engine}]: ${body.text.length} chars`);
    }

    // 5. Tags
    console.log('   [5/5] Tags...');
    const tags = await generateTags(product);
    if (tags && tags.text.length > 0) {
      updates.tags = tags.text.join(', ');
      console.log(`   ✅ Tags [${tags.engine}]: ${tags.text.join(', ')}`);
    }

    // Save to Shopify
    if (Object.keys(updates).length > 0) {
      await shopify.put(`/products/${product.id}.json`, {
        product: { id: product.id, ...updates }
      });
    }

    console.log('\n' + '='.repeat(50));
    console.log(`⚡ INSTANT SEO FIX COMPLETE!`);
    console.log(`📦 Product: ${product.title}`);
    console.log(`🔗 View: https://${STORE}/admin/products/${product.id}`);
    console.log('='.repeat(50));

  } catch (error) {
    console.error(`❌ Failed: ${error.message}`);
    process.exit(1);
  }
}

fixNewProduct();
