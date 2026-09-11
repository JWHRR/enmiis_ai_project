import { config } from './config.js';
import { buildGenerationPrompt, referenceLabels } from './prompt.js';
import { GenerationError } from './providers/util.js';

import * as demo from './providers/demo.js';
import * as hf from './providers/huggingface.js';
import * as gemini from './providers/gemini.js';
import * as fal from './providers/fal.js';
import * as replicate from './providers/replicate.js';
import * as fashn from './providers/fashn.js';
import * as openai from './providers/openai.js';

/**
 * Provider registry. Every adapter exposes the same `generate()` signature, so
 * swapping or reordering providers is a configuration change, not a code change.
 */
const PROVIDERS = { demo, hf, gemini, fal, replicate, fashn, openai };

/**
 * The single abstraction the rest of the application talks to.
 *
 * Providers are attempted in `config.chain` order. A failure — API error,
 * timeout, quota, unavailable model, network fault, unusable response — moves
 * on to the next provider automatically; the caller only sees an error when
 * every provider in the chain has failed.
 *
 * @param {{ person: Image, pieces: Image[] }} references
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<GenerationResult>}
 *
 * @typedef {{ base64: string, mimeType: string }} Image
 * @typedef {{ base64: string, mimeType: string, demo: boolean, provider: string,
 *             model?: string, attempts: string[], durationMs: number }} GenerationResult
 */
export async function generateVirtualOutfit(references, options = {}) {
  const startedAt = Date.now();
  const referenceCount = references.pieces.length + 1;

  const prompt = buildGenerationPrompt({
    referenceCount,
    aspectRatio: config.aspectRatio,
  });

  if (config.debugPrompt) {
    console.log('\n--- internal generation prompt ---\n%s\n---\n', prompt);
  }

  const labels = referenceLabels(referenceCount);
  const attempts = [];
  const GENERIC = "Nous n'avons pas pu générer votre tenue.";
  // A provider may know something worth telling the user — a safety refusal,
  // for instance. Keep the most recent specific message so it is not lost
  // behind the chain's generic failure.
  let specificMessage = null;

  for (const name of config.chain) {
    const provider = PROVIDERS[name];
    const settings = config.providers[name];

    if (!provider || !settings?.configured) {
      attempts.push(`${name}: not configured`);
      continue;
    }

    // The budget is enforced here rather than inside each adapter, so a
    // provider that stops responding can never hold the request open.
    const signals = [AbortSignal.timeout(settings.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);

    const attemptStart = Date.now();

    try {
      // The prompt is a backend asset: it is handed to the provider and never
      // returned to the caller.
      const result = await provider.generate({
        person: references.person,
        pieces: references.pieces,
        prompt,
        labels,
        config: settings,
        signal,
      });

      if (!result?.base64) throw new GenerationError(`${name} returned an empty result.`);

      console.log(
        `[generate] ${name} succeeded in ${Date.now() - attemptStart}ms` +
          (result.meta?.model ? ` (${result.meta.model} via ${result.meta.surface})` : '')
      );

      return {
        base64: result.base64,
        mimeType: result.mimeType || 'image/png',
        demo: Boolean(result.demo) || name === 'demo',
        provider: name,
        model: result.meta?.model || settings.model,
        meta: result.meta || null,
        attempts,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      // The browser went away — stop, do not burn the rest of the chain.
      if (options.signal?.aborted) throw error;

      const timedOut = signal.aborted;
      const reason = timedOut ? `timed out after ${settings.timeoutMs}ms` : error.message;

      if (!timedOut && error.userMessage && error.userMessage !== GENERIC) {
        specificMessage = error.userMessage;
      }

      attempts.push(`${name}: ${reason}`);
      console.warn(`[generate] ${name} failed (${Date.now() - attemptStart}ms): ${reason}`);
    }
  }

  throw new GenerationError(`All providers failed:\n  ${attempts.join('\n  ')}`, {
    userMessage: specificMessage || GENERIC,
    detail: attempts,
  });
}

export { GenerationError };
