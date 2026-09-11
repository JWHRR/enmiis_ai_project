#!/usr/bin/env node
/**
 * Derives deliberately imperfect reference sets from good ones, so the
 * "generate anyway" behaviour can be tested against real degradations rather
 * than assumed.
 *
 *   npm run make:imperfect -- person.jpg gown.jpg hood.jpg cap.jpg
 *
 * Writes ./test-inputs/<case>/{person,gown,hood,cap}.png for:
 *   A  pristine            the originals, normalised
 *   B  low-res person      person downscaled to 96px, then blurred
 *   C  cropped gown        gown cut to its centre-left third
 *   D  mixed ratios        each reference forced to a different aspect ratio
 *   E  poorly lit garment  hood darkened and de-contrasted
 *
 * Uses headless Chrome as the image decoder so the project keeps zero runtime
 * dependencies.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SLOTS = ['person', 'gown', 'hood', 'cap'];

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

/** Degradations, expressed as canvas operations run inside the browser. */
const CASES = {
  A: { label: 'pristine', ops: {} },
  B: {
    label: 'low-resolution person',
    ops: { person: { maxEdge: 96, blur: 1.5 } },
  },
  C: {
    label: 'cropped gown',
    ops: { gown: { crop: [0.05, 0.15, 0.45, 0.6] } },
  },
  D: {
    label: 'mixed aspect ratios',
    ops: {
      person: { ratio: 16 / 9 },
      gown: { ratio: 9 / 16 },
      hood: { ratio: 1 },
      cap: { ratio: 4 / 3 },
    },
  },
  E: {
    label: 'poorly lit garment',
    ops: { hood: { brightness: 0.32, contrast: 0.55 } },
  },
};

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (files.length !== 4) {
  console.error('\nUsage: npm run make:imperfect -- person.jpg gown.jpg hood.jpg cap.jpg\n');
  process.exit(1);
}

const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.error('\n  ✗ No Chrome or Edge found. Set CHROME_PATH to a Chromium binary.\n');
  process.exit(1);
}

const sources = Object.fromEntries(
  SLOTS.map((slot, index) => {
    const file = path.resolve(files[index]);
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return [slot, `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`];
  })
);

/* ------------------------------------------------------------------ CDP --- */
const PORT = 9333;
const profile = path.join(process.env.TEMP || '/tmp', 'atelier-imperfect-profile');

const chrome = spawn(
  browser,
  [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await wait(250);
  }
  throw new Error('Chrome did not expose a debugging target.');
}

const wsUrl = await connect();
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => (ws.onopen = resolve));

let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

await send('Runtime.enable');

/** Runs one canvas transformation in the page and returns a PNG data URL. */
async function transform(dataUrl, ops) {
  const expression = `(async () => {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('decode'));
      i.src = ${JSON.stringify(dataUrl)};
    });
    const ops = ${JSON.stringify(ops)};

    let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
    if (ops.crop) {
      const [x, y, w, h] = ops.crop;
      sx = Math.round(sw * x); sy = Math.round(sh * y);
      sw = Math.round(sw * w); sh = Math.round(sh * h);
    }

    let dw = sw, dh = sh;
    if (ops.ratio) {
      // Letterbox onto a canvas of the requested ratio, on white.
      if (sw / sh > ops.ratio) { dw = sw; dh = Math.round(sw / ops.ratio); }
      else { dh = sh; dw = Math.round(sh * ops.ratio); }
    }
    if (ops.maxEdge) {
      const s = Math.min(1, ops.maxEdge / Math.max(dw, dh));
      dw = Math.max(1, Math.round(dw * s));
      dh = Math.max(1, Math.round(dh * s));
    }

    const canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dw, dh);

    const filters = [];
    if (ops.blur) filters.push('blur(' + ops.blur + 'px)');
    if (ops.brightness) filters.push('brightness(' + ops.brightness + ')');
    if (ops.contrast) filters.push('contrast(' + ops.contrast + ')');
    if (filters.length) ctx.filter = filters.join(' ');

    if (ops.ratio) {
      const s = Math.min(dw / sw, dh / sh);
      const w = sw * s, h = sh * s;
      ctx.drawImage(img, sx, sy, sw, sh, (dw - w) / 2, (dh - h) / 2, w, h);
    } else {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    }

    return canvas.toDataURL('image/png');
  })()`;

  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails.text || exceptionDetails));
  return result.value;
}

/* ----------------------------------------------------------------- build --- */
const outRoot = path.join(process.cwd(), 'test-inputs');
fs.mkdirSync(outRoot, { recursive: true });

console.log('\nAtelier — imperfect reference sets\n');

for (const [name, spec] of Object.entries(CASES)) {
  const dir = path.join(outRoot, `${name}-${spec.label.replace(/\s+/g, '-')}`);
  fs.mkdirSync(dir, { recursive: true });

  const notes = [];
  for (const slot of SLOTS) {
    const ops = spec.ops[slot] || {};
    const png = await transform(sources[slot], ops);
    const buffer = Buffer.from(png.split(',')[1], 'base64');
    fs.writeFileSync(path.join(dir, `${slot}.png`), buffer);
    if (Object.keys(ops).length) notes.push(`${slot}: ${Object.keys(ops).join('+')}`);
  }

  console.log(`  ${name}  ${spec.label.padEnd(22)} → ${path.relative(process.cwd(), dir)}`);
  if (notes.length) console.log(`     ${notes.join(', ')}`);
}

ws.close();
chrome.kill();

console.log(`\n  Run each set with:`);
console.log(`    npm run check -- test-inputs/<case>/person.png test-inputs/<case>/gown.png \\`);
console.log(`                            test-inputs/<case>/hood.png test-inputs/<case>/cap.png\n`);
