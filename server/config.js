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

const DEFAULT_MODELS = {
  gemini: 'gemini-2.5-flash-image',
  fal: 'fal-ai/nano-banana/edit',
  replicate: 'google/nano-banana',
  fashn: 'tryon-v1.6',
  openai: 'gpt-image-1',
  demo: 'demo',
};

const requestedProvider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
const apiKey = (process.env.AI_API_KEY || '').trim();

/**
 * The provider actually used. Anything that is not configured with a key
 * silently falls back to demo mode so the product is always demonstrable —
 * but the frontend is told, explicitly, that it is looking at a demo.
 */
function resolveProvider() {
  if (!requestedProvider || requestedProvider === 'demo') return 'demo';
  if (!(requestedProvider in DEFAULT_MODELS)) return 'demo';
  if (!apiKey) return 'demo';
  return requestedProvider;
}

const provider = resolveProvider();

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  port: Number(process.env.PORT) || 3000,

  provider,
  requestedProvider: requestedProvider || 'demo',
  apiKey,
  model: (process.env.AI_MODEL || '').trim() || DEFAULT_MODELS[provider],
  replicateImagesKey: (process.env.AI_INPUT_IMAGES_KEY || '').trim() || 'image_input',
  aspectRatio: (process.env.AI_ASPECT_RATIO || '').trim() || '3:4',
  timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 240000,
  debugPrompt: process.env.DEBUG_PROMPT === '1',

  isDemo: provider === 'demo',
  /** True when a provider was requested but could not be used (missing key / unknown name). */
  misconfigured:
    Boolean(requestedProvider) &&
    requestedProvider !== 'demo' &&
    provider === 'demo',

  // Upload limits, enforced on both sides of the wire.
  limits: {
    maxImageBytes: 15 * 1024 * 1024,
    maxRequestBytes: 40 * 1024 * 1024,
    minDimension: 200,
    recommendedPersonDimension: 640,
    recommendedPieceDimension: 512,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  },
};

export function describeConfig() {
  return {
    provider: config.provider,
    model: config.model,
    demo: config.isDemo,
    misconfigured: config.misconfigured,
    limits: config.limits,
  };
}
