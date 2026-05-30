/**
 * instantSeoFix.js
 * Core SEO engine — called by pollAndFix.js
 * Uses GEMINI_API_KEY_2 (dedicated key for new products + technical tasks)
 *
 * Flow:
 *   fetchProduct() → buildPrompt() → Gemini (→ Groq fallback)
 *   → pushToShopify() → saveReport()
 *
 * Fixes: title · meta description · slug · description
 *        tags · image alt texts · metafields (SEO title/desc)
 */

require('dotenv').config();
const axios = require('axios');
const Groq  = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs   = require('fs');
const path = require('path');

// ─── Clients (Key 2 — dedicated for new products & technical tasks) ───────
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY_2);
const groq   = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SHOPIFY_STORE_URL    = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const HEADERS              = { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN };

// ─── 1. Fetch product ─────────────────────────────────────────────────────
async function fetchProduct(productId) {
  const { data } = await axios.get(
    `${SHOPIFY_STORE_URL}/admin/api/2024-01/products/${productId}.json`,
    { headers: HEADERS }
  );
  const p = data.product;
  return {
    id:          p.id,
    name:        p.title,
    description: p.body_html?.replace(/<[^>]+>/g, '').trim() || '',
    price:       p.variants?.[0]?.price || '',
    categories:  p.product_type || '',
    tags:        p.tags || '',
    slug:        p.handle,
    images:      p.images?.map(i => ({ id: i.id, src: i.src, alt: i.alt_text || '' })) || [],
  };
}

// ─── 2. Build prompt ──────────────────────────────────────────────────────
function buildPrompt(product) {
  return `
You are an expert eCommerce SEO specialist. Analyze this Shopify product and return a complete instant SEO fix as valid JSON only. No markdown, no explanation, no code fences.

PRODUCT:
- Name        : ${product.name}
- Description : ${product.description || '(empty)'}
- Price       : ${product.price}
- Category    : ${product.categories || '(none)'}
- Tags        : ${product.tags || '(none)'}
- Slug        : ${product.slug}
- Images      : ${product.images.length} total, ${product.images.filter(i => !i.alt).length} missing alt text

Return ONLY this JSON:
{
  "seo_title": "keyword-rich title, 50-60 chars",
  "meta_description": "compelling description 150-160 chars with CTA",
  "focus_keyword": "primary keyword",
  "secondary_keywords": ["kw1", "kw2", "kw3"],
  "optimized_slug": "seo-friendly-slug",
  "optimized_description": "full rewritten description min 150 words with keywords naturally placed",
  "optimized_short_description": "1-2 sentence keyword-first summary",
  "image_alt_texts": ["alt for image 1", "alt for image 2"],
  "suggested_tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "schema_markup": {
    "type": "Product",
    "name": "",
    "description": "",
    "offers": { "price": "${product.price}", "priceCurrency": "USD" }
  },
  "seo_score_before": 0,
  "seo_score_after": 0,
  "issues_fixed": ["issue 1", "issue 2"],
  "recommendations": ["tip 1", "tip 2"]
}
`.trim();
}

// ─── 3. AI calls ──────────────────────────────────────────────────────────
async function callGemini(prompt) {
  const model  = gemini.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  const text   = result.response.text().replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

async function callGroq(prompt) {
  const res  = await groq.chat.completions.create({
    model:    'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
  });
  const text = res.choices[0].message.content.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// ─── 4. Push fixes to Shopify ─────────────────────────────────────────────
async function pushToShopify(productId, seoFix, product) {
  // Core fields
  await axios.put(
    `${SHOPIFY_STORE_URL}/admin/api/2024-01/products/${productId}.json`,
    {
      product: {
        id:        productId,
        title:     seoFix.seo_title,
        body_html: `<p>${seoFix.optimized_description}</p>`,
        handle:    seoFix.optimized_slug,
        tags:      seoFix.suggested_tags.join(', '),
      },
    },
    { headers: HEADERS }
  );

  // SEO metafields (title tag + description tag)
  for (const [key, value] of [
    ['title_tag',       seoFix.seo_title],
    ['description_tag', seoFix.meta_description],
  ]) {
    await axios.post(
      `${SHOPIFY_STORE_URL}/admin/api/2024-01/products/${productId}/metafields.json`,
      { metafield: { namespace: 'global', key, value, type: 'single_line_text_field' } },
      { headers: HEADERS }
    );
  }

  // Image alt texts
  for (let i = 0; i < product.images.length; i++) {
    const img = product.images[i];
    const alt = seoFix.image_alt_texts?.[i];
    if (img.id && alt) {
      await axios.put(
        `${SHOPIFY_STORE_URL}/admin/api/2024-01/products/${productId}/images/${img.id}.json`,
        { image: { id: img.id, alt } },
        { headers: HEADERS }
      );
    }
  }

  console.log('✅ All fixes pushed to Shopify');
}

// ─── 5. Save report ───────────────────────────────────────────────────────
function saveReport(result) {
  const dir = path.join(process.cwd(), 'seo-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `seo-${result.product_id}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`📄 Report: ${file}`);
}

// ─── Main export ──────────────────────────────────────────────────────────
async function instantSeoFix(productId, platform = 'shopify') {
  // Fetch
  console.log(`\n🔍 Fetching [${productId}]...`);
  const product = await fetchProduct(productId);
  console.log(`   Name   : ${product.name}`);
  console.log(`   Images : ${product.images.length}`);
  console.log(`   Tags   : ${product.tags || 'none'}`);

  // AI fix — Gemini Key 2 first, Groq fallback
  const prompt = buildPrompt(product);
  let seoFix, usedModel;

  try {
    console.log('🤖 Gemini (Key 2)...');
    seoFix    = await callGemini(prompt);
    usedModel = 'gemini-2.5-flash';
    console.log('   ✅ Gemini OK');
  } catch (err) {
    console.warn(`   ⚠️  Gemini failed (${err.message})`);
    console.log('🔄 Groq fallback...');
    seoFix    = await callGroq(prompt);
    usedModel = 'groq-llama3.3-70b';
    console.log('   ✅ Groq OK');
  }

  // Push to Shopify
  console.log('📤 Pushing to Shopify...');
  await pushToShopify(productId, seoFix, product);

  // Build & save result
  const result = {
    product_id:   product.id,
    product_name: product.name,
    platform,
    ai_model:     usedModel,
    timestamp:    new Date().toISOString(),
    ...seoFix,
  };
  saveReport(result);

  console.log(`🎉 Done — Score: ${seoFix.seo_score_before} → ${seoFix.seo_score_after} | ${usedModel}`);
  return result;
}

module.exports = { instantSeoFix };