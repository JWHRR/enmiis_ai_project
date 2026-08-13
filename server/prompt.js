/**
 * Internal generation prompt.
 *
 * This text is a backend-only asset: it is never returned by the API and never
 * rendered in the browser. It is built dynamically from the references that
 * were actually uploaded, so the model is told exactly how many garment
 * components belong to the single outfit it must assemble.
 */

const PIECE_ROLES = [
  {
    slot: 'piece1',
    label: 'GARMENT REFERENCE 1 — main robe / gown body',
    detail:
      'the principal body of the graduation robe: its exact colour, fabric weight, weave, sheen, cut, length, closure and construction',
  },
  {
    slot: 'piece2',
    label: 'GARMENT REFERENCE 2 — sleeves / detailing',
    detail:
      'sleeve shape and length, collar, facings, trims, stitching, piping, embroidery, patterns, appliqués and any logo exactly as shown',
  },
  {
    slot: 'piece3',
    label: 'GARMENT REFERENCE 3 — accessory / finishing piece',
    detail:
      'the finishing component (cap, stole, hood, sash, cord or similar): its exact shape, colour, material and the way it is worn',
  },
];

/** Human-readable role labels, used to caption each image sent to the model. */
export function referenceLabels(pieceCount = 3) {
  return {
    person: 'IDENTITY REFERENCE — the person who must appear in the final photograph',
    pieces: PIECE_ROLES.slice(0, pieceCount).map((r) => r.label),
  };
}

/**
 * @param {{ pieceCount?: number, aspectRatio?: string }} options
 * @returns {string} the internal prompt sent to the image model
 */
export function buildGenerationPrompt(options = {}) {
  const pieceCount = Math.min(Math.max(options.pieceCount ?? 3, 1), 3);
  const roles = PIECE_ROLES.slice(0, pieceCount);
  const aspectRatio = options.aspectRatio || '3:4';

  const imageMap = [
    'IMAGE 1 = the person (identity reference).',
    ...roles.map((role, i) => `IMAGE ${i + 2} = ${role.label} (exact product reference).`),
  ].join('\n');

  const pieceInstructions = roles
    .map((role, i) => `- From IMAGE ${i + 2}, reproduce ${role.detail}.`)
    .join('\n');

  return `Create a highly photorealistic fashion photograph using the provided person image as the identity reference and the ${pieceCount} provided garment images as exact outfit references.

REFERENCE MAP
${imageMap}
The ${pieceCount} garment images are components of ONE single graduation outfit. They are not separate or alternative garments. Assemble them into one coherent outfit worn at the same time by the same person.

IDENTITY
Preserve the person's identity and natural facial characteristics: face, facial structure and proportions, eyes, eyebrows, nose, mouth, jawline, skin tone, skin texture, freckles and marks, hair colour, hair texture and hairstyle, body type and build, age and natural appearance. The final image must be immediately recognisable as the exact person in IMAGE 1. Do not substitute an AI-generated face. Do not beautify, slim, smooth, re-age or otherwise idealise the person. Keep eyewear and existing personal features if they are visible in IMAGE 1.

PRODUCT FIDELITY
The garment images are the single source of truth for the outfit.
${pieceInstructions}
Reproduce the original colours exactly, including hue, saturation and value. Reproduce the original materials, textures, weave, sheen and opacity. Reproduce the original proportions, seams, construction, hems, edges, fastenings, trims, embroidery, patterns and any logo or insignia exactly as they appear. Do not redesign, restyle, simplify, embellish or reinterpret any component. Do not add, remove or move decorations. Do not invent buttons, zips, jewellery, watches, badges or additional accessories. Do not introduce any clothing that is not present in the garment references.

RENDERING
Place the complete outfit naturally on the person so that it fits the body underneath it. Render realistic garment-body interaction: correct draping over the shoulders and arms, natural fabric folds and creases driven by the pose, contact shadows where the fabric rests on the body, correct layering order between components, and clean realistic edges where the garment meets skin, hair and background. Keep anatomy correct: natural body proportions, correctly formed hands with exactly five fingers, natural posture and natural neck and shoulder line. Keep one consistent lighting environment across face, skin, hair and every fabric, with matching light direction, colour temperature, softness and shadow density. Keep a single consistent camera perspective, focal length and depth of field. Keep the background simple, clean and uncluttered so the person and the outfit remain the subject.

OUTPUT
The final result must look like a professional photograph captured with a high-end camera and a fast prime lens: natural skin texture with visible pores and fine detail, realistic catchlights in the eyes, accurate white balance, natural micro-contrast, and subtle film-like tonality. Portrait orientation, approximately ${aspectRatio}, full frame on the person and the outfit.

Do not create an illustration.
Do not stylize the image.
Do not render a painting, a render, a 3D model or a cartoon.
Do not redesign the garments.
Do not alter the person's identity.
Do not introduce additional clothing or accessories.
Do not add text, captions, watermarks or logos that are not part of the garment references.
Do not produce plastic or waxy skin, over-smoothed features, deformed hands, extra fingers, extra limbs, floating clothing or garment geometry that ignores the body.

Photorealistic commercial fashion photography.`;
}
