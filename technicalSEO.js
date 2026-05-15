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

// Generate SEO friendly filename from product title
function generateFilename(productTitle, index) {
  return productTitle
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

// Process a single image
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
    // Generate alt text if missing
    let altText = img.alt;
    if (missingAlt) {
      console.log(`   Generating alt text...`);
      altText = await generateAltText(product.title, index);
      console.log(`   ✅ Alt text: ${altText?.slice(0, 50)}...`);
      await wait(2000);
    }

    // Check if image needs conversion
    const imageSize = await getImageSize(img.src);
    const sizeInKB = Math.round(imageSize / 1024);
    const needsConversion = !isAlreadyWebP || sizeInKB > 500 || isNumberFilename;

    if (needsConversion) {
      console.log(`   Downloading image (${sizeInKB}KB)...`);
      const buffer = await downloadImage(img.src);

      console.log(`   Converting to WebP...`);
      const webpBuffer = await convertToWebP(buffer);
      const newSizeKB = Math.round(webpBuffer.length / 1024);
      console.log(`   ✅ Compressed: ${sizeInKB}KB → ${newSizeKB}KB`);

      const newFilename = generateFilename(product.title, index);
      console.log(`   ✅ New filename: ${newFilename}`);

      // Upload new optimized image
      console.log(`   Uploading to Shopify...`);
      await uploadImageToShopify(
        product.id,
        webpBuffer,
        newFilename,
        altText || '',
        img.position
      );

      // Delete old image
      await deleteImage(product.id, img.id);
      console.log(`   ✅ Old image replaced with optimized WebP`);

    } else if (missingAlt && altText) {
      // Just update alt text if no conversion needed
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
  console.log(`\n🔧 Processing: ${product.title}`);

  if (!product.images || product.images.length === 0) {
    console.log('   No images found');
    return;
  }

  for (let i = 0; i < product.images.length; i++) {
    await processImage(product, product.images[i], i);
    await wait(1000);
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
  console.log('  ✅ Convert images to WebP format');
  console.log('  ✅ Compress images over 500KB');
  console.log('  ✅ Rename unfriendly filenames');
  console.log('\n' + '='.repeat(50));

  try {
    const products = await getAllProducts();
    console.log(`\nFound ${products.length} products\n`);

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

    console.log('\n' + '='.repeat(50));
    console.log('✅ TECHNICAL SEO COMPLETE');
    console.log('='.repeat(50));
    console.log(`Products processed: ${processed}`);
    console.log(`Products already optimized: ${skipped}`);
    console.log(`Total: ${products.length}`);

  } catch (error) {
    console.error('Technical SEO failed:', error.message);
  }
}

runTechnicalSEO();