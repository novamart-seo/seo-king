require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const Groq = require('groq-sdk');
const sharp = require('sharp');

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─── Limits ───────────────────────────────────────────────────────────────
const DAILY_LIMIT       = 980;
const RPM_LIMIT         = 28;
const MIN_DELAY_MS      = Math.ceil(60000 / RPM_LIMIT);

// ─── Image Settings ────────────────────────────────────────────────────────
const COMPRESS_THRESHOLD_KB = 200;
const WEBP_QUALITY          = 82;
const CONCURRENCY           = 3;   // Number of images processed in parallel

const DAILY_CALL_FILE = './tech-seo-calls.json';

const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Simple concurrency limiter (no external dependency)
class ConcurrencyLimit {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.running >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

const concurrencyLimit = new ConcurrencyLimit(CONCURRENCY);

// ─── Daily Call Counter ────────────────────────────────────────────────────
let totalCallsToday = 0;

function loadDailyCalls() {
  try {
    if (fs.existsSync(DAILY_CALL_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAILY_CALL_FILE, 'utf8'));
      if (data.date === new Date().toDateString()) {
        totalCallsToday = data.calls;
        console.log(`📊 Groq calls today: ${totalCallsToday}/${DAILY_LIMIT}`);
        return;
      }
    }
  } catch (e) {}
  totalCallsToday = 0;
  console.log(`📊 Groq calls today: 0/${DAILY_LIMIT} (fresh day)`);
}

function saveDailyCalls() {
  fs.writeFileSync(DAILY_CALL_FILE, JSON.stringify({
    date: new Date().toDateString(),
    calls: totalCallsToday
  }, null, 2));
}

// ─── Rate Limiter & Other Functions (unchanged) ───────────────────────────
let lastCallTime = 0;
let callsThisMinute = 0;
let minuteWindowStart = Date.now();

async function enforceRateLimit() {
  if (Date.now() - minuteWindowStart > 60000) {
    callsThisMinute = 0;
    minuteWindowStart = Date.now();
  }

  const timeSinceLast = Date.now() - lastCallTime;
  if (timeSinceLast < MIN_DELAY_MS) {
    await wait(MIN_DELAY_MS - timeSinceLast);
  }

  if (callsThisMinute >= RPM_LIMIT) {
    const waitTime = 60000 - (Date.now() - minuteWindowStart) + 1500;
    console.log(`   ⏳ RPM limit — waiting ${Math.round(waitTime/1000)}s...`);
    await wait(waitTime);
    callsThisMinute = 0;
    minuteWindowStart = Date.now();
  }
}

// Rest of the functions remain mostly the same...
async function generateAltText(productTitle, imageIndex, retries = 4) {
  if (totalCallsToday >= DAILY_LIMIT) return null;

  await enforceRateLimit();

  let backoff = 15000;

  for (let i = 0; i < retries; i++) {
    try {
      callsThisMinute++;
      lastCallTime = Date.now();
      totalCallsToday++;
      saveDailyCalls();

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{
          role: 'user',
          content: `Create SEO-optimized alt text for image ${imageIndex + 1} of: "${productTitle}"

Rules:
- Max 125 characters
- Natural & descriptive
- Include product name
- Mention color/style if relevant
- Return ONLY the alt text`
        }],
        max_tokens: 70,
        temperature: 0.65
      });

      return response.choices[0].message.content.trim();

    } catch (error) {
      totalCallsToday = Math.max(0, totalCallsToday - 1);
      callsThisMinute = Math.max(0, callsThisMinute - 1);
      saveDailyCalls();

      const msg = error.message || '';
      if (msg.includes('401')) {
        console.log('   🛑 Invalid Groq API key.');
        process.exit(1);
      }
      if (msg.includes('429') && i < retries - 1) {
        console.log(`   ⏳ Rate limit — waiting ${backoff/1000}s...`);
        await wait(backoff);
        backoff = Math.min(backoff * 1.8, 60000);
      } else {
        return null;
      }
    }
  }
  return null;
}

async function downloadImage(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function convertToWebP(buffer, altText) {
  return await sharp(buffer)
    .webp({ quality: WEBP_QUALITY })
    .withMetadata({ exif: { IFD0: { ImageDescription: altText || '' } } })
    .toBuffer();
}

function generateFilename(title, index) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) + `-${index + 1}.webp`;
}

async function getImageSizeKB(url) {
  try {
    const res = await axios.head(url);
    return Math.round(parseInt(res.headers['content-length'] || 0) / 1024);
  } catch {
    return 0;
  }
}

// Shopify helpers...
async function uploadProductImage(productId, buffer, filename, altText, position) {
  const response = await shopify.post(`/products/${productId}/images.json`, {
    image: { attachment: buffer.toString('base64'), filename, alt: altText || '', position }
  });
  return response.data.image;
}

async function deleteProductImage(productId, imageId) {
  await shopify.delete(`/products/${productId}/images/${imageId}.json`);
}

async function updateImageAlt(productId, imageId, altText) {
  await shopify.put(`/products/${productId}/images/${imageId}.json`, {
    image: { alt: altText }
  });
}

// ─── Process Image ───────────────────────────────────────────────────────
async function processProductImage(product, img, index) {
  // ... (same logic as before)
  const filename = img.src.split('/').pop().split('?')[0];
  const isWebP = filename.toLowerCase().endsWith('.webp');
  const isNumeric = /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename);
  const missingAlt = !img.alt || img.alt.trim() === '';

  if (isWebP && !isNumeric && !missingAlt) {
    const sizeKB = await getImageSizeKB(img.src);
    if (sizeKB <= COMPRESS_THRESHOLD_KB) {
      console.log(`   ⏭️  Image ${index + 1} already optimized`);
      return { action: 'skipped' };
    }
  }

  console.log(`   🖼️  Image ${index + 1}: ${filename}`);

  let altText = img.alt;
  if (missingAlt) {
    if (totalCallsToday < DAILY_LIMIT) {
      console.log(`      Generating alt text...`);
      altText = await generateAltText(product.title, index);
    } else {
      altText = `${product.title} - Image ${index + 1}`;
    }
  }

  const sizeKB = await getImageSizeKB(img.src);
  const needsConversion = !isWebP || isNumeric || sizeKB > COMPRESS_THRESHOLD_KB;

  if (needsConversion) {
    console.log(`      Downloading (${sizeKB}KB)...`);
    const buffer = await downloadImage(img.src);
    const webpBuf = await convertToWebP(buffer, altText);
    const newSizeKB = Math.round(webpBuf.length / 1024);
    const newFilename = generateFilename(product.title, index);

    console.log(`      Compressed: ${sizeKB}KB → ${newSizeKB}KB`);

    await uploadProductImage(product.id, webpBuf, newFilename, altText, img.position);
    await deleteProductImage(product.id, img.id);

    console.log(`      ✅ Replaced with optimized WebP`);
    return { action: 'converted' };
  } 
  else if (missingAlt && altText) {
    await updateImageAlt(product.id, img.id, altText);
    console.log(`      ✅ Alt text updated`);
    return { action: 'alt_only' };
  }

  return { action: 'skipped' };
}

// ─── Process Product with Concurrency ─────────────────────────────────────
async function processProduct(product) {
  if (!product.images?.length) return { converted: 0, altOnly: 0, skipped: 0, errors: 0 };

  const stats = { converted: 0, altOnly: 0, skipped: 0, errors: 0 };

  for (let i = 0; i < product.images.length; i++) {
    try {
      const result = await concurrencyLimit.run(() => 
        processProductImage(product, product.images[i], i)
      );
      
      if (result.action === 'converted') stats.converted++;
      else if (result.action === 'alt_only') stats.altOnly++;
      else if (result.action === 'skipped') stats.skipped++;
    } catch (err) {
      console.error(`      ❌ Image ${i+1} error: ${err.message}`);
      stats.errors++;
    }
    await wait(250);
  }

  return stats;
}

// Keep the rest of your script (processCollections, getAllProducts, runTechnicalSEO, etc.)

// ... [Copy the remaining parts from previous version: processCollections, getAllProducts, runTechnicalSEO]

async function runTechnicalSEO() {
  console.log('\n🚀 Nova Mart Technical SEO Optimizer');
  console.log('='.repeat(60));

  loadDailyCalls();

  // Groq verification
  try {
    await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: 'Reply with OK' }],
      max_tokens: 5
    });
    console.log('   ✅ Groq API key verified');
    totalCallsToday++;
    saveDailyCalls();
  } catch (e) {
    console.error('   ❌ Groq key invalid:', e.message);
    process.exit(1);
  }

  console.log('\n📦 STEP 1 — Product Images');
  const products = await getAllProducts();
  console.log(`Found ${products.length} products\n`);

  let totalConverted = 0, totalAltOnly = 0, totalErrors = 0;

  for (const product of products) {
    const needsWork = product.images?.some(img => {
      const fn = img.src.split('/').pop().split('?')[0].toLowerCase();
      return !img.alt?.trim() || /^[0-9]+\.(jpg|png|jpeg|webp)$/.test(fn) || !fn.endsWith('.webp');
    });

    if (!needsWork) continue;

    console.log(`🔧 ${product.title}`);
    const stats = await processProduct(product);
    totalConverted += stats.converted;
    totalAltOnly += stats.altOnly;
    totalErrors += stats.errors;
  }

  await processCollections();

  console.log('\n✅ TECHNICAL SEO COMPLETE');
  console.log(`📊 Groq calls used : ${totalCallsToday}/${DAILY_LIMIT}`);
  console.log(`🖼️  Images converted : ${totalConverted}`);
}

runTechnicalSEO().catch(console.error);