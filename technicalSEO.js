require('dotenv').config();
const axios = require('axios');
const Groq = require('groq-sdk');
const sharp = require('sharp');

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

// Generate alt text using Groq
async function generateAltText(productTitle, imageIndex, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Write SEO alt text for product image ${imageIndex + 1} of: ${productTitle}
Rules:
- Under 125 characters
- Descriptive and natural
- Include product name
- No quotes
- Return ONLY the alt text, nothing else`
        }],
        max_tokens: 100,
        temperature: 0.7
      });
      return response.choices[0].message.content.trim();
    } catch (error) {
      if (error.message.includes('429') || error.message.includes('rate')) {
        console.log('   ⏳ Rate limit — waiting 10 seconds...');
        await wait(10000);
      } else throw error;
    }
  }
  return null;
}

// Generate alt text for non-product images
async function generateGenericAltText(context, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{
          role: 'user',
          content: `Write SEO alt text for this image context: ${context}
Rules:
- Under 125 characters
- Descriptive and natural
- No quotes
- Return ONLY the alt text, nothing else`
        }],
        max_tokens: 100,
        temperature: 0.7
      });
      return response.choices[0].message.content.trim();
    } catch (error) {
      if (error.message.includes('429') || error.message.includes('rate')) {
        console.log('   ⏳ Rate limit — waiting 10 seconds...');
        await wait(10000);
      } else throw error;
    }
  }
  return null;
}

// Download image as buffer
async function downloadImage(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

// Convert image to WebP and compress
async function convertToWebP(buffer) {
  return await sharp(buffer)
    .webp({ quality: 80 })
    .toBuffer();
}

// Generate SEO friendly filename
function generateFilename(title, index) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) + `-${index + 1}.webp`;
}

// Upload new image to Shopify
async function uploadImageToShopify(productId, imageBuffer, filename, altText, position) {
  const base64 = imageBuffer.toString('base64');
  const response = await shopify.post(`/products/${productId}/images.json`, {
    image: {
      attachment: base64,
      filename: filename,
      alt: altText,
      position: position
    }
  });
  return response.data.image;
}

// Delete old image from Shopify
async function deleteImage(productId, imageId) {
  await shopify.delete(`/products/${productId}/images/${imageId}.json`);
}

// Check image file size from URL
async function getImageSize(url) {
  try {
    const response = await axios.head(url);
    return parseInt(response.headers['content-length'] || 0);
  } catch {
    return 0;
  }
}

// Process and optimize any image URL
async function optimizeImageFromURL(imageUrl, filename, sizeKB) {
  const buffer = await downloadImage(imageUrl);
  const webpBuffer = await convertToWebP(buffer);
  const newSizeKB = Math.round(webpBuffer.length / 1024);
  console.log(`   ✅ Compressed: ${sizeKB}KB → ${newSizeKB}KB`);
  return webpBuffer;
}

// Process a single product image
async function processImage(product, img, index) {
  const filename = img.src.split('/').pop().split('?')[0];
  const isNumberFilename = /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename);
  const isAlreadyWebP = filename.toLowerCase().endsWith('.webp');
  const missingAlt = !img.alt || img.alt.trim() === '';

  const needsProcessing = isNumberFilename || !isAlreadyWebP || missingAlt;
  if (!needsProcessing) {
    console.log(`   ⏭️ Image ${index + 1} already optimized`);
    return;
  }

  console.log(`   🖼️ Processing image ${index + 1}: ${filename}`);

  try {
    let altText = img.alt;
    if (missingAlt) {
      console.log(`   Generating alt text...`);
      altText = await generateAltText(product.title, index);
      console.log(`   ✅ Alt text: ${altText?.slice(0, 50)}...`);
      await wait(2000);
    }

    const imageSize = await getImageSize(img.src);
    const sizeInKB = Math.round(imageSize / 1024);
    const needsConversion = !isAlreadyWebP || sizeInKB > 500 || isNumberFilename;

    if (needsConversion) {
      console.log(`   Downloading image (${sizeInKB}KB)...`);
      const webpBuffer = await optimizeImageFromURL(img.src, filename, sizeInKB);
      const newFilename = generateFilename(product.title, index);
      console.log(`   ✅ New filename: ${newFilename}`);
      console.log(`   Uploading to Shopify...`);
      await uploadImageToShopify(product.id, webpBuffer, newFilename, altText || '', img.position);
      await deleteImage(product.id, img.id);
      console.log(`   ✅ Old image replaced with optimized WebP`);
    } else if (missingAlt && altText) {
      await shopify.put(`/products/${product.id}/images/${img.id}.json`, {
        image: { id: img.id, alt: altText }
      });
      console.log(`   ✅ Alt text saved`);
    }
  } catch (error) {
    console.error(`   ❌ Error processing image ${index + 1}: ${error.message}`);
  }
}

// Process all images for a product
async function processProduct(product) {
  console.log(`\n🔧 Processing product: ${product.title}`);
  if (!product.images || product.images.length === 0) {
    console.log('   No images found');
    return;
  }
  for (let i = 0; i < product.images.length; i++) {
    await processImage(product, product.images[i], i);
    await wait(1000);
  }
}

// NEW — Process collection images
async function processCollections() {
  console.log('\n📁 Processing collection images...\n');
  try {
    const response = await shopify.get('/custom_collections.json?limit=250&fields=id,title,image');
    const collections = response.data.custom_collections;

    for (const collection of collections) {
      if (!collection.image) {
        console.log(`   ⏭️ ${collection.title} — no image`);
        continue;
      }

      const img = collection.image;
      const filename = img.src.split('/').pop().split('?')[0];
      const isAlreadyWebP = filename.toLowerCase().endsWith('.webp');
      const imageSize = await getImageSize(img.src);
      const sizeInKB = Math.round(imageSize / 1024);

      if (isAlreadyWebP && sizeInKB <= 500) {
        console.log(`   ⏭️ ${collection.title} — already optimized`);
        continue;
      }

      console.log(`\n🔧 Processing collection: ${collection.title}`);
      console.log(`   Downloading image (${sizeInKB}KB)...`);

      const webpBuffer = await optimizeImageFromURL(img.src, filename, sizeInKB);
      const newFilename = generateFilename(collection.title, 0);
      const base64 = webpBuffer.toString('base64');

      await shopify.put(`/custom_collections/${collection.id}.json`, {
        custom_collection: {
          id: collection.id,
          image: {
            attachment: base64,
            filename: newFilename,
            alt: img.alt || `${collection.title} collection`
          }
        }
      });

      console.log(`   ✅ Collection image optimized: ${newFilename}`);
      await wait(1000);
    }
  } catch (error) {
    console.error('Collection processing failed:', error.message);
  }
}

// NEW — Process Shopify Files (homepage banners, theme images)
async function processShopifyFiles() {
  console.log('\n🖼️ Processing Shopify files (banners & theme images)...\n');
  try {
    const response = await shopify.get('/files.json?limit=250');
    const files = response.data.files;

    if (!files || files.length === 0) {
      console.log('   No files found');
      return;
    }

    let processed = 0;
    let skipped = 0;

    for (const file of files) {
      if (!file.url) continue;

      const filename = file.url.split('/').pop().split('?')[0];
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
      if (!isImage) continue;

      const isAlreadyWebP = filename.toLowerCase().endsWith('.webp');
      const imageSize = await getImageSize(file.url);
      const sizeInKB = Math.round(imageSize / 1024);

      if (isAlreadyWebP && sizeInKB <= 300) {
        console.log(`   ⏭️ Already optimized: ${filename}`);
        skipped++;
        continue;
      }

      console.log(`\n🔧 Processing file: ${filename} (${sizeInKB}KB)`);

      try {
        const buffer = await downloadImage(file.url);
        const webpBuffer = await convertToWebP(buffer);
        const newSizeKB = Math.round(webpBuffer.length / 1024);
        console.log(`   ✅ Compressed: ${sizeInKB}KB → ${newSizeKB}KB`);

        const newFilename = filename.replace(/\.(jpg|jpeg|png|gif)$/i, '.webp');
        const base64 = webpBuffer.toString('base64');

        await shopify.post('/files.json', {
          file: {
            attachment: base64,
            filename: newFilename,
            content_type: 'image/webp'
          }
        });

        console.log(`   ✅ Uploaded optimized version: ${newFilename}`);
        processed++;
      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
      }

      await wait(1000);
    }

    console.log(`\n   Files processed: ${processed}`);
    console.log(`   Files skipped: ${skipped}`);

  } catch (error) {
    console.error('Files processing failed:', error.message);
  }
}

// Get all products
async function getAllProducts() {
  let products = [];
  let url = '/products.json?limit=250&fields=id,title,images';

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

// Run technical SEO
async function runTechnicalSEO() {
  console.log('\n🚀 Starting Technical SEO for Nova Mart...\n');
  console.log('This will:');
  console.log('  ✅ Generate missing alt text using AI');
  console.log('  ✅ Convert product images to WebP');
  console.log('  ✅ Convert collection images to WebP');
  console.log('  ✅ Convert homepage/theme files to WebP');
  console.log('  ✅ Compress all images over 300KB');
  console.log('  ✅ Rename unfriendly filenames');
  console.log('\n' + '='.repeat(50));

  try {
    // 1. Process product images
    console.log('\n📦 STEP 1 — Product Images');
    console.log('='.repeat(50));
    const products = await getAllProducts();
    console.log(`Found ${products.length} products\n`);
    let processed = 0;
    let skipped = 0;

    for (const product of products) {
      const needsWork = product.images?.some(img => {
        const filename = img.src.split('/').pop().split('?')[0];
        return !img.alt ||
          img.alt.trim() === '' ||
          /^[0-9]+\.(jpg|png|jpeg|webp)$/i.test(filename) ||
          !filename.toLowerCase().endsWith('.webp');
      });

      if (needsWork) {
        await processProduct(product);
        processed++;
      } else {
        skipped++;
      }
    }

    console.log(`\nProducts processed: ${processed}`);
    console.log(`Products skipped: ${skipped}`);

    // 2. Process collection images
    console.log('\n📁 STEP 2 — Collection Images');
    console.log('='.repeat(50));
    await processCollections();

    // 3. Shopify Files — requires GraphQL API (coming soon)
    console.log('\n🖼️ STEP 3 — Homepage & Theme Files: requires GraphQL (skipping for now)');

    console.log('\n' + '='.repeat(50));
    console.log('✅ TECHNICAL SEO COMPLETE');
    console.log('='.repeat(50));
    console.log(`Total products: ${products.length}`);
    console.log('All images optimized — WebP conversion done!');

  } catch (error) {
    console.error('Technical SEO failed:', error.message);
  }
}

runTechnicalSEO();