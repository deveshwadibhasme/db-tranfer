require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// Configuration
const SOURCE_URI = process.env.SOURCE_MONGODB_URI;
const TARGET_URI = process.env.TARGET_MONGODB_URI;
const DEFAULT_BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '500', 10);

if (!SOURCE_URI || !TARGET_URI) {
  console.error('[FATAL] SOURCE_MONGODB_URI and TARGET_MONGODB_URI must be set in .env');
  process.exit(1);
}

// CLI Flags
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isClean = args.includes('--clean') || args.includes('--drop');
const copyIndexes = args.includes('--copy-indexes');
const helpRequested = args.includes('--help') || args.includes('-h');

const batchSizeArgIndex = args.indexOf('--batch-size');
const BATCH_SIZE = batchSizeArgIndex !== -1 && args[batchSizeArgIndex + 1]
  ? parseInt(args[batchSizeArgIndex + 1], 10)
  : DEFAULT_BATCH_SIZE;

const onlyArgIndex = args.indexOf('--only');
const onlyCollectionOrModel = onlyArgIndex !== -1 && args[onlyArgIndex + 1]
  ? args[onlyArgIndex + 1].toLowerCase()
  : null;

function printHelp() {
  console.log(`
MongoDB Database Transfer CLI
=======================================
Transfers MongoDB documents from source cluster to target cluster.
Recursively detects models in nested folders under models/.

Usage:
  node transfer.js [options]
  npm start -- [options]

Options:
  --dry-run         Simulate transfer without writing to target database
  --clean, --drop   Drop/empty target collections before transferring
  --copy-indexes    Recreate source indexes on target collections
  --batch-size <n>  Number of documents per bulk write batch (default: 500)
  --only <name>     Transfer only one specific model or collection
  -h, --help        Show this help message

Environment Variables (in .env):
  SOURCE_MONGODB_URI   Source MongoDB connection string
  TARGET_MONGODB_URI   Target MongoDB connection string
  BATCH_SIZE           Default chunk size (default: 500)
`);
}

if (helpRequested) {
  printHelp();
  process.exit(0);
}

/*
// =====================================================================
// PRIORITY ORDER FUNCTION (COMMENTED OUT AS REQUESTED)
// =====================================================================
const PRIORITY_ORDER = {
  // Reference / Master data
  role: 10,
  roles: 10,
  user: 20,
  users: 20,
  // Availability was previously given priority 999
  availability: 999,
  availabilities: 999,
};

function getPriority(name) {
  const lower = name.toLowerCase();
  return PRIORITY_ORDER[lower] ?? 500;
}
// =====================================================================
*/

// Recursively find all .js model files in models/ and nested directories
function findModelFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findModelFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'index.js') {
      results.push(fullPath);
    }
  }
  return results;
}

// Discover and load all models in models/ (including nested subfolders)
function loadModels() {
  const modelsDir = path.join(__dirname, 'models');
  if (!fs.existsSync(modelsDir)) {
    throw new Error(`Models directory not found at: ${modelsDir}`);
  }

  const files = findModelFiles(modelsDir);
  const loadedModels = [];
  const seenCollections = new Set();

  for (const filePath of files) {
    const relativePath = path.relative(__dirname, filePath);
    try {
      const resolvedPath = path.resolve(filePath);
      const mod = require(resolvedPath);

      // Extract model: direct export, default export, or named export object
      let model = mod && mod.default ? mod.default : mod;

      // Handle named export objects, e.g. { Testimonial, TESTIMONIAL_CATEGORIES }
      if ((!model || !model.collection || !model.collection.name) && typeof mod === 'object' && mod !== null) {
        for (const key of Object.keys(mod)) {
          if (mod[key] && mod[key].collection && mod[key].collection.name) {
            model = mod[key];
            break;
          }
        }
      }

      if (model && model.collection && model.collection.name) {
        const collectionName = model.collection.name;
        // Avoid duplicate collections if multiple files reference the same model
        if (!seenCollections.has(collectionName)) {
          seenCollections.add(collectionName);
          loadedModels.push({
            modelName: model.modelName || path.basename(filePath, '.js'),
            collectionName: collectionName,
            schema: model.schema,
            model,
            file: relativePath,
          });
        }
      } else {
        console.warn(`[WARN] File ${relativePath} did not export a recognized Mongoose model.`);
      }
    } catch (err) {
      console.error(`[ERROR] Failed to load model file ${relativePath}:`, err.message);
    }
  }

  // Sort alphabetically by model name (priority function removed/commented out)
  loadedModels.sort((a, b) => a.modelName.localeCompare(b.modelName));
  return loadedModels;
}

// Get public IP for helpful troubleshooting if connection fails
async function fetchPublicIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    return data.ip;
  } catch {
    return 'Unknown (check https://whatismyipaddress.com)';
  }
}

// Transfer a single collection
async function transferCollection({
  srcDb,
  tgtDb,
  modelName,
  collectionName,
  isDryRun,
  isClean,
  copyIndexes,
  batchSize,
}) {
  const startTime = Date.now();
  const srcCol = srcDb.collection(collectionName);
  const tgtCol = tgtDb ? tgtDb.collection(collectionName) : null;

  const totalDocs = await srcCol.countDocuments();
  console.log(`\n=============================================================`);
  console.log(`Model: [${modelName}] | Collection: [${collectionName}]`);
  console.log(`Source count: ${totalDocs.toLocaleString()} document(s)`);

  if (totalDocs === 0) {
    console.log(`Status: Empty collection. Skipping.`);
    return { modelName, collectionName, total: 0, transferred: 0, skipped: 0, duration: '0.0s', status: 'EMPTY' };
  }

  if (isDryRun) {
    console.log(`[DRY-RUN] Would transfer ${totalDocs} document(s) in batches of ${batchSize}.`);
    return { modelName, collectionName, total: totalDocs, transferred: totalDocs, skipped: 0, duration: '0.0s', status: 'SIMULATED' };
  }

  // Handle clean/drop flag
  if (isClean && tgtDb) {
    const tgtExists = (await tgtDb.listCollections({ name: collectionName }).toArray()).length > 0;
    if (tgtExists) {
      const tgtCount = await tgtCol.countDocuments();
      if (tgtCount > 0) {
        console.log(`[CLEAN] Dropping target collection '${collectionName}' (${tgtCount} existing docs)...`);
        await tgtCol.drop();
      }
    }
  }

  // Copy indexes if requested
  if (copyIndexes && tgtCol) {
    try {
      const srcIndexes = await srcCol.indexes();
      for (const idx of srcIndexes) {
        if (idx.name === '_id_') continue;
        const options = { name: idx.name };
        if (idx.unique) options.unique = true;
        if (idx.sparse) options.sparse = true;
        if (idx.expireAfterSeconds !== undefined) options.expireAfterSeconds = idx.expireAfterSeconds;
        await tgtCol.createIndex(idx.key, options);
      }
      console.log(`[INDEXES] Synced indexes for ${collectionName}.`);
    } catch (idxErr) {
      console.warn(`[INDEX-WARN] Failed to sync indexes for ${collectionName}: ${idxErr.message}`);
    }
  }

  // Stream documents and bulk write
  const cursor = srcCol.find({}).batchSize(batchSize);
  let batch = [];
  let processed = 0;

  async function flushBatch() {
    if (batch.length === 0) return;
    const ops = batch.map(doc => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    }));
    await tgtCol.bulkWrite(ops, { ordered: false });
    processed += batch.length;
    const pct = ((processed / totalDocs) * 100).toFixed(1);
    process.stdout.write(`\rProgress: ${processed.toLocaleString()} / ${totalDocs.toLocaleString()} (${pct}%)`);
    batch = [];
  }

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    batch.push(doc);
    if (batch.length >= batchSize) {
      await flushBatch();
    }
  }
  if (batch.length > 0) {
    await flushBatch();
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nCompleted in ${durationSec}s`);
  return {
    modelName,
    collectionName,
    total: totalDocs,
    transferred: processed,
    skipped: 0,
    duration: `${durationSec}s`,
    status: 'DONE',
  };
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║               MongoDB Document Transfer Tool             ║
╚══════════════════════════════════════════════════════════╝
Batch Size: ${BATCH_SIZE}
Mode:       ${isDryRun ? 'DRY RUN (Read Only)' : isClean ? 'CLEAN & TRANSFER (Upsert after drop)' : 'SAFE UPSERT (Idempotent)'}
Indexes:    ${copyIndexes ? 'Recreate on Target' : 'Preserve Default'}
Filter:     ${onlyCollectionOrModel ? onlyCollectionOrModel : 'All Collections'}
`);

  // Load models from models/ directory recursively
  console.log('Discovering and loading models from ./models (including nested folders) ...');
  const models = loadModels();
  console.log(`Loaded ${models.length} model definitions.`);

  console.log('\nDiscovered Models & Collections:');
  models.forEach((m, i) => {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${m.modelName.padEnd(24)} -> ${m.collectionName.padEnd(24)} [${m.file}]`);
  });

  // Filter if --only flag was provided
  let targetModels = models;
  if (onlyCollectionOrModel) {
    targetModels = models.filter(
      m => m.modelName.toLowerCase() === onlyCollectionOrModel || m.collectionName.toLowerCase() === onlyCollectionOrModel
    );
    if (targetModels.length === 0) {
      console.error(`\n[ERROR] No model found matching '${onlyCollectionOrModel}'. Available models:`);
      models.forEach(m => console.log(` - ${m.modelName} (${m.collectionName})`));
      process.exit(1);
    }
    console.log(`\n[FILTER] Operating ONLY on: ${targetModels.map(m => m.modelName).join(', ')}`);
  }

  // Connect to Source Database
  console.log('\nConnecting to Source Database...');
  let srcConn;
  try {
    srcConn = await mongoose.createConnection(SOURCE_URI, {
      serverSelectionTimeoutMS: 15000,
    }).asPromise();
    console.log('Source Database connected successfully.');
  } catch (err) {
    console.error('\n[FATAL] Failed to connect to Source Database:', err.message);
    process.exit(1);
  }

  // Check for any unmapped collections in source DB
  const srcCollections = await srcConn.db.listCollections().toArray();
  const mappedCollectionNames = new Set(models.map(m => m.collectionName));
  const unmapped = srcCollections.filter(c => !mappedCollectionNames.has(c.name) && !c.name.startsWith('system.'));

  if (unmapped.length > 0 && !onlyCollectionOrModel) {
    console.log(`\nFound ${unmapped.length} additional collection(s) in source DB without a model file:`);
    for (const c of unmapped) {
      const count = await srcConn.db.collection(c.name).countDocuments();
      console.log(` - ${c.name}: ${count} document(s)`);
      targetModels.push({
        modelName: `(Raw) ${c.name}`,
        collectionName: c.name,
        schema: null,
        file: 'N/A',
      });
    }
  }

  // Connect to Target Database
  let tgtConn = null;
  if (isDryRun) {
    console.log('\n[DRY RUN] Skipping connection to Target Database.');
  } else {
    console.log('\nConnecting to Target Database...');
    try {
      tgtConn = await mongoose.createConnection(TARGET_URI, {
        serverSelectionTimeoutMS: 15000,
      }).asPromise();
      console.log('Target Database connected successfully.');
    } catch (err) {
      console.error('\n==============================================================');
      console.error('❌ [FATAL] Failed to connect to Target Database');
      console.error('==============================================================');
      console.error(`Error: ${err.message}`);

      const isWhitelistIssue =
        err.message.includes('whitelist') ||
        err.message.includes('alert internal error') ||
        err.message.includes('alert number 80') ||
        err.name === 'MongooseServerSelectionError';

      if (isWhitelistIssue) {
        const publicIP = await fetchPublicIP();
        console.error(`
Probable Cause: MongoDB Atlas Network Access (IP Whitelist)
Your machine's current public IP is: ${publicIP}

To fix this in MongoDB Atlas:
  1. Open MongoDB Atlas Console: https://cloud.mongodb.com
  2. Select the target project
  3. Go to "Security" -> "Network Access" in the left navigation
  4. Click "Add IP Address"
  5. Click "Add Current IP Address" (${publicIP}) or add "0.0.0.0/0" (Allow All)
  6. Wait ~30 seconds for Atlas to update, then run this script again!
==============================================================`);
      }

      if (srcConn) await srcConn.close();
      process.exit(1);
    }
  }

  // Execute transfer collection by collection
  const results = [];
  const overallStart = Date.now();

  try {
    for (const item of targetModels) {
      const res = await transferCollection({
        srcDb: srcConn.db,
        tgtDb: tgtConn ? tgtConn.db : null,
        modelName: item.modelName,
        collectionName: item.collectionName,
        isDryRun,
        isClean,
        copyIndexes,
        batchSize: BATCH_SIZE,
      });
      results.push(res);
    }
  } catch (transferErr) {
    console.error('\n[ERROR during transfer]:', transferErr);
  } finally {
    if (srcConn) await srcConn.close();
    if (tgtConn && typeof tgtConn.close === 'function') await tgtConn.close();
  }

  // Print Summary Table
  const overallDuration = ((Date.now() - overallStart) / 1000).toFixed(2);
  console.log(`\n\n═════════════════════════════════════════════════════════════════════`);
  console.log(`                      TRANSFER SUMMARY                               `);
  console.log(`═════════════════════════════════════════════════════════════════════`);
  console.log(`${'Model'.padEnd(24)} ${'Collection'.padEnd(24)} ${'Transferred'.padStart(12)} ${'Time'.padStart(8)}  Status`);
  console.log(`─────────────────────────────────────────────────────────────────────`);

  let grandTotal = 0;
  for (const r of results) {
    grandTotal += r.transferred;
    const countStr = `${r.transferred.toLocaleString()} / ${r.total.toLocaleString()}`;
    console.log(`${r.modelName.padEnd(24)} ${r.collectionName.padEnd(24)} ${countStr.padStart(12)} ${r.duration.padStart(8)}  ${r.status === 'DONE' ? '✓ DONE' : r.status}`);
  }
  console.log(`─────────────────────────────────────────────────────────────────────`);
  console.log(`Total Transferred: ${grandTotal.toLocaleString()} documents in ${overallDuration}s`);
  console.log(`═════════════════════════════════════════════════════════════════════\n`);
}

main().catch(err => {
  console.error('[UNEXPECTED ERROR]:', err);
  process.exit(1);
});
