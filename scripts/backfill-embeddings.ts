#!/usr/bin/env tsx
/**
 * Backfill embeddings for existing memories that have embedding IS NULL.
 *
 * Usage:
 *   npx tsx scripts/backfill-embeddings.ts
 *
 * Processes in batches of 10. Idempotent — skips already-embedded memories.
 * Safe to interrupt and re-run.
 */

import { initDatabase, getUnembeddedMemories, updateMemoryEmbedding } from '../src/db.js';
import { generateEmbeddings } from '../src/embeddings.js';

const BATCH_SIZE = 10;

async function main(): Promise<void> {
  initDatabase();

  let totalProcessed = 0;
  let totalEmbedded = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = getUnembeddedMemories(BATCH_SIZE);
    if (batch.length === 0) break;

    totalProcessed += batch.length;
    console.log(`Processing batch of ${batch.length} memories (total processed: ${totalProcessed})`);

    const texts = batch.map((m) => m.content);
    const embeddings = await generateEmbeddings(texts);

    for (let i = 0; i < batch.length; i++) {
      const embedding = embeddings[i];
      if (embedding) {
        updateMemoryEmbedding(batch[i].id, embedding);
        totalEmbedded++;
      } else {
        console.warn(`  Skipped memory ${batch[i].id} — embedding generation returned null`);
      }
    }

    console.log(`  Embedded ${embeddings.filter(Boolean).length}/${batch.length} in this batch`);
  }

  console.log(`\nDone. Processed ${totalProcessed} memories, embedded ${totalEmbedded}.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
