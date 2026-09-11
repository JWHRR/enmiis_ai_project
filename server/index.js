import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { config, describeConfig } from './config.js';
import { validateRequest, ValidationError } from './validate.js';
import { generateVirtualOutfit } from './generate.js';
import { GenerationError } from './providers/util.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Reads a JSON body with a hard size ceiling, so a huge upload cannot exhaust memory. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.limits.maxRequestBytes) {
        reject(
          new ValidationError(
            'Vos images sont trop volumineuses. Veuillez utiliser des fichiers plus légers.',
            null
          )
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('La requête est invalide. Veuillez recharger la page.', null));
      }
    });

    req.on('error', reject);
  });
}

async function handleGenerate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof ValidationError) {
      return sendJson(res, 413, { error: error.userMessage, field: error.field });
    }
    throw error;
  }

  let references;
  try {
    references = validateRequest(body);
  } catch (error) {
    if (error instanceof ValidationError) {
      return sendJson(res, 422, { error: error.userMessage, field: error.field });
    }
    throw error;
  }

  // Cancel the upstream call if the browser goes away mid-generation.
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on('close', onClose);

  const timer = setTimeout(() => controller.abort(), config.timeoutMs + 15000);

  try {
    const result = await generateVirtualOutfit(references, { signal: controller.signal });

    // A text-to-image model ignores the uploads and invents a face. That is a
    // materially different product, so it is reported rather than passed off
    // as a virtual try-on of the person who was uploaded.
    const identityPreserved = result.meta ? result.meta.identityPreserved !== false : true;

    return sendJson(res, 200, {
      image: `data:${result.mimeType};base64,${result.base64}`,
      mimeType: result.mimeType,
      demo: result.demo,
      durationMs: result.durationMs,
      meta: result.meta || null,
      identityPreserved,
      warning: identityPreserved
        ? null
        : "Ce rendu a été créé par un modèle qui ne peut pas utiliser vos photos : "
          + "le visage et la tenue sont inventés et ne correspondent pas à vos références.",
    });
  } catch (error) {
    // Full detail stays on the server; the browser gets a usable French message.
    console.error('[generate] failed:', error?.message || error);

    if (controller.signal.aborted && res.writableEnded === false && req.destroyed) {
      return; // client disconnected, nothing to answer
    }

    const userMessage =
      error instanceof GenerationError && error.userMessage
        ? error.userMessage
        : "Nous n'avons pas pu générer votre tenue.";

    return sendJson(res, 502, { error: userMessage });
  } finally {
    clearTimeout(timer);
    req.off('close', onClose);
  }
}

async function serveStatic(req, res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.join(config.publicDir, relative);

  // Never serve outside the public directory.
  if (!filePath.startsWith(config.publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    stat = null;
  }

  if (!stat || stat.isDirectory()) {
    // Single-page application: unknown paths fall back to the shell.
    return serveFile(res, path.join(config.publicDir, 'index.html'));
  }

  return serveFile(res, filePath, stat);
}

function serveFile(res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // Code and markup are unfingerprinted, so they must be revalidated on every
  // load — otherwise a deploy leaves clients running stale CSS/JS.
  const isCode = ext === '.html' || ext === '.css' || ext === '.js';

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': isCode ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (stat) headers['Content-Length'] = stat.size;

  res.writeHead(200, headers);
  fs.createReadStream(filePath)
    .on('error', () => res.end())
    .pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, describeConfig());
    }

    if (url.pathname === '/api/generate') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'Méthode non autorisée.' });
      }
      return await handleGenerate(req, res);
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Endpoint introuvable.' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Méthode non autorisée.' });
    }

    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error('[server] unhandled error:', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Une erreur interne est survenue.' });
    else res.end();
  }
});

// Generations legitimately take minutes; keep the socket open long enough.
server.requestTimeout = config.timeoutMs + 60000;
server.headersTimeout = 65000;
server.keepAliveTimeout = 72000;

server.listen(config.port, () => {
  const primary = config.providers[config.chain[0]];

  const banner = [
    '',
    '  ATELIER — AI Virtual Outfit Studio',
    `  → http://localhost:${config.port}`,
    '',
    `  Chain    : ${config.chain.join(' → ')}${config.isDemo ? '  (mode démonstration)' : ''}`,
    `  Model    : ${primary?.model}`,
  ];

  if (config.chain[0] === 'gemini') {
    banner.push(`  Fallbacks: ${primary.models.slice(1).join(', ')}`);
  }

  if (config.isDemo) {
    banner.push(
      '',
      '  ⚠ No provider credential found — running in demo mode.',
      '    Set GEMINI_API_KEY in .env to enable real generation.',
      '    Get a free key at https://aistudio.google.com/apikey'
    );
  }

  banner.push('');
  console.log(banner.join('\n'));
});
