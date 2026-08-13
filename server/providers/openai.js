import { GenerationError, briefly } from './util.js';

const ENDPOINT = 'https://api.openai.com/v1/images/edits';

/**
 * OpenAI image editing. The endpoint is multipart/form-data; the body is
 * assembled by hand so the project keeps zero runtime dependencies.
 */
export async function generate({ person, pieces, prompt, config, signal }) {
  const form = new FormData();

  form.append('model', config.model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', aspectToSize(config.aspectRatio));
  form.append('quality', 'high');

  appendImage(form, 'image[]', person, 'person');
  pieces.forEach((piece, index) => appendImage(form, 'image[]', piece, `piece-${index + 1}`));

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    signal,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GenerationError(`OpenAI responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }

  const image = body?.data?.[0];
  if (!image?.b64_json) {
    throw new GenerationError(`OpenAI returned no image: ${briefly(body)}`, { detail: body });
  }

  return { base64: image.b64_json, mimeType: 'image/png' };
}

function appendImage(form, field, image, name) {
  const bytes = Buffer.from(image.base64, 'base64');
  const extension = image.mimeType.split('/')[1] || 'png';

  form.append(
    field,
    new Blob([bytes], { type: image.mimeType }),
    `${name}.${extension}`
  );
}

function aspectToSize(aspectRatio) {
  // The endpoint accepts a fixed set of sizes; map the configured ratio onto it.
  const [w, h] = String(aspectRatio).split(':').map(Number);
  if (!w || !h) return '1024x1536';
  if (w === h) return '1024x1024';
  return w > h ? '1536x1024' : '1024x1536';
}
