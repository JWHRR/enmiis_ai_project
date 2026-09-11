import { config as appConfig } from '../server/config.js';
import { validateRequest, ValidationError } from '../server/validate.js';
import { generateVirtualOutfit } from '../server/generate.js';
import { GenerationError } from '../server/providers/util.js';

/**
 * Vercel route configuration. 60s is the Hobby-plan ceiling; Pro allows up to
 * 300. Image generation routinely takes 10-40s, so this is the binding limit.
 */
export const config = { maxDuration: 60 };

/** Vercel parses JSON bodies itself, but keep a fallback for raw invocations. */
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * POST /api/generate — Vercel serverless entry point.
 *
 * Identical contract to the standalone server: it returns
 * `{ image, mimeType, demo, meta, identityPreserved, warning }` on success and
 * `{ error }` with a French message on failure.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    res.status(400).json({ error: 'La requête est invalide. Veuillez recharger la page.' });
    return;
  }

  let references;
  try {
    references = validateRequest(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(422).json({ error: error.userMessage, field: error.field });
      return;
    }
    throw error;
  }

  try {
    const result = await generateVirtualOutfit(references);
    const identityPreserved = result.meta ? result.meta.identityPreserved !== false : true;

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      image: `data:${result.mimeType};base64,${result.base64}`,
      mimeType: result.mimeType,
      demo: result.demo,
      durationMs: result.durationMs,
      meta: result.meta || null,
      identityPreserved,
      warning: identityPreserved
        ? null
        : 'Ce rendu a été créé par un modèle qui ne peut pas utiliser vos photos : ' +
          'le visage et la tenue sont inventés et ne correspondent pas à vos références.',
    });
  } catch (error) {
    // Full detail stays in the function log; the browser gets a usable message.
    console.error('[generate] failed:', error?.message || error);

    res.status(502).json({
      error:
        error instanceof GenerationError && error.userMessage
          ? error.userMessage
          : "Nous n'avons pas pu générer votre tenue.",
      ...(appConfig.verbose ? { detail: error?.detail || error?.message } : {}),
    });
  }
}
