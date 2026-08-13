import { GenerationError, briefly } from './util.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Google Gemini image models (multi-reference image editing).
 * Each reference image is preceded by a caption part so the model knows which
 * image carries the identity and which ones carry the product truth.
 */
export async function generate({ person, pieces, prompt, labels, config, signal }) {
  const parts = [{ text: prompt }, { text: labels.person }];

  parts.push({ inline_data: { mime_type: person.mimeType, data: person.base64 } });

  pieces.forEach((piece, index) => {
    parts.push({ text: labels.pieces[index] });
    parts.push({ inline_data: { mime_type: piece.mimeType, data: piece.base64 } });
  });

  const url = `${ENDPOINT}/${encodeURIComponent(config.model)}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        temperature: 0.25,
      },
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GenerationError(`Gemini responded ${response.status}: ${briefly(body)}`, {
      status: response.status,
      detail: body,
    });
  }

  const candidate = body?.candidates?.[0];
  const image = candidate?.content?.parts?.find((part) => part.inlineData || part.inline_data);

  if (!image) {
    const blocked = body?.promptFeedback?.blockReason || candidate?.finishReason;
    throw new GenerationError(`Gemini returned no image (${blocked || 'unknown reason'}).`, {
      userMessage:
        blocked === 'SAFETY' || blocked === 'IMAGE_SAFETY'
          ? "La génération a été refusée par le service d'image. Essayez avec une autre photo."
          : undefined,
      detail: body,
    });
  }

  const inline = image.inlineData || image.inline_data;
  return {
    base64: inline.data,
    mimeType: inline.mimeType || inline.mime_type || 'image/png',
  };
}
