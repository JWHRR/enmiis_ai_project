/** Shared helpers for every provider adapter. */

/** A provider failure with a French message safe to show the user. */
export class GenerationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GenerationError';
    this.userMessage =
      options.userMessage || "Nous n'avons pas pu générer votre tenue.";
    this.status = options.status;
    this.detail = options.detail;
  }
}

export function toDataUri(image) {
  return `data:${image.mimeType};base64,${image.base64}`;
}

export async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Truncated provider payload, for server logs only. */
export function briefly(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readBody(response);

  if (!response.ok) {
    throw new GenerationError(
      `Provider responded ${response.status}: ${briefly(body)}`,
      { status: response.status, detail: body }
    );
  }
  return body;
}

/** Downloads a generated image URL and returns it inline, so the browser never talks to the provider. */
export async function fetchImageAsBase64(url, signal) {
  if (typeof url === 'string' && url.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
    if (match) return { mimeType: match[1], base64: match[2] };
  }

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new GenerationError(`Could not download generated image (${response.status}).`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim();
  return { mimeType, base64: buffer.toString('base64') };
}

/**
 * Polls `check` until it reports completion, the deadline passes, or the
 * request is aborted.
 * @param {() => Promise<{ done: boolean, value?: any }>} check
 */
export async function poll(check, { signal, timeoutMs, intervalMs = 2000, label = 'generation' }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new GenerationError(`${label} aborted.`);

    const result = await check();
    if (result.done) return result.value;

    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }

  throw new GenerationError(`${label} timed out.`, {
    userMessage:
      "La génération a pris trop de temps. Veuillez réessayer dans un instant.",
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Depth-first search for the first plausible image URL in an unknown response shape. */
export function findImageUrl(value, depth = 0) {
  if (depth > 6 || value == null) return null;

  if (typeof value === 'string') {
    return /^https?:\/\//.test(value) || value.startsWith('data:') ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'image', 'image_url', 'output', 'images', 'data']) {
      if (key in value) {
        const found = findImageUrl(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = findImageUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}
