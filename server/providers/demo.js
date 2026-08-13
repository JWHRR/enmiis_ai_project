import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { sleep } from './util.js';

const DEMO_ASSET = path.join(config.publicDir, 'demo', 'demo-result.svg');

/**
 * Demo mode. No AI provider is configured, so no generation happens at all:
 * a fixed demonstration asset is returned so the complete experience can be
 * reviewed. The response is flagged `demo: true` and the interface says so —
 * this result is never presented as having been made from the user's images.
 */
export async function generate({ signal }) {
  // A short, deliberate pause so the loading experience can be evaluated.
  await sleep(4200);
  if (signal?.aborted) throw new Error('aborted');

  const svg = await fs.readFile(DEMO_ASSET);

  return {
    base64: svg.toString('base64'),
    mimeType: 'image/svg+xml',
    demo: true,
  };
}
