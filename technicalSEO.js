/**
 * technicalSEO.js
 * Optimizes all product + collection images for Nova Mart.
 *
 * WHAT IT DOES:
 *  - Converts images to WebP, compresses oversized ones
 *  - Renames files to SEO-friendly slugs
 *  - Generates alt text (descriptive) via apiManager
 *  - Generates image title (short, keyword-focused) via apiManager
 *  - Saves both alt + title to Shopify image object
 *  - Tracks progress in techseo-progress.json — safe to stop/resume
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');
const sharp = require('sharp');
const { callAIJson, verifyAllKeys, getStatus } = require('./apiManager');

// ─── Store + Auth ──────────────────────────────────────────────────────────
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Limits ────────────────────────────────────────────────────────────────
const DOWNLOAD_TIMEOUT      = 30000;
const COMPRESS_THRESHOLD_KB = 200;
const WEBP_QUALITY          = 82;
const CONCURRENCY           = 3;

// ─── File paths ────────────────────────────────────────────────────────────
const PROGRESS_FILE = './techseo-progress.json';

// ─── Shopify client ────────────────────────────────────────────────────────
const shopify = axios.create({
  baseURL: `https://${STORE}/admin/api/2024-01`,
  headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' }
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════
// CONCURRENCY LIMITER
// ══════════════════════════════════════════════════════════════════════════

class ConcurrencyLimit {
  constructor(limit) { this.limit = limit; this.running = 0; this.queue = []; }
  async run(fn) {
    if (this.running >= this.limit)
      await new Promise(r => this.queue.push(r));
    this.running++;
    try { return await fn(); }
    finally {
      this.running--;
      if (this.queue.length > 0) this.queue.shift()();
    }
  }
}

const limiter = new ConcurrencyLimit(CONCURRENCY);

// ══════════════════════════════════════════════════════════════════════════
// PROGRESS TRACKING
// ══════════════════════════════════════════════════════════════════════════

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE))
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch (e) {}
  return { completedProducts: [], completedCollections: [] };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

// ══════════════════════════════════════════════════════════════════════════
// AI — ALT TEXT + IMAGE TITLE (two fields, one call via apiManager)
// ══════════════════════════════════════════════════════════════════════════

async function generateImageFields(productTitle, imageIndex) {
  const prompt = `Generate SEO image metadata for image ${imageIndex + 1} of the product: "${productTitle}"

Return ONLY a JSON object with exactly these two fields:
{
  "alt": "descriptive alt text, max 125 chars, natural language, mentions product name and visible details",
  "title": "short keyword-focused title, max 60 chars, product name + key feature, no filler words"
}

No explanation, no markdown, no backticks. Raw JSON only.`;

  const result = await callAIJson(prompt);
  if (!result) return null;

  console.log(`      🤖 ${result.keyLabel}`);
  return {
    alt:   (result.data.alt   || '').slice(0, 125).trim(),
    title: (result.data.title || '').slice(0, 60).trim(),
  };
}

async function generateCollectionImageFields(collectionTitle) {
  const prompt = `Generate SEO image metadata for the banner image of the Shopify collection: "${collectionTitle}"

Return ONLY a JSON object with exactly these two fields:
{
  "alt": "descriptive alt text, max 125 chars, natural language, mentions collection name",
  "title": "short keyword-focused title, max 60 chars, collection name + category keywords"
}

No explanation, no markdown, no backticks. Raw JSON only.`;

  const result = await callAIJson(prompt);
  if (!result) return null;

  console.log(`   🤖 ${result.keyLabel}`);
  return {
    alt:   (result.data.alt   || '').slice(0, 125).trim(),
    title: (result.data.title || '').slice(0, 60).trim(),
  };
}

// ══════════════════════════════════════════════════════════════════════════
// IMAGE HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT,
  });
  return Buffer.from(response.data);
}

async function convertToWebP(buffer, altText) {
  try {
    return await sharp(buffer)
      .webp({ quality: WEBP_QUALITY })
      .withMetadata({ exif: { IFD0: { ImageDescription: altText || '' } } })
      .toBuffer();
  } catch {
    // Fallback: convert without EXIF (handles PNGs that reject EXIF)
    return await sharp(buffer)
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  }
}

function generateFilename(title, index) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) + `-${index + 1}.webp`;
}

function generateCollectionFilename(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 52) + '-collection.webp';
}

async function getImageSizeKB(url) {
  try {
    const res = await axios.head(url, { timeout: 10000 });
    return Math.round(parseInt(res.headers['content-length'] || 0) / 1024);
  } catch { return 0; }
}

// ══════════════════════════════════════════════════════════════════════════
// SHOPIFY HELPERS
// ══════════════════════════════════════════════════════════════════════════

async function getProductImages(productId) {
  const res = await shopify.get(`/products/${productId}/images.json`);
  return res.data.images;
}

async function uploadProductImage(productId, buffer, filename, alt, title, position) {
  const response = await shopify.post(`/products/${productId}/images.json`, {
    image: {
      attachment: buffer.toString('base64'),
      filename,
      alt:      alt   || '',
      name:     title || '',
      position,
    }
  });
  return response.data.image;
}

async function deleteProductImage(productId, imageId) {
  await shopify.delete(`/products/${productId}/images/${imageId}.json`);
}

async function updateImageAltAndTitle(productId, imageId, alt, title) {
  await shopify.put(`/products/${productId}/images/${imageId}.json`, {
    image: { alt: alt || '', name: title || '' }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// FETCH ALL PRODUCTS + COLLECTIONS
// ══════════════════════════════════════════════════════════════════════════

async function getAllProducts() {
  const products = [];
  let url = '/products.json?limit=250&status=active&fields=id,title,status,images';
  while (url) {
    const res  = await shopify.get(url);
    products.push(...res.data.products);
    const link = res.headers['link'] || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (next) {
      const parsed = new URL(next[1]);
      url = parsed.pathname.replace('/admin/api/2024-01', '') + parsed.search;
    } else { url = null; }
    if (products.length % 250 === 0 && products.length > 0)
      console.log(`   📦 Fetched ${products.length} products...`);
  }
  return products;
}

async function getAllCollections() {
  const collections = [];
  for (const type of ['custom', 'smart']) {
    let url = `/${type}_collections.json?limit=250&fields=id,title,image`;
    while (url) {
      const res = await shopify.get(url);
      const key = type === 'custom' ? 'custom_collections' : 'smart_collections';
      collections.push(...res.data[key].map(c => ({ ...c, type })));
      const link = res.headers['link'] || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      if (next) {
        const parsed = new URL(next[1]);
        url = parsed.pathname.replace('/admin/api/2024-01', '') + parsed.search;
      } else { url = null; }
    }
  }
  return collections;
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS SINGLE PRODUCT IMAGE
// ══════════════════════════════════════════════════════════════════════════

async function processProductImage(product, img, index) {
  const filename     = img.src.split('/').pop().split('?')[0];
  const isWebP       = filename.toLowerCase().endsWith('.webp');
  const isNumeric    = /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename);
  const missingAlt   = !img.alt  || img.alt.trim()  === '';
  const missingTitle = !img.name || img.name.trim() === '';

  // Check size once and cache it
  const sizeKB       = await getImageSizeKB(img.src);
  const oversized    = sizeKB > COMPRESS_THRESHOLD_KB;
  const needsConvert = !isWebP || isNumeric || oversized;
  const needsMetadata = missingAlt || missingTitle;

  // Skip only when ALL four conditions are already met:
  // WebP format + SEO filename + under size threshold + has both alt & title
  if (!needsConvert && !needsMetadata) {
    console.log(`   ⏭️  Image ${index + 1} already optimized (WebP ✓ size ✓ alt ✓ title ✓)`);
    return { action: 'skipped' };
  }

  console.log(`   🖼️  Image ${index + 1}: ${filename} (${sizeKB}KB)`);

  // Generate alt + title together in one AI call
  let alt   = img.alt  || '';
  let title = img.name || '';

  if (needsMetadata) {
    console.log(`      Generating alt text + title...`);
    const fields = await generateImageFields(product.title, index);
    if (fields) {
      if (missingAlt)   alt   = fields.alt;
      if (missingTitle) title = fields.title;
      console.log(`      Alt  : ${alt}`);
      console.log(`      Title: ${title}`);
    } else {
      // Fallback when all AI keys exhausted
      alt   = alt   || `${product.title} - Image ${index + 1}`;
      title = title || product.title.slice(0, 60);
      console.log(`      ⚠️  AI unavailable — using fallback metadata`);
    }
  }

  if (needsConvert) {
    console.log(`      Downloading...`);
    const buffer      = await downloadImage(img.src);
    const webpBuf     = await convertToWebP(buffer, alt);
    const newSizeKB   = Math.round(webpBuf.length / 1024);
    const newFilename = generateFilename(product.title, index);

    console.log(`      Compressed: ${sizeKB}KB → ${newSizeKB}KB`);

    // Upload first, verify success, THEN delete old image
    const uploaded = await uploadProductImage(
      product.id, webpBuf, newFilename, alt, title, img.position
    );

    if (!uploaded?.id) {
      console.log(`      ❌ Upload failed — keeping original image`);
      return { action: 'error' };
    }

    try {
      await deleteProductImage(product.id, img.id);
    } catch (delErr) {
      console.log(`      ⚠️  Upload OK but old image delete failed: ${delErr.message}`);
    }

    console.log(`      ✅ Replaced with optimized WebP + alt + title`);
    return { action: 'converted' };

  } else if (needsMetadata) {
    await updateImageAltAndTitle(product.id, img.id, alt, title);
    console.log(`      ✅ Alt text + title updated`);
    return { action: 'alt_only' };
  }

  return { action: 'skipped' };
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS ALL IMAGES FOR ONE PRODUCT
// ══════════════════════════════════════════════════════════════════════════

async function processProduct(product) {
  if (!product.images?.length) return { converted: 0, altOnly: 0, skipped: 0, errors: 0 };

  const stats = { converted: 0, altOnly: 0, skipped: 0, errors: 0 };

  // Always fetch fresh image list (avoids stale array after replacements)
  let freshImages;
  try {
    freshImages = await getProductImages(product.id);
  } catch (err) {
    console.log(`   ❌ Could not fetch images: ${err.message}`);
    return stats;
  }

  for (let i = 0; i < freshImages.length; i++) {
    try {
      const result = await limiter.run(() =>
        processProductImage(product, freshImages[i], i)
      );

      if (result.action === 'converted') {
        stats.converted++;
        // Re-fetch after replacement so next iteration has correct IDs/positions
        try { freshImages = await getProductImages(product.id); } catch {}
      } else if (result.action === 'alt_only') stats.altOnly++;
      else if (result.action === 'skipped')   stats.skipped++;
      else if (result.action === 'error')     stats.errors++;

    } catch (err) {
      console.error(`      ❌ Image ${i + 1} error: ${err.message}`);
      stats.errors++;
    }
    await wait(250);
  }

  return stats;
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS COLLECTIONS
// ══════════════════════════════════════════════════════════════════════════

async function processCollections(progress) {
  console.log('\n🗂️  STEP 2 — Collection Images');

  const collections = await getAllCollections();
  console.log(`Found ${collections.length} collections\n`);

  let totalConverted = 0, totalAltOnly = 0, totalSkipped = 0, totalErrors = 0;

  for (const collection of collections) {
    if (progress.completedCollections.includes(collection.id)) {
      console.log(`   ⏭️  "${collection.title}" — already done`);
      totalSkipped++;
      continue;
    }

    if (!collection.image?.src) {
      console.log(`   ⏭️  "${collection.title}" — no image`);
      progress.completedCollections.push(collection.id);
      saveProgress(progress);
      continue;
    }

    const img          = collection.image;
    const filename     = img.src.split('/').pop().split('?')[0];
    const isWebP       = filename.toLowerCase().endsWith('.webp');
    const isNumeric    = /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename);
    const missingAlt   = !img.alt  || img.alt.trim()  === '';
    const missingTitle = !img.name || img.name.trim() === '';
    const sizeKB       = await getImageSizeKB(img.src);
    const needsConvert = !isWebP || isNumeric || sizeKB > COMPRESS_THRESHOLD_KB;

    if (!needsConvert && !missingAlt && !missingTitle) {
      console.log(`   ⏭️  "${collection.title}" already optimized`);
      progress.completedCollections.push(collection.id);
      saveProgress(progress);
      totalSkipped++;
      continue;
    }

    console.log(`🗂️  ${collection.title}`);

    try {
      let alt   = img.alt  || '';
      let title = img.name || '';

      if (missingAlt || missingTitle) {
        console.log(`   Generating alt text + title...`);
        const fields = await generateCollectionImageFields(collection.title);
        if (fields) {
          if (missingAlt)   alt   = fields.alt;
          if (missingTitle) title = fields.title;
          console.log(`   Alt  : ${alt}`);
          console.log(`   Title: ${title}`);
        } else {
          alt   = alt   || `${collection.title} collection banner`;
          title = title || collection.title.slice(0, 60);
          console.log(`   ⚠️  AI unavailable — using fallback metadata`);
        }
      }

      const endpoint      = `/${collection.type}_collections/${collection.id}.json`;
      const collectionKey = collection.type === 'custom' ? 'custom_collection' : 'smart_collection';

      if (needsConvert) {
        console.log(`   Downloading (${sizeKB}KB)...`);
        const buffer      = await downloadImage(img.src);
        const webpBuf     = await convertToWebP(buffer, alt);
        const newSizeKB   = Math.round(webpBuf.length / 1024);
        const newFilename = generateCollectionFilename(collection.title);

        console.log(`   Compressed: ${sizeKB}KB → ${newSizeKB}KB`);

        await shopify.put(endpoint, {
          [collectionKey]: {
            id: collection.id,
            image: {
              attachment: webpBuf.toString('base64'),
              filename:   newFilename,
              alt:        alt   || '',
              name:       title || '',
            }
          }
        });

        console.log(`   ✅ Collection image replaced — WebP + alt + title`);
        totalConverted++;
      } else {
        await shopify.put(endpoint, {
          [collectionKey]: {
            id: collection.id,
            image: { alt: alt || '', name: title || '' }
          }
        });
        console.log(`   ✅ Collection alt + title updated`);
        totalAltOnly++;
      }

      progress.completedCollections.push(collection.id);
      saveProgress(progress);

    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      totalErrors++;
    }

    await wait(300);
  }

  console.log(`\n📊 Collections — Converted: ${totalConverted} | Alt+Title only: ${totalAltOnly} | Skipped: ${totalSkipped} | Errors: ${totalErrors}`);
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ══════════════════════════════════════════════════════════════════════════

async function runTechnicalSEO() {
  console.log('\n🚀 Nova Mart Technical SEO Optimizer');
  console.log('='.repeat(60));

  // Verify all AI keys via apiManager
  await verifyAllKeys();
  console.log(getStatus());

  const progress = loadProgress();
  console.log(`\n📂 Progress — Products done: ${progress.completedProducts.length} | Collections done: ${progress.completedCollections.length}`);

  // ── STEP 1: Products ──────────────────────────────────────────────────
  console.log('\n📦 STEP 1 — Product Images');
  const products = await getAllProducts();
  console.log(`Found ${products.length} products\n`);

  let totalConverted = 0, totalAltOnly = 0, totalErrors = 0, totalSkipped = 0;

  for (const product of products) {
    // Skip already fully processed products
    if (progress.completedProducts.includes(product.id)) {
      totalSkipped++;
      continue;
    }

    // Quick check: does any image still need work?
    // Fully optimized = WebP + non-numeric filename + has alt + has title
    const needsWork = product.images?.some(img => {
      const fn        = img.src.split('/').pop().split('?')[0].toLowerCase();
      const isWebP    = fn.endsWith('.webp');
      const isNumeric = /^[0-9]+\.(jpg|png|jpeg|webp)$/.test(fn);
      const hasAlt    = !!img.alt?.trim();
      const hasTitle  = !!img.name?.trim();
      return !isWebP || isNumeric || !hasAlt || !hasTitle;
    });

    if (!needsWork) {
      progress.completedProducts.push(product.id);
      saveProgress(progress);
      totalSkipped++;
      continue;
    }

    console.log(`🔧 ${product.title}`);
    const stats = await processProduct(product);

    totalConverted += stats.converted;
    totalAltOnly   += stats.altOnly;
    totalErrors    += stats.errors;

    progress.completedProducts.push(product.id);
    saveProgress(progress);

    console.log(`   📊 ${getStatus()}`);
  }

  // ── STEP 2: Collections ───────────────────────────────────────────────
  await processCollections(progress);

  console.log('\n' + '='.repeat(60));
  console.log('✅ TECHNICAL SEO COMPLETE');
  console.log(`📊 ${getStatus()}`);
  console.log(`🖼️  Images converted  : ${totalConverted}`);
  console.log(`✍️  Alt+Title only    : ${totalAltOnly}`);
  console.log(`⏭️  Skipped           : ${totalSkipped}`);
  console.log(`❌ Errors            : ${totalErrors}`);
  console.log('='.repeat(60));
}

runTechnicalSEO().catch(err => {
  console.error('❌ technicalSEO crashed:', err.message);
  process.exit(1);
});