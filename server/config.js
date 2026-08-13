import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader (no dependency). Values already present in the real
 * environment always win, so hosting platforms keep control.
 */
function loadDotEnv() {
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;

  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const env = (name) => (process.env[name] || '').trim();

/** Credential env vars accepted for each provider, in priority order. */
const PROVIDER_KEYS = {
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY'],
  fal: ['FAL_KEY', 'FAL_API_KEY'],
  replicate: ['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY'],
  fashn: ['FASHN_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  demo: [],
};

const DEFAULT_MODELS = {
  gemini: 'gemini-3.1-flash-image',
  fal: 'fal-ai/nano-banana/edit',
  replicate: 'google/nano-banana',
  fashn: 'tryon-v1.6',
  openai: 'gpt-image-1',
  demo: 'demo',
};

/**
 * Gemini image models in preference order — Nano Banana 2 first, then the
 * Pro tier, then the previous Nano Banana. The adapter walks this list when a
 * model is unavailable to the caller's key, so a project that has not been
 * granted the newest model still generates.
 */
const GEMINI_MODEL_LADDER = [
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-lite-image',
];

const KNOWN_PROVIDERS = Object.keys(PROVIDER_KEYS);

const primaryProvider = (env('AI_PROVIDER') || 'gemini').toLowerCase();

/** The generic key applies to the primary provider only, as a convenience. */
const genericKey = env('AI_API_KEY');

function credentialFor(name) {
  for (const variable of PROVIDER_KEYS[name] || []) {
    const value = env(variable);
    if (value) return value;
  }
  if (name === primaryProvider && genericKey) return genericKey;
  return '';
}

function modelFor(name) {
  if (name === 'gemini') return env('GEMINI_IMAGE_MODEL') || env('AI_MODEL') || DEFAULT_MODELS.gemini;
  if (name === primaryProvider && env('AI_MODEL')) return env('AI_MODEL');
  return DEFAULT_MODELS[name];
}

const aspectRatio = env('AI_ASPECT_RATIO') || '3:4';
const timeoutMs = Number(env('AI_TIMEOUT_MS')) || 180000;

/** Per-provider settings handed to the adapters. */
const providers = Object.fromEntries(
  KNOWN_PROVIDERS.map((name) => {
    const apiKey = credentialFor(name);
    const model = modelFor(name);

    const settings = {
      name,
      apiKey,
      model,
      configured: name === 'demo' ? true : Boolean(apiKey),
      aspectRatio,
      timeoutMs,
    };

    if (name === 'gemini') {
      // Configured model first, then the rest of the ladder as fallbacks.
      settings.models = [model, ...GEMINI_MODEL_LADDER.filter((m) => m !== model)];
      settings.apiBase = env('GEMINI_API_BASE') || 'https://generativelanguage.googleapis.com/v1beta';
      settings.imageSize = env('GEMINI_IMAGE_SIZE') || '2K';
    }
    if (name === 'replicate') {
      settings.imagesKey = env('AI_INPUT_IMAGES_KEY') || 'image_input';
    }

    return [name, settings];
  })
);

/**
 * The ordered list of providers to attempt. An explicit AI_PROVIDER_CHAIN wins;
 * otherwise the primary provider leads and every other configured provider
 * follows as an automatic fallback.
 */
function buildChain() {
  const explicit = env('AI_PROVIDER_CHAIN')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const requested = explicit.length
    ? explicit
    : [primaryProvider, ...KNOWN_PROVIDERS.filter((n) => n !== primaryProvider && n !== 'demo')];

  const chain = requested.filter(
    (name, index) =>
      KNOWN_PROVIDERS.includes(name) &&
      providers[name].configured &&
      requested.indexOf(name) === index
  );

  // Demo is a last resort: it only runs when nothing real is available.
  const real = chain.filter((name) => name !== 'demo');
  return real.length ? real : ['demo'];
}

const chain = buildChain();
const isDemo = chain.length === 1 && chain[0] === 'demo';

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  port: Number(env('PORT')) || 3000,

  primaryProvider,
  providers,
  chain,
  isDemo,

  /** A provider was asked for but has no usable credential. */
  misconfigured: !isDemo
    ? false
    : primaryProvider !== 'demo' && !providers[primaryProvider]?.configured,

  aspectRatio,
  timeoutMs,
  debugPrompt: env('DEBUG_PROMPT') === '1',

  // Technical and security limits only. Image quality is never a reason to
  // block a generation — the model is expected to cope with imperfect input.
  limits: {
    maxImageBytes: 20 * 1024 * 1024,
    maxRequestBytes: 60 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
};

/** Public, key-free description of the runtime for the frontend. */
export function describeConfig() {
  return {
    provider: config.chain[0],
    chain: config.chain,
    model: config.providers[config.chain[0]]?.model,
    demo: config.isDemo,
    misconfigured: config.misconfigured,
    limits: config.limits,
  };
}

export { GEMINI_MODEL_LADDER, KNOWN_PROVIDERS };
