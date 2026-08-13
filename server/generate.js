import { config } from './config.js';
import { buildGenerationPrompt, referenceLabels } from './prompt.js';
import { GenerationError } from './providers/util.js';

import * as demo from './providers/demo.js';
import * as gemini from './providers/gemini.js';
import * as fal from './providers/fal.js';
import * as replicate from './providers/replicate.js';
import * as fashn from './providers/fashn.js';
import * as openai from './providers/openai.js';

/**
 * Provider registry. Every adapter exposes the same `generate()` signature, so
 * swapping providers is a configuration change, not a code change.
 */
const PROVIDERS = { demo, gemini, fal, replicate, fashn, openai };

/**
 * The single abstraction the rest of the application talks to.
 *
 * @param {{ person: Image, pieces: Image[] }} references
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ base64: string, mimeType: string, demo: boolean, provider: string, durationMs: number }>}
 *
 * @typedef {{ base64: string, mimeType: string }} Image
 */
export async function generateVirtualOutfit(references, options = {}) {
  const provider = PROVIDERS[config.provider] || PROVIDERS.demo;
  const startedAt = Date.now();

  const prompt = buildGenerationPrompt({
    pieceCount: references.pieces.length,
    aspectRatio: config.aspectRatio,
  });

  if (config.debugPrompt) {
    console.log('\n--- internal generation prompt ---\n%s\n---\n', prompt);
  }

  // The generation budget is enforced here rather than inside each adapter, so
  // a provider that stops responding can never hold the request open.
  const signals = [AbortSignal.timeout(config.timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  let result;
  try {
    // The prompt is a backend asset: it is passed to the provider and never
    // returned to the caller.
    result = await provider.generate({
      person: references.person,
      pieces: references.pieces,
      prompt,
      labels: referenceLabels(references.pieces.length),
      config,
      signal,
    });
  } catch (error) {
    // The budget ran out, rather than the browser going away.
    if (signal.aborted && !options.signal?.aborted) {
      throw new GenerationError(`Provider "${config.provider}" timed out.`, {
        userMessage: 'La génération a pris trop de temps. Veuillez réessayer dans un instant.',
      });
    }
    throw error;
  }

  if (!result?.base64) {
    throw new GenerationError(`Provider "${config.provider}" returned an empty result.`);
  }

  return {
    base64: result.base64,
    mimeType: result.mimeType || 'image/png',
    demo: Boolean(result.demo) || config.isDemo,
    provider: config.provider,
    durationMs: Date.now() - startedAt,
  };
}

export { GenerationError };
