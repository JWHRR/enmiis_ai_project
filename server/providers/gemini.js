import { GenerationError, briefly } from './util.js';

/**
 * Google Gemini native image generation (Nano Banana).
 *
 * Two API surfaces are supported, because Google moved image generation to the
 * Interactions API while `:generateContent` remains available:
 *
 *   1. POST /v1beta/interactions            — current surface, tried first
 *   2. POST /v1beta/models/{model}:generateContent — legacy surface, fallback
 *
 * The adapter also walks a ladder of models (Nano Banana 2 → Pro → Nano Banana)
 * so a key that has not been granted the newest model still produces an image.
 */

/** Errors that mean "this model is not usable for this key" — try the next one. */
function isModelUnavailable(status, body) {
  if (status === 404) return true;
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  return /not found|not supported|does not exist|unsupported model|NOT_FOUND|permission/i.test(text);
}

/** Errors that mean "this request shape was rejected" — retry without extras. */
function isBadConfig(status, body) {
  if (status !== 400) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  return /unknown name|invalid json payload|cannot find field|unexpected|invalid argument/i.test(text);
}

function isSafetyBlock(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  return /SAFETY|IMAGE_SAFETY|PROHIBITED_CONTENT|blocked/i.test(text);
}

/**
 * Walks an unknown response shape looking for inline base64 image bytes.
 * Written defensively so a field rename on Google's side does not break us.
 */
export function findInlineImage(value, depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInlineImage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const mime = value.mime_type || value.mimeType;
  const data = typeof value.data === 'string' ? value.data : null;

  // A base64 image block: has data, and either an image mime type or no mime
  // type at all inside a field that is clearly an image.
  if (data && data.length > 128 && (!mime || String(mime).startsWith('image/'))) {
    if (mime || value.type === 'image') {
      return { base64: data, mimeType: mime || 'image/png' };
    }
  }

  const inline = value.inlineData || value.inline_data;
  if (inline) {
    const found = findInlineImage(inline, depth + 1);
    if (found) return found;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'inlineData' || key === 'inline_data') continue;
    const found = findInlineImage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

async function post(url, apiKey, payload, signal) {
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
}

/** Interactions API — the current surface for Nano Banana models. */
function interactionsPayload({ model, prompt, images, labels, settings, withFormat }) {
  const input = [{ type: 'text', text: prompt }];

  images.forEach((image, index) => {
    input.push({ type: 'text', text: labels[index] });
    input.push({ type: 'image', mime_type: image.mimeType, data: image.base64 });
  });

  const payload = { model, input };

  if (withFormat) {
    payload.response_format = {
      type: 'image',
      aspect_ratio: settings.aspectRatio,
      image_size: settings.imageSize,
    };
  }
  return payload;
}

/** Legacy :generateContent surface. */
function generateContentPayload({ prompt, images, labels, settings, withFormat }) {
  const parts = [{ text: prompt }];

  images.forEach((image, index) => {
    parts.push({ text: labels[index] });
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.base64 } });
  });

  const payload = { contents: [{ role: 'user', parts }] };

  if (withFormat) {
    payload.generationConfig = {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: settings.aspectRatio },
    };
  }
  return payload;
}

async function attempt({ url, apiKey, payload, signal, surface, model }) {
  const { status, ok, body } = await post(url, apiKey, payload, signal);

  if (!ok) {
    return {
      ok: false,
      status,
      body,
      retryWithoutFormat: isBadConfig(status, body),
      nextModel: isModelUnavailable(status, body),
      message: `${surface} ${model} → ${status}: ${briefly(body, 240)}`,
    };
  }

  const image = findInlineImage(body);
  if (!image) {
    return {
      ok: false,
      status,
      body,
      nextModel: false,
      safety: isSafetyBlock(body),
      message: `${surface} ${model} returned no image: ${briefly(body, 240)}`,
    };
  }

  return { ok: true, image };
}

export async function generate({ person, pieces, prompt, labels, config: settings, signal }) {
  const images = [person, ...pieces];
  const captions = labels?.all || images.map((_, i) => `IMAGE ${i + 1}`);
  const models = settings.models?.length ? settings.models : [settings.model];

  const failures = [];
  let sawSafetyBlock = false;

  for (const model of models) {
    const surfaces = [
      {
        name: 'interactions',
        url: `${settings.apiBase}/interactions`,
        build: (withFormat) =>
          interactionsPayload({ model, prompt, images, labels: captions, settings, withFormat }),
      },
      {
        name: 'generateContent',
        url: `${settings.apiBase}/models/${encodeURIComponent(model)}:generateContent`,
        build: (withFormat) =>
          generateContentPayload({ prompt, images, labels: captions, settings, withFormat }),
      },
    ];

    for (const surface of surfaces) {
      for (const withFormat of [true, false]) {
        const result = await attempt({
          url: surface.url,
          apiKey: settings.apiKey,
          payload: surface.build(withFormat),
          signal,
          surface: surface.name,
          model,
        });

        if (result.ok) {
          return { ...result.image, meta: { model, surface: surface.name } };
        }

        failures.push(result.message);
        if (result.safety) sawSafetyBlock = true;

        // Only the "unknown field" case is worth retrying without the
        // optional response-format block.
        if (!result.retryWithoutFormat) break;
      }
    }
    // Both surfaces are always tried before moving down the model ladder: a
    // 404 can mean "this model is unknown" or "this API surface is not
    // enabled for this project", and the two are not reliably separable.
  }

  throw new GenerationError(`Gemini failed:\n  ${failures.join('\n  ')}`, {
    userMessage: sawSafetyBlock
      ? "La génération a été refusée par le service d'image. Essayez avec une autre photo."
      : undefined,
    detail: failures,
  });
}
