import { GenerationError, briefly, fetchImageAsBase64 } from './util.js';

/**
 * Hugging Face Inference Providers.
 *
 * HF is a router in front of third-party GPU providers, so each model is
 * reached through the provider that actually serves it. Two request shapes
 * cover everything this app needs:
 *
 *   image-to-image  POST /{provider}/{providerId}            {prompt, image_url(s)}
 *   text-to-image   POST /{provider}/v1/images/generations   (OpenAI-shaped)
 *
 * Model kind matters enormously here:
 *
 *   `edit` models receive the uploaded references and can put the real
 *   garments on the real person. This is what the product promises.
 *
 *   `text-to-image` models (FLUX.1-dev / FLUX.1-schnell) receive NO images.
 *   They invent a person from the prompt alone. They are supported because
 *   they were explicitly requested, but they cannot preserve identity, so a
 *   result from one is flagged `identityPreserved: false` and the interface
 *   warns that the face is not the uploaded person.
 */

/** Verified live on the HF router. `max` is how many references the model accepts. */
const MODEL_LADDER = [
  {
    id: 'Qwen/Qwen-Image-Edit-2509',
    provider: 'fal-ai',
    providerId: 'fal-ai/qwen-image-edit-2509',
    kind: 'edit',
    max: 3,
  },
  {
    id: 'black-forest-labs/FLUX.1-Kontext-dev',
    provider: 'fal-ai',
    providerId: 'fal-ai/flux-kontext/dev',
    kind: 'edit',
    max: 1,
  },
  {
    id: 'black-forest-labs/FLUX.1-Kontext-dev',
    provider: 'replicate',
    providerId: 'black-forest-labs/flux-kontext-dev',
    kind: 'edit',
    max: 1,
  },
  {
    id: 'black-forest-labs/FLUX.1-schnell',
    provider: 'nscale',
    kind: 'text-to-image',
    max: 0,
  },
  {
    id: 'black-forest-labs/FLUX.1-dev',
    provider: 'fal-ai',
    kind: 'text-to-image',
    max: 0,
  },
];

const ROUTER = 'https://router.huggingface.co';

/** Maps an HTTP status onto a French message the user can act on. */
function explain(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');

  if (status === 401 || status === 403) {
    return {
      user: 'Le service de génération a refusé nos identifiants. Veuillez réessayer plus tard.',
      log: 'HF token rejected — HF_TOKEN needs the "inference.serverless.write" scope.',
      fatal: true,
    };
  }
  if (status === 402) {
    return {
      user: 'Le service de génération est momentanément indisponible. Veuillez réessayer plus tard.',
      log:
        'HF credits exhausted for this provider (402). Add pre-paid credits or ' +
        'upgrade to PRO: https://huggingface.co/settings/billing',
      // Not fatal: HF prices each upstream provider separately, so a balance
      // that cannot cover this model may still cover a cheaper one further
      // down the ladder.
    };
  }
  if (status === 429) {
    return {
      user: 'Le service est très sollicité. Veuillez réessayer dans quelques instants.',
      log: 'HF rate limited (429).',
    };
  }
  if (status === 400 || status === 422) {
    return {
      user: "Nous n'avons pas pu traiter ces images. Essayez avec d'autres références.",
      log: `HF rejected the request (${status}): ${briefly(text, 200)}`,
    };
  }
  if (status === 503) {
    return {
      user: 'Le modèle démarre. Veuillez réessayer dans un instant.',
      log: 'HF model loading (503).',
    };
  }
  return { log: `HF ${status}: ${briefly(text, 200)}` };
}

async function call(url, token, payload, signal) {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { ok: response.ok, status: response.status, body };
}

/** Text-to-image models get a short prompt: long ones are truncated by the text encoder. */
function compactPrompt() {
  return (
    'Professional graduation portrait photograph of one person wearing a complete ' +
    'academic graduation outfit: full gown, hood or stole over the shoulders, and a ' +
    'mortarboard cap with tassel. Photorealistic, natural skin texture, realistic fabric ' +
    'folds and shadows, plain uncluttered studio background, shot on a high-end camera.'
  );
}

async function runEdit(model, { images, prompt, token, signal }) {
  const used = images.slice(0, model.max);
  const dataUrls = used.map((image) => `data:${image.mimeType};base64,${image.base64}`);

  const url =
    model.provider === 'replicate'
      ? `${ROUTER}/replicate/v1/models/${model.providerId}/predictions`
      : `${ROUTER}/${model.provider}/${model.providerId}`;

  const request =
    model.provider === 'replicate'
      ? { input: { prompt, input_image: dataUrls[0] } }
      : model.max > 1
        ? { prompt, image_urls: dataUrls, num_images: 1 }
        : { prompt, image_url: dataUrls[0], num_images: 1 };

  const { ok, status, body } = await call(url, token, request, signal);
  if (!ok) return { ok: false, ...explain(status, body), status };

  // fal returns {images:[{url}]}; replicate returns {output: url | [url]}.
  const link =
    body?.images?.[0]?.url ||
    (typeof body?.output === 'string' ? body.output : body?.output?.[0]) ||
    null;

  if (!link) {
    return { ok: false, log: `HF ${model.id} returned no image: ${briefly(body, 200)}`, status };
  }

  const image = await fetchImageAsBase64(link, signal);
  return { ok: true, image, usedImages: used.length };
}

async function runTextToImage(model, { token, signal }) {
  const url = `${ROUTER}/${model.provider}/v1/images/generations`;

  const { ok, status, body } = await call(
    url,
    token,
    { model: model.id, prompt: compactPrompt(), response_format: 'b64_json', n: 1 },
    signal
  );
  if (!ok) return { ok: false, ...explain(status, body), status };

  const entry = body?.data?.[0];
  if (!entry?.b64_json && !entry?.url) {
    return { ok: false, log: `HF ${model.id} returned no image: ${briefly(body, 200)}`, status };
  }

  const image = entry.b64_json
    ? { base64: entry.b64_json, mimeType: 'image/png' }
    : await fetchImageAsBase64(entry.url, signal);

  return { ok: true, image, usedImages: 0 };
}

export async function generate({ person, pieces, prompt, config: settings, signal }) {
  const images = [person, ...pieces];
  const token = settings.apiKey;

  if (!token) {
    throw new GenerationError('HF_TOKEN is not set.', {
      userMessage: "Le service de génération n'est pas configuré.",
    });
  }

  const failures = [];
  let userMessage;

  for (const model of settings.ladder) {
    const label = `${model.id} via ${model.provider}`;
    const startedAt = Date.now();

    try {
      const result =
        model.kind === 'edit'
          ? await runEdit(model, { images, prompt, token, signal })
          : await runTextToImage(model, { token, signal });

      if (result.ok) {
        if (settings.verbose) {
          console.log(
            `[hf] ${label} → ${result.image.mimeType}, ` +
              `${result.usedImages}/${images.length} references used, ${Date.now() - startedAt}ms`
          );
        }
        return {
          ...result.image,
          meta: {
            model: model.id,
            surface: model.provider,
            kind: model.kind,
            referencesUsed: result.usedImages,
            identityPreserved: model.kind === 'edit',
          },
        };
      }

      failures.push(`${label}: ${result.log}`);
      if (result.user) userMessage = result.user;
      if (settings.verbose) console.warn(`[hf] ${label} failed: ${result.log}`);

      // A bad token or an empty balance will not fix itself further down the ladder.
      if (result.fatal) break;
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push(`${label}: ${error.message}`);
      if (settings.verbose) console.warn(`[hf] ${label} threw: ${error.message}`);
    }
  }

  throw new GenerationError(`Hugging Face failed:\n  ${failures.join('\n  ')}`, {
    userMessage,
    detail: failures,
  });
}

export { MODEL_LADDER };
