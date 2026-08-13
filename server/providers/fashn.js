import { GenerationError, briefly, fetchImageAsBase64, findImageUrl, poll, toDataUri } from './util.js';

const API = 'https://api.fashn.ai/v1';

/**
 * FASHN virtual try-on.
 *
 * FASHN is a true VTON model: it dresses one model image with one garment
 * image and takes no free-text prompt. The three outfit components are
 * therefore applied sequentially — the output of each pass becomes the model
 * image of the next — so the person is progressively dressed in all three.
 * Identity preservation and product fidelity come from the model itself here,
 * not from the internal prompt.
 */
export async function generate({ person, pieces, config, signal }) {
  let current = toDataUri(person);

  const categories = ['one-pieces', 'tops', 'auto'];

  for (let index = 0; index < pieces.length; index += 1) {
    const jobId = await submit(
      config,
      {
        model_image: current,
        garment_image: toDataUri(pieces[index]),
        category: categories[index] || 'auto',
        mode: 'quality',
        num_samples: 1,
      },
      signal
    );

    current = await waitForResult(config, jobId, signal, index + 1);
  }

  return fetchImageAsBase64(current, signal);
}

async function submit(config, inputs, signal) {
  const response = await fetch(`${API}/run`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model_name: config.model, inputs }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.id) {
    throw new GenerationError(`FASHN responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }
  return body.id;
}

async function waitForResult(config, jobId, signal, pass) {
  return poll(
    async () => {
      const response = await fetch(`${API}/status/${jobId}`, {
        signal,
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new GenerationError(`FASHN responded ${response.status}: ${briefly(body)}`, {
          status: response.status,
          detail: body,
        });
      }

      if (body.status === 'completed') {
        const url = findImageUrl(body.output);
        if (!url) {
          throw new GenerationError(`FASHN pass ${pass} returned no image: ${briefly(body)}`);
        }
        return { done: true, value: url };
      }

      if (body.status === 'failed') {
        throw new GenerationError(`FASHN pass ${pass} failed: ${briefly(body.error)}`, {
          detail: body,
        });
      }

      return { done: false };
    },
    { signal, timeoutMs: config.timeoutMs, label: `FASHN pass ${pass}` }
  );
}
