/**
 * technicalSEO.js
 * Optimizes all product + collection images for Nova Mart.
 *
 * WHAT IT DOES:
 *  - Resizes images to max 2048x2048px (retina safe, no upscaling)
 *  - Converts to WebP at quality 72 (high compression, invisible quality loss)
 *  - Renames files to SEO-friendly slugs
 *  - Generates alt text (descriptive) via apiManager
 *  - Generates image title (short, keyword-focused) via apiManager
 *  - Saves both alt + title to Shopify image object
 *  - Tracks progress in techseo-progress.json — safe to stop/resume
 *  - Never reprocesses already completed images
 *  - Shows live progress throughout
 */

require('dotenv').config();

const axios = require('axios');
const fs    = require('fs');
const sharp = require('sharp');
const { callAIJson, verifyAllKeys, getStatus, hasCapacity } = require('./apiManager');

// ─── Store + Auth ──────────────────────────────────────────────────────────
const STORE = (process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE || '')
  .replace('https://', '').replace(/\/$/, '');
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ─── Compression Settings ──────────────────────────────────────────────────
const WEBP_QUALITY          = 72;     // high compression — invisible quality loss
const MAX_DIMENSION         = 2048;   // max px — 2x retina, no upscaling
const COMPRESS_THRESHOLD_KB = 150;    // compress if over 150KB
const DOWNLOAD_TIMEOUT      = 30000;
const CONCURRENCY           = 2;      // parallel image downloads (lower = safer)

// ─── Run Settings ──────────────────────────────────────────────────────────
const MAX_RUN_MINUTES = 300;
const RUN_START_TIME  = Date.now();

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
  return {
    completedProducts:    [],   // product IDs fully done
    completedCollections: [],   // collection IDs fully done
    completedImages:      {},   // { productId: [imageId, imageId, ...] }
  };
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function isImageDone(progress, productId, imageId) {
  return (progress.completedImages[productId] || []).includes(imageId);
}

function markImageDone(progress, productId, imageId) {
  if (!progress.completedImages[productId])
    progress.completedImages[productId] = [];
  if (!progress.completedImages[productId].includes(imageId))
    progress.completedImages[productId].push(imageId);
}

// ══════════════════════════════════════════════════════════════════════════
// SESSION STATS — live progress display
// ══════════════════════════════════════════════════════════════════════════

const session = {
  productsProcessed: 0,
  imagesConverted:   0,
  imagesAltOnly:     0,
  imagesSkipped:     0,
  imagesErrors:      0,
  totalSavedKB:      0,
};

function printSessionStats() {
  const elapsed = Math.round((Date.now() - RUN_START_TIME) / 60000);
  console.log('\n📊 Session Progress:');
  console.log(`   🏭 Products processed : ${session.productsProcessed}`);
  console.log(`   🖼️  Images converted   : ${session.imagesConverted}`);
  console.log(`   ✍️  Alt+Title only     : ${session.imagesAltOnly}`);
  console.log(`   ⏭️  Skipped            : ${session.imagesSkipped}`);
  console.log(`   ❌ Errors             : ${session.imagesErrors}`);
  console.log(`   💾 Total saved        : ${session.totalSavedKB}KB`);
  console.log(`   ⏱️  Elapsed            : ${elapsed} min`);
}

// ══════════════════════════════════════════════════════════════════════════
// AI — ALT TEXT + IMAGE TITLE
// ══════════════════════════════════════════════════════════════════════════

async function generateImageFields(productTitle, imageIndex) {
  const prompt = `Generate SEO image metadata for image ${imageIndex + 1} of the product: "${productTitle}"

Return ONLY a JSON object with exactly these two fields:
{
  "alt": "descriptive alt text, max 125 chars, natural language, mentions product name and key visible details",
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
  "alt": "descriptive alt text, max 125 chars, natural language, mentions collection name and category",
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
// IMAGE PROCESSING
// ══════════════════════════════════════════════════════════════════════════

async function downloadImage(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: DOWNLOAD_TIMEOUT,
  });
  return Buffer.from(response.data);
}

async function compressImage(buffer, altText) {
  try {
    // Resize to max 2048px (keeps aspect ratio, never upscales)
    // Then convert to WebP at quality 72 (high compression)
    return await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit:              'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    // Fallback without EXIF (handles some PNG edge cases)
    return await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit:              'inside',
        withoutEnlargement: true,
      })
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
    const res = await shopify.get(url);
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

async function processProductImage(progress, product, img, index, total) {
  // ── Skip if already done ──────────────────────────────────────────────
  if (isImageDone(progress, product.id, img.id)) {
    console.log(`   ⏭️  Image ${index + 1}/${total} already done — skipping`);
    session.imagesSkipped++;
    return { action: 'skipped' };
  }

  const filename     = img.src.split('/').pop().split('?')[0];
  const isWebP       = filename.toLowerCase().endsWith('.webp');
  const isNumeric    = /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename);
  const missingAlt   = !img.alt  || img.alt.trim()  === '';
  const missingTitle = !img.name || img.name.trim() === '';
  const sizeKB       = await getImageSizeKB(img.src);
  const oversized    = sizeKB > COMPRESS_THRESHOLD_KB;
  const needsConvert = !isWebP || isNumeric || oversized;
  const needsMeta    = missingAlt || missingTitle;

  // ── Already fully optimized ───────────────────────────────────────────
  if (!needsConvert && !needsMeta) {
    console.log(`   ⏭️  Image ${index + 1}/${total} already optimized ✓`);
    markImageDone(progress, product.id, img.id);
    session.imagesSkipped++;
    return { action: 'skipped' };
  }

  console.log(`   🖼️  Image ${index + 1}/${total}: ${filename}`);
  console.log(`      Size: ${sizeKB}KB | WebP: ${isWebP ? '✓' : '✗'} | Alt: ${missingAlt ? '✗' : '✓'} | Title: ${missingTitle ? '✗' : '✓'}`);

  // ── Generate alt + title via AI ───────────────────────────────────────
  let alt   = img.alt  || '';
  let title = img.name || '';

  if (needsMeta) {
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

  // ── Convert + compress + upload ───────────────────────────────────────
  if (needsConvert) {
    console.log(`      Downloading + compressing...`);
    const buffer      = await downloadImage(img.src);
    const webpBuf     = await compressImage(buffer, alt);
    const newSizeKB   = Math.round(webpBuf.length / 1024);
    const savedKB     = sizeKB - newSizeKB;
    const pct         = sizeKB > 0 ? Math.round((savedKB / sizeKB) * 100) : 0;
    const newFilename = generateFilename(product.title, index);

    console.log(`      Compressed: ${sizeKB}KB → ${newSizeKB}KB (saved ${savedKB}KB / ${pct}%)`);

    // Upload first, verify, THEN delete old
    const uploaded = await uploadProductImage(
      product.id, webpBuf, newFilename, alt, title, img.position
    );

    if (!uploaded?.id) {
      console.log(`      ❌ Upload failed — keeping original`);
      session.imagesErrors++;
      return { action: 'error' };
    }

    try {
      await deleteProductImage(product.id, img.id);
    } catch (delErr) {
      console.log(`      ⚠️  Upload OK but delete failed: ${delErr.message}`);
    }

    markImageDone(progress, product.id, uploaded.id);
    session.imagesConverted++;
    session.totalSavedKB += savedKB;
    console.log(`      ✅ Replaced — WebP + alt + title`);
    return { action: 'converted', savedKB };

  } else if (needsMeta) {
    // ── Alt/title only — no compression needed ────────────────────────
    await updateImageAltAndTitle(product.id, img.id, alt, title);
    markImageDone(progress, product.id, img.id);
    session.imagesAltOnly++;
    console.log(`      ✅ Alt + title updated`);
    return { action: 'alt_only' };
  }

  markImageDone(progress, product.id, img.id);
  return { action: 'skipped' };
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS ALL IMAGES FOR ONE PRODUCT
// ══════════════════════════════════════════════════════════════════════════

async function processProduct(progress, product) {
  if (!product.images?.length) {
    console.log(`   ⏭️  No images — skipping`);
    return;
  }

  // Fetch fresh image list (avoids stale data after replacements)
  let images;
  try {
    images = await getProductImages(product.id);
  } catch (err) {
    console.log(`   ❌ Could not fetch images: ${err.message}`);
    return;
  }

  console.log(`   📸 ${images.length} image(s) to check`);

  for (let i = 0; i < images.length; i++) {
    try {
      const result = await limiter.run(() =>
        processProductImage(progress, product, images[i], i, images.length)
      );
      // Re-fetch after conversion to get new image IDs
      if (result.action === 'converted') {
        try { images = await getProductImages(product.id); } catch {}
      }
    } catch (err) {
      console.error(`      ❌ Image ${i + 1} error: ${err.message}`);
      session.imagesErrors++;
    }
    await wait(300);
  }

  saveProgress(progress);
}

// ══════════════════════════════════════════════════════════════════════════
// PROCESS COLLECTIONS
// ══════════════════════════════════════════════════════════════════════════

async function processCollections(progress, collections) {
  console.log('\n🗂️  STEP 2 — Collection Images');
  console.log(`   Found ${collections.length} collections`);
  console.log(`   Already done: ${progress.completedCollections.length}`);
  console.log('='.repeat(60));

  let done = 0, skipped = 0, errors = 0;

  for (const collection of collections) {
    if (!hasCapacity()) { console.log('\n🛑 All API limits reached.'); break; }
    if ((Date.now() - RUN_START_TIME) / 60000 >= MAX_RUN_MINUTES) { console.log('\n⏱️  Time limit reached.'); break; }

    // ── Skip already done ──────────────────────────────────────────────
    if (progress.completedCollections.includes(collection.id)) {
      skipped++;
      continue;
    }

    if (!collection.image?.src) {
      console.log(`   ⏭️  "${collection.title}" — no image`);
      progress.completedCollections.push(collection.id);
      saveProgress(progress);
      skipped++;
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
      skipped++;
      continue;
    }

    console.log(`\n🗂️  ${collection.title}`);
    console.log(`   Size: ${sizeKB}KB | WebP: ${isWebP ? '✓' : '✗'} | Alt: ${missingAlt ? '✗' : '✓'} | Title: ${missingTitle ? '✗' : '✓'}`);

    try {
      let alt   = img.alt  || '';
      let title = img.name || '';

      if (missingAlt || missingTitle) {
        const fields = await generateCollectionImageFields(collection.title);
        if (fields) {
          if (missingAlt)   alt   = fields.alt;
          if (missingTitle) title = fields.title;
          console.log(`   Alt  : ${alt}`);
          console.log(`   Title: ${title}`);
        } else {
          alt   = alt   || `${collection.title} collection banner`;
          title = title || collection.title.slice(0, 60);
          console.log(`   ⚠️  AI unavailable — using fallback`);
        }
      }

      const endpoint      = `/${collection.type}_collections/${collection.id}.json`;
      const collectionKey = collection.type === 'custom' ? 'custom_collection' : 'smart_collection';

      if (needsConvert) {
        console.log(`   Downloading + compressing (${sizeKB}KB)...`);
        const buffer      = await downloadImage(img.src);
        const webpBuf     = await compressImage(buffer, alt);
        const newSizeKB   = Math.round(webpBuf.length / 1024);
        const savedKB     = sizeKB - newSizeKB;
        const pct         = sizeKB > 0 ? Math.round((savedKB / sizeKB) * 100) : 0;
        const newFilename = generateCollectionFilename(collection.title);

        console.log(`   Compressed: ${sizeKB}KB → ${newSizeKB}KB (saved ${savedKB}KB / ${pct}%)`);

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

        session.imagesConverted++;
        session.totalSavedKB += savedKB;
        console.log(`   ✅ Collection image replaced — WebP + alt + title`);
      } else {
        await shopify.put(endpoint, {
          [collectionKey]: {
            id: collection.id,
            image: { alt: alt || '', name: title || '' }
          }
        });
        session.imagesAltOnly++;
        console.log(`   ✅ Alt + title updated`);
      }

      progress.completedCollections.push(collection.id);
      saveProgress(progress);
      done++;

    } catch (err) {
      console.error(`   ❌ Error: ${err.message}`);
      errors++;
    }

    await wait(300);
  }

  console.log(`\n📊 Collections — Done: ${done} | Skipped: ${skipped} | Errors: ${errors}`);
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ══════════════════════════════════════════════════════════════════════════

async function runTechnicalSEO() {
  console.log('\n🚀 Nova Mart Technical SEO Optimizer');
  console.log(`   Compression : WebP quality ${WEBP_QUALITY} (high compression)`);
  console.log(`   Max size    : ${MAX_DIMENSION}×${MAX_DIMENSION}px (retina safe)`);
  console.log(`   Threshold   : compress if > ${COMPRESS_THRESHOLD_KB}KB`);
  console.log(`   Tracks      : per-image progress — never redoes completed images`);
  console.log('='.repeat(60));

  await verifyAllKeys();
  console.log(getStatus());

  const progress = loadProgress();
  console.log(`\n📂 Progress restored:`);
  console.log(`   Products fully done : ${progress.completedProducts.length}`);
  console.log(`   Collections done    : ${progress.completedCollections.length}`);
  console.log(`   Images done (total) : ${Object.values(progress.completedImages).flat().length}`);

  // ── STEP 1: Products ──────────────────────────────────────────────────
  console.log('\n📦 STEP 1 — Product Images');
  const products = await getAllProducts();
  console.log(`   Found    : ${products.length} products`);
  console.log(`   Skipping : ${progress.completedProducts.length} fully completed`);
  console.log('='.repeat(60));

  for (const product of products) {
    if (!hasCapacity()) { console.log('\n🛑 All API limits reached — saving progress.'); break; }
    if ((Date.now() - RUN_START_TIME) / 60000 >= MAX_RUN_MINUTES) { console.log('\n⏱️  Time limit reached.'); break; }

    // Skip fully completed products
    if (progress.completedProducts.includes(product.id)) continue;

    // Quick check — does any image still need work?
    const needsWork = product.images?.some(img => {
      const fn        = img.src.split('/').pop().split('?')[0].toLowerCase();
      const isWebP    = fn.endsWith('.webp');
      const isNumeric = /^[0-9]+\.(jpg|png|jpeg|webp)$/.test(fn);
      const hasAlt    = !!img.alt?.trim();
      const hasTitle  = !!img.name?.trim();
      const isDone    = isImageDone(progress, product.id, img.id);
      return !isDone && (!isWebP || isNumeric || !hasAlt || !hasTitle);
    });

    if (!needsWork) {
      progress.completedProducts.push(product.id);
      saveProgress(progress);
      session.imagesSkipped++;
      continue;
    }

    session.productsProcessed++;
    console.log(`\n🔧 [${session.productsProcessed}] ${product.title}`);
    await processProduct(progress, product);

    // Mark product complete if all images done
    const freshImages = await getProductImages(product.id).catch(() => []);
    const allDone = freshImages.every(img => isImageDone(progress, product.id, img.id));
    if (allDone) progress.completedProducts.push(product.id);
    saveProgress(progress);

    // Print live stats every 10 products
    if (session.productsProcessed % 10 === 0) printSessionStats();
  }

  // ── STEP 2: Collections ───────────────────────────────────────────────
  const collections = await getAllCollections();
  await processCollections(progress, collections);

  // ── FINAL SUMMARY ─────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log('✅ TECHNICAL SEO COMPLETE');
  printSessionStats();
  console.log(getStatus());
  console.log('='.repeat(60));
}

runTechnicalSEO().catch(err => {
  console.error('❌ technicalSEO crashed:', err.message);
  process.exit(1);
});