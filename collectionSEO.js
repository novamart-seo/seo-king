require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');
const Groq  = require('groq-sdk');
const sharp = require('sharp');

// ─── Config ────────────────────────────────────────────────────────────────
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Gemini (primary) — 3rd API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY_3;
const GEMINI_MODEL   = 'gemini-2.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Groq (fallback)
const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Rate / Daily Limits ───────────────────────────────────────────────────
const GEMINI_RPM   = 10;
const GEMINI_DAILY = 490;
const GROQ_RPM     = 28;
const GROQ_DAILY   = 490;

// ─── Image Settings ────────────────────────────────────────────────────────
const COMPRESS_THRESHOLD_KB = 200;
const WEBP_QUALITY          = 82;

const CALL_LOG_FILE = './collection-seo-calls.json';

// ─── Shopify Client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── Call Counters ─────────────────────────────────────────────────────────
let geminiCallsToday = 0, groqCallsToday = 0;
let lastGeminiCall   = 0, lastGroqCall   = 0;
let geminiRpmCount   = 0, groqRpmCount   = 0;
let geminiRpmWindow  = Date.now(), groqRpmWindow = Date.now();

function loadCallLog() {
  try {
    if (fs.existsSync(CALL_LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CALL_LOG_FILE, 'utf8'));
      if (data.date === new Date().toDateString()) {
        geminiCallsToday = data.gemini || 0;
        groqCallsToday   = data.groq   || 0;
        console.log(`📊 Gemini calls today : ${geminiCallsToday}/${GEMINI_DAILY}`);
        console.log(`📊 Groq calls today   : ${groqCallsToday}/${GROQ_DAILY}`);
        return;
      }
    }
  } catch (e) {}
  geminiCallsToday = groqCallsToday = 0;
  console.log(`📊 Fresh day — Gemini: 0/${GEMINI_DAILY} | Groq: 0/${GROQ_DAILY}`);
}

function saveCallLog() {
  fs.writeFileSync(CALL_LOG_FILE, JSON.stringify({
    date:   new Date().toDateString(),
    gemini: geminiCallsToday,
    groq:   groqCallsToday
  }, null, 2));
}

// ─── Rate Limiters ─────────────────────────────────────────────────────────
async function enforceGeminiRate() {
  const now = Date.now();
  if (now - geminiRpmWindow > 60000) { geminiRpmCount = 0; geminiRpmWindow = now; }
  const minDelay = Math.ceil(60000 / GEMINI_RPM);
  if (now - lastGeminiCall < minDelay) await wait(minDelay - (now - lastGeminiCall));
  if (geminiRpmCount >= GEMINI_RPM) {
    const pause = 60000 - (Date.now() - geminiRpmWindow) + 2000;
    console.log(`   ⏳ Gemini RPM limit — waiting ${Math.round(pause / 1000)}s...`);
    await wait(pause);
    geminiRpmCount = 0; geminiRpmWindow = Date.now();
  }
}

async function enforceGroqRate() {
  const now = Date.now();
  if (now - groqRpmWindow > 60000) { groqRpmCount = 0; groqRpmWindow = now; }
  const minDelay = Math.ceil(60000 / GROQ_RPM);
  if (now - lastGroqCall < minDelay) await wait(minDelay - (now - lastGroqCall));
  if (groqRpmCount >= GROQ_RPM) {
    const pause = 60000 - (Date.now() - groqRpmWindow) + 2000;
    console.log(`   ⏳ Groq RPM limit — waiting ${Math.round(pause / 1000)}s...`);
    await wait(pause);
    groqRpmCount = 0; groqRpmWindow = Date.now();
  }
}

// ─── Gemini Call ───────────────────────────────────────────────────────────
async function callGemini(prompt, retries = 3) {
  if (geminiCallsToday >= GEMINI_DAILY) return null;
  await enforceGeminiRate();
  let backoff = 12000;
  for (let i = 0; i < retries; i++) {
    try {
      geminiRpmCount++; lastGeminiCall = Date.now();
      geminiCallsToday++; saveCallLog();
      const res = await axios.post(GEMINI_URL, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.4 }
      });
      return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch (err) {
      geminiCallsToday = Math.max(0, geminiCallsToday - 1);
      geminiRpmCount   = Math.max(0, geminiRpmCount - 1);
      saveCallLog();
      const status = err.response?.status;
      if (status === 400) { console.log('   🛑 Gemini key 3 invalid — check GEMINI_API_KEY_3'); return null; }
      if ((status === 429 || status === 503) && i < retries - 1) {
        console.log(`   ⏳ Gemini rate limit — waiting ${backoff / 1000}s...`);
        await wait(backoff); backoff = Math.min(backoff * 2, 60000);
      } else { console.log(`   ⚠️  Gemini error (${status}) — falling back to Groq`); return null; }
    }
  }
  return null;
}

// ─── Groq Fallback Call ────────────────────────────────────────────────────
async function callGroq(prompt, retries = 3) {
  if (groqCallsToday >= GROQ_DAILY) return null;
  await enforceGroqRate();
  let backoff = 15000;
  for (let i = 0; i < retries; i++) {
    try {
      groqRpmCount++; lastGroqCall = Date.now();
      groqCallsToday++; saveCallLog();
      const res = await groq.chat.completions.create({
        model: GROQ_MODEL, messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048, temperature: 0.4
      });
      return res.choices[0].message.content.trim();
    } catch (err) {
      groqCallsToday = Math.max(0, groqCallsToday - 1);
      groqRpmCount   = Math.max(0, groqRpmCount - 1);
      saveCallLog();
      const msg = err.message || '';
      if (msg.includes('401')) { console.error('   🛑 Invalid Groq key.'); return null; }
      if (msg.includes('429') && i < retries - 1) {
        console.log(`   ⏳ Groq rate limit — waiting ${backoff / 1000}s...`);
        await wait(backoff); backoff = Math.min(backoff * 1.8, 60000);
      } else return null;
    }
  }
  return null;
}

// ─── AI with Fallback ──────────────────────────────────────────────────────
async function callAI(prompt) {
  const g = await callGemini(prompt);
  if (g) return { text: g, source: 'gemini' };
  console.log(`   🔄 Falling back to Groq...`);
  const q = await callGroq(prompt);
  if (q) return { text: q, source: 'groq' };
  return null;
}

// ─── Full SEO Generator ────────────────────────────────────────────────────
// Generates ALL fields in ONE AI call:
//   metaTitle, metaDescription, bodyHtml (H2 + intro + 4 bullets + CTA), handle, altText
async function generateCollectionSEO(collection) {
  const title       = collection.title || '';
  const currentDesc = collection.body_html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
  const hasImage    = !!collection.image?.src;
  const storeName   = 'Nova Mart';

  const prompt = `You are a senior Google-standard SEO copywriter for "${storeName}", a Shopify fashion and lifestyle e-commerce store.

Write complete, publish-ready SEO content for this collection page.
Return ONLY valid JSON — no markdown fences, no extra text, just the raw JSON object.

Collection: "${title}"
Existing description hint: "${currentDesc.slice(0, 300) || 'None'}"
Has cover image: ${hasImage}

Return exactly this JSON structure:
{
  "metaTitle": "50-60 chars. Primary keyword near front, brand at end after |. E.g: Women's Luggage & Travel Bags | Nova Mart",
  "metaDescription": "150-160 chars. Includes primary + secondary keyword. Ends with soft CTA. No duplicate of metaTitle.",
  "bodyHtml": "<h2>Catchy 4-6 word benefit-led heading</h2><p>2-sentence intro naturally weaving in the primary keyword and what makes this collection great at Nova Mart.</p><ul><li><strong>Sub-category or Feature 1</strong> — one short benefit sentence</li><li><strong>Sub-category or Feature 2</strong> — one short benefit sentence</li><li><strong>Sub-category or Feature 3</strong> — one short benefit sentence</li><li><strong>Sub-category or Feature 4</strong> — one short benefit sentence</li></ul><p>1-sentence closing CTA mentioning Nova Mart and a value reason like free returns, wide range, or quality.</p>",
  "handle": "seo-url-slug-lowercase-hyphens-max-50-chars",
  "altText": "${hasImage ? '110-125 char alt text for the collection cover image. Visually descriptive. Includes collection name. No phrase image of or photo of.' : 'N/A'}"
}

Hard rules:
- metaTitle under 60 chars exactly, no ALL CAPS
- metaDescription 150-160 chars exactly
- bodyHtml must follow the exact HTML structure shown — h2, intro p, ul with 4 li, closing p
- The 4 bullet items must reflect realistic sub-categories or product features for the "${title}" collection
- handle: lowercase, hyphens only, no stop words, max 50 chars
- All text written for humans, not keyword-stuffed`;

  const result = await callAI(prompt);
  if (!result) return null;

  try {
    // Strip markdown fences
    let clean = result.text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    // If truncated (no closing brace), attempt recovery
    if (!clean.endsWith('}')) {
      // Remove last incomplete key-value pair and close the object
      clean = clean.replace(/,?\s*"[^"]*"?\s*:\s*"[^"]*$/, '').replace(/,\s*$/, '') + '\n}';
    }

    const parsed = JSON.parse(clean);

    // Validate required fields
    if (!parsed.metaTitle || !parsed.metaDescription || !parsed.bodyHtml) {
      console.error(`   ⚠️  AI response missing required fields`);
      return null;
    }

    parsed._source = result.source;
    return parsed;
  } catch (e) {
    console.error(`   ⚠️  JSON parse failed: ${e.message}`);
    console.error(`   Raw response snippet: ${result.text.slice(0, 400)}`);
    return null;
  }
}

// ─── Image Helpers ─────────────────────────────────────────────────────────
async function downloadImage(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function convertToWebP(buffer, altText) {
  return await sharp(buffer)
    .webp({ quality: WEBP_QUALITY })
    .withMetadata({ exif: { IFD0: { ImageDescription: altText || '' } } })
    .toBuffer();
}

function toSlug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

async function getImageSizeKB(url) {
  try {
    const res = await axios.head(url);
    return Math.round(parseInt(res.headers['content-length'] || 0) / 1024);
  } catch { return 0; }
}

// ─── Fetch All Collections (paginated) ────────────────────────────────────
async function getAllCollections() {
  const collections = [];
  for (const [type, key] of [['custom', 'custom_collections'], ['smart', 'smart_collections']]) {
    let url = `/${key}.json?limit=250`;
    while (url) {
      const res = await shopify.get(url);
      collections.push(...res.data[key].map(c => ({ ...c, _type: type })));
      const next = res.headers['link']?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      url = next ? new URL(next).pathname.replace('/admin/api/2024-01', '') + new URL(next).search : null;
    }
  }
  return collections;
}

// ─── Apply All SEO Fields to Shopify ──────────────────────────────────────
async function applyCollectionSEO(collection, seo) {
  const isCustom = collection._type === 'custom';
  const endpoint = isCustom
    ? `/custom_collections/${collection.id}.json`
    : `/smart_collections/${collection.id}.json`;
  const key = isCustom ? 'custom_collection' : 'smart_collection';

  // 1. Push meta title, meta description, full body HTML, handle
  const payload = {
    id:                                collection.id,
    body_html:                         seo.bodyHtml,
    metafields_global_title_tag:       seo.metaTitle,
    metafields_global_description_tag: seo.metaDescription,
  };

  // Only update handle if current one is weak (numeric, blank, or exact title slug)
  const currentHandle = collection.handle || '';
  if (seo.handle && (!currentHandle || /^\d/.test(currentHandle))) {
    payload.handle = seo.handle;
  }

  await shopify.put(endpoint, { [key]: payload });
  console.log(`   ✅ Meta title, meta description, description, handle updated`);

  // 2. Image — optimize + set alt text
  if (collection.image?.src && seo.altText && seo.altText !== 'N/A') {
    const src       = collection.image.src;
    const filename  = src.split('/').pop().split('?')[0];
    const isWebP    = filename.toLowerCase().endsWith('.webp');
    const isNumeric = /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename);
    const sizeKB    = await getImageSizeKB(src);
    const needsConv = !isWebP || isNumeric || sizeKB > COMPRESS_THRESHOLD_KB;

    if (needsConv) {
      console.log(`   🖼️  Converting image (${sizeKB}KB → WebP)...`);
      const buf     = await downloadImage(src);
      const webpBuf = await convertToWebP(buf, seo.altText);
      const newKB   = Math.round(webpBuf.length / 1024);
      console.log(`   📉 ${sizeKB}KB → ${newKB}KB`);
      await shopify.put(endpoint, {
        [key]: {
          id: collection.id,
          image: {
            attachment: webpBuf.toString('base64'),
            filename:   toSlug(collection.title) + '-collection.webp',
            alt:        seo.altText
          }
        }
      });
      console.log(`   ✅ Image replaced: optimized WebP + alt text`);
    } else if (!collection.image.alt?.trim()) {
      await shopify.put(endpoint, { [key]: { id: collection.id, image: { alt: seo.altText } } });
      console.log(`   ✅ Image alt text set`);
    } else {
      console.log(`   ⏭️  Image already optimized — alt text preserved`);
    }
  } else if (!collection.image?.src) {
    console.log(`   ℹ️  No cover image on this collection`);
  }
}

// ─── Save Results Log ──────────────────────────────────────────────────────
function saveResults(results) {
  const file = './collection-seo-results.json';
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\n📄 Full results saved → ${file}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function runCollectionSEO() {
  console.log('\n🚀 Nova Mart — Full Collection SEO Optimizer');
  console.log('   Primary  : Gemini 2.5 Flash  (GEMINI_API_KEY_3)');
  console.log('   Fallback : Groq llama-3.3-70b-versatile');
  console.log('='.repeat(60));

  loadCallLog();

  // ── Verify Gemini key ────────────────────────────────────────────────────
  console.log('\n🔑 Verifying Gemini API key 3...');
  const test = await callGemini('Reply with one word: OK');
  if (test) {
    console.log('   ✅ Gemini key 3 verified');
  } else {
    console.log('   ⚠️  Gemini unavailable — verifying Groq fallback...');
    try {
      await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: 'Reply OK' }],
        max_tokens: 5
      });
      console.log('   ✅ Groq fallback verified');
      groqCallsToday++; saveCallLog();
    } catch {
      console.error('   ❌ Both Gemini and Groq failed. Check .env keys.');
      process.exit(1);
    }
  }

  // ── Fetch all collections ────────────────────────────────────────────────
  console.log('\n📂 Fetching all collections...');
  const collections = await getAllCollections();
  const customCount = collections.filter(c => c._type === 'custom').length;
  const smartCount  = collections.filter(c => c._type === 'smart').length;
  console.log(`   Found ${collections.length} total (${customCount} custom, ${smartCount} smart)\n`);

  if (!collections.length) { console.log('No collections found.'); return; }

  const results = [];
  let optimized = 0, errors = 0;

  for (let i = 0; i < collections.length; i++) {
    const col = collections[i];
    console.log(`[${i + 1}/${collections.length}] 🗂️  "${col.title}"  (${col._type})`);

    try {
      console.log(`   🤖 Generating SEO content via AI...`);
      const seo = await generateCollectionSEO(col);

      if (!seo) {
        console.log(`   ❌ AI generation failed — skipping\n`);
        errors++;
        results.push({ id: col.id, title: col.title, status: 'error', reason: 'AI generation failed' });
        continue;
      }

      // Preview generated content
      console.log(`   📌 Meta title       : ${seo.metaTitle}`);
      console.log(`   📌 Meta description : ${seo.metaDescription}`);
      console.log(`   📌 Handle           : ${seo.handle}`);
      console.log(`   📌 H2 heading       : ${seo.bodyHtml.match(/<h2>(.*?)<\/h2>/)?.[1] || '—'}`);
      if (seo.altText !== 'N/A') console.log(`   📌 Alt text         : ${seo.altText}`);
      console.log(`   🤖 Source           : ${seo._source}`);

      await applyCollectionSEO(col, seo);

      console.log(`   ✅ Done\n`);
      optimized++;
      results.push({
        id: col.id, title: col.title, type: col._type,
        status: 'optimized', source: seo._source,
        seo: {
          metaTitle:       seo.metaTitle,
          metaDescription: seo.metaDescription,
          handle:          seo.handle,
          altText:         seo.altText,
          bodyHtml:        seo.bodyHtml
        }
      });

    } catch (err) {
      console.error(`   ❌ ${err.message}\n`);
      errors++;
      results.push({ id: col.id, title: col.title, status: 'error', reason: err.message });
    }

    // Polite delay between collections
    if (i < collections.length - 1) await wait(1500);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('='.repeat(60));
  console.log('✅ COLLECTION SEO COMPLETE');
  console.log(`📂 Total collections : ${collections.length}`);
  console.log(`✨ Optimized         : ${optimized}`);
  console.log(`❌ Errors            : ${errors}`);
  console.log(`🤖 Gemini calls      : ${geminiCallsToday}/${GEMINI_DAILY}`);
  console.log(`🤖 Groq calls        : ${groqCallsToday}/${GROQ_DAILY}`);

  saveResults(results);
}

runCollectionSEO().catch(console.error);