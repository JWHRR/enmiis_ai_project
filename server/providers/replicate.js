import { GenerationError, briefly, fetchImageAsBase64, findImageUrl, poll, toDataUri } from './util.js';

const API = 'https://api.replicate.com/v1';

/**
 * Replicate. `config.model` is either `owner/name` or `owner/name:version`.
 * The array field carrying the reference images differs between models, so it
 * is configurable through AI_INPUT_IMAGES_KEY (default: image_input).
 */
export async function generate({ person, pieces, prompt, config, signal }) {
  const images = [person, ...pieces].map(toDataUri);

  const input = {
    prompt,
    [config.imagesKey]: images,
    output_format: 'png',
    aspect_ratio: config.aspectRatio,
  };

  let prediction = await create(config, input, signal);

  prediction = await poll(
    async () => {
      if (prediction.status === 'succeeded') return { done: true, value: prediction };

      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        throw new GenerationError(
          `Replicate prediction ${prediction.status}: ${briefly(prediction.error)}`,
          { detail: prediction }
        );
      }

      prediction = await getJson(`${API}/predictions/${prediction.id}`, config, signal);
      return prediction.status === 'succeeded'
        ? { done: true, value: prediction }
        : { done: false };
    },
    { signal, timeoutMs: config.timeoutMs, label: 'Replicate generation' }
  );

  const url = findImageUrl(prediction.output);
  if (!url) {
    throw new GenerationError(`Replicate returned no image: ${briefly(prediction.output)}`, {
      detail: prediction.output,
    });
  }

  return fetchImageAsBase64(url, signal);
}

async function create(config, input, signal) {
  const [modelPath, version] = config.model.split(':');

  const url = version ? `${API}/predictions` : `${API}/models/${modelPath}/predictions`;
  const payload = version ? { version, input } : { input };

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      // Ask Replicate to hold the connection briefly so fast models need no polling.
      Prefer: 'wait=60',
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GenerationError(`Replicate responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }
  return body;
}

async function getJson(url, config, signal) {
  const response = await fetch(url, {
    signal,
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GenerationError(`Replicate responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }
  return body;
}
