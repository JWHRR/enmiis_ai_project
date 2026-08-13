import { GenerationError, briefly, fetchImageAsBase64, findImageUrl, poll, toDataUri } from './util.js';

const QUEUE = 'https://queue.fal.run';

/**
 * fal.ai — queue API. Works with any fal image-editing model that accepts
 * `prompt` + `image_urls` (nano-banana/edit, flux kontext multi, …).
 */
export async function generate({ person, pieces, prompt, config, signal }) {
  const imageUrls = [person, ...pieces].map(toDataUri);

  const submitted = await submit(config, { prompt, image_urls: imageUrls }, signal);

  const statusUrl = submitted.status_url;
  const responseUrl = submitted.response_url;

  if (!statusUrl || !responseUrl) {
    throw new GenerationError(`fal did not return a queue handle: ${briefly(submitted)}`);
  }

  await poll(
    async () => {
      const status = await getJson(statusUrl, config, signal);

      if (status.status === 'COMPLETED') return { done: true };
      if (status.status === 'FAILED' || status.error) {
        throw new GenerationError(`fal job failed: ${briefly(status)}`, { detail: status });
      }
      return { done: false };
    },
    { signal, timeoutMs: config.timeoutMs, label: 'fal generation' }
  );

  const result = await getJson(responseUrl, config, signal);
  const url = findImageUrl(result);

  if (!url) {
    throw new GenerationError(`fal returned no image: ${briefly(result)}`, { detail: result });
  }

  return fetchImageAsBase64(url, signal);
}

async function submit(config, input, signal) {
  const response = await fetch(`${QUEUE}/${config.model}`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${config.apiKey}`,
    },
    body: JSON.stringify({
      ...input,
      num_images: 1,
      output_format: 'png',
      aspect_ratio: config.aspectRatio,
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GenerationError(`fal responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }
  return body;
}

async function getJson(url, config, signal) {
  const response = await fetch(url, {
    signal,
    headers: { Authorization: `Key ${config.apiKey}` },
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GenerationError(`fal responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }
  return body;
}
