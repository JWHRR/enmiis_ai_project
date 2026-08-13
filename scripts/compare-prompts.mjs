#!/usr/bin/env node
/**
 * Generates the same four references with every prompt variant, so the
 * production prompt can be chosen from real output rather than by guesswork.
 *
 *   npm run compare:prompts -- person.jpg gown.jpg hood.jpg cap.jpg
 *   npm run compare:prompts -- person.jpg gown.jpg hood.jpg cap.jpg --variants a,b
 *   npm run compare:prompts -- ... --runs 2      two images per variant
 *
 * Writes ./comparisons/<variant>-<n>.png and a scoring sheet to fill in while
 * looking at them. Requires a real GEMINI_API_KEY.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../server/config.js';
import { generateVirtualOutfit } from '../server/generate.js';
import { validateImage } from '../server/validate.js';
import { PROMPT_VARIANTS, DEFAULT_VARIANT, buildGenerationPrompt } from '../server/prompt.js';

const SLOTS = ['person', 'gown', 'hood', 'cap'];

const CRITERIA = [
  'Face identity preservation',
  'Garment accuracy (gown)',
  'Outfit completeness (gown + hood + cap all present)',
  'Photorealism',
  'Anatomy (body, hands)',
  'Hood / cap positioning',
  'Overall visual quality',
];

/* ------------------------------------------------------------- arguments -- */
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const files = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] || '').startsWith('--'));

const variants = String(flag('variants', Object.keys(PROMPT_VARIANTS).join(',')))
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter((v) => v in PROMPT_VARIANTS);

const runs = Math.max(1, Number(flag('runs', 1)) || 1);

if (files.length !== 4) {
  console.error('\nUsage: npm run compare:prompts -- person.jpg gown.jpg hood.jpg cap.jpg\n');
  console.error('Four reference images are required, in this order:');
  SLOTS.forEach((slot, i) => console.error(`  ${i + 1}. ${slot}`));
  console.error('');
  process.exit(1);
}

if (config.isDemo) {
  console.error('\n  ✗ No provider credential found.');
  console.error('    Set GEMINI_API_KEY in .env — free key: https://aistudio.google.com/apikey\n');
  process.exit(1);
}

/* ------------------------------------------------------------ references -- */
function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

console.log('\nAtelier — prompt comparison\n');
console.log(`  model    : ${config.providers.gemini.model}`);
console.log(`  variants : ${variants.join(', ')}   (production default: ${DEFAULT_VARIANT})`);
console.log(`  runs     : ${runs} per variant\n`);
console.log('  references:');

const references = SLOTS.map((slot, index) => {
  const file = files[index];
  const buffer = fs.readFileSync(path.resolve(file));
  const validated = validateImage(
    `data:${mimeFor(file)};base64,${buffer.toString('base64')}`,
    slot,
    slot
  );
  console.log(
    `    ${slot.padEnd(7)} ${path.basename(file).padEnd(30)} ` +
      `${validated.mimeType} ${validated.width ?? '?'}×${validated.height ?? '?'} ` +
      `${(validated.bytes / 1024).toFixed(0)} KB`
  );
  return validated;
});

const outDir = path.join(config.rootDir, 'comparisons');
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ run --- */
const results = [];

for (const variant of variants) {
  const promptLength = buildGenerationPrompt({ referenceCount: 4, variant }).split(/\s+/).length;
  console.log(`\n  ── variant ${variant.toUpperCase()} (${promptLength} words) ──`);

  for (let run = 1; run <= runs; run += 1) {
    // buildGenerationPrompt reads PROMPT_VARIANT at call time.
    process.env.PROMPT_VARIANT = variant;
    const startedAt = Date.now();

    try {
      const result = await generateVirtualOutfit({
        person: references[0],
        pieces: references.slice(1),
      });

      const extension = (result.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = runs > 1 ? `${variant}-${run}.${extension}` : `${variant}.${extension}`;
      const output = path.join(outDir, name);
      fs.writeFileSync(output, Buffer.from(result.base64, 'base64'));

      const kb = (Buffer.byteLength(result.base64, 'base64') / 1024).toFixed(0);
      console.log(`     ✓ ${name}  ${kb} KB  ${Date.now() - startedAt} ms  (${result.model})`);
      results.push({ variant, run, file: output, ok: true });
    } catch (error) {
      console.log(`     ✗ run ${run} failed: ${error.message.split('\n')[0]}`);
      results.push({ variant, run, ok: false, error: error.message });
    }
  }
}

delete process.env.PROMPT_VARIANT;

/* -------------------------------------------------------------- summary --- */
const ok = results.filter((r) => r.ok);

console.log(`\n  ${ok.length}/${results.length} generations succeeded`);
console.log(`  images in: ${outDir}\n`);

if (!ok.length) {
  console.error('  Nothing to compare.\n');
  process.exit(1);
}

const sheet = [
  '# Prompt comparison',
  '',
  `Model: ${config.providers.gemini.model}`,
  `References: ${files.map((f) => path.basename(f)).join(', ')}`,
  `Generated: ${new Date().toISOString()}`,
  '',
  'Score each 1–5 while looking at the images, then set the winner as',
  'DEFAULT_VARIANT in server/prompt.js.',
  '',
  `| Criterion | ${ok.map((r) => r.variant.toUpperCase() + (runs > 1 ? `-${r.run}` : '')).join(' | ')} |`,
  `| --- | ${ok.map(() => '---').join(' | ')} |`,
  ...CRITERIA.map((c) => `| ${c} | ${ok.map(() => ' ').join(' | ')} |`),
  '',
  '## Files',
  ...ok.map((r) => `- ${r.variant.toUpperCase()}: ${path.relative(config.rootDir, r.file)}`),
  '',
];

const sheetPath = path.join(outDir, 'comparison.md');
fs.writeFileSync(sheetPath, sheet.join('\n'));

console.log('  Scoring sheet:');
CRITERIA.forEach((c) => console.log(`    · ${c}`));
console.log(`\n  → ${path.relative(config.rootDir, sheetPath)}\n`);
