/**
 * Internal generation prompt.
 *
 * Backend-only asset: never returned by the API, never rendered in the browser.
 *
 * The prompt is the main tuning surface for output quality, so three variants
 * are kept side by side and can be compared on identical references with
 * `npm run compare:prompts`. They share one set of hard constraints and differ
 * only in how much they direct the model — so a comparison isolates framing
 * rather than mixing several changes at once.
 *
 * Select with PROMPT_VARIANT=a|b|c (default: b).
 */

/** The four reference slots, in the order they are sent to the model. */
export const REFERENCE_ROLES = [
  {
    slot: 'person',
    caption: 'IMAGE 1 = PERSON REFERENCE (identity)',
    source: 'identity source',
    keep: 'facial identity, facial structure, skin tone, hairstyle, approximate age and general appearance',
  },
  {
    slot: 'gown',
    caption: 'IMAGE 2 = GOWN / ROBE REFERENCE',
    source: 'gown source',
    keep: 'colour, material, cut, sleeves, collar, major design details and proportions',
  },
  {
    slot: 'hood',
    caption: 'IMAGE 3 = HOOD / STOLE REFERENCE',
    source: 'hood / stole source',
    keep: 'shape, colour, trim, positioning and proportions',
  },
  {
    slot: 'cap',
    caption: 'IMAGE 4 = MORTARBOARD / CAP REFERENCE',
    source: 'cap source',
    keep: 'mortarboard shape, colour, tassel and proportions',
  },
];

/** Captions sent alongside each image, so providers can label the references. */
export function referenceLabels(count = REFERENCE_ROLES.length) {
  const roles = REFERENCE_ROLES.slice(0, count);
  return {
    person: roles[0].caption,
    pieces: roles.slice(1).map((role) => role.caption),
    all: roles.map((role) => role.caption),
  };
}

/** Hard output constraints, identical across variants. */
function constraints(aspectRatio) {
  return `The final image must contain exactly ONE person.
Do not create a collage.
Do not show the reference images themselves.
Do not create multiple people or multiple versions of the person.
Do not redesign, restyle or recolour the garments.
Do not add clothing, accessories, jewellery, text or watermarks that are not in the references.
Do not distort the face or the hands.
Do not stylize or illustrate — the output is a photograph.
Portrait orientation, approximately ${aspectRatio}, plain uncluttered background.`;
}

function referenceMap(roles) {
  return roles
    .map((role) => `${role.caption} — ${role.source}: keep its ${role.keep}.`)
    .join('\n');
}

/* ------------------------------------------------------------ variant A --- */
/* Minimal. Establishes who / what / how / output and trusts the model. */
function variantA(roles, aspectRatio) {
  return `Create ONE photorealistic graduation photograph from the four reference images provided.

REFERENCE MAP
${referenceMap(roles)}

Reference 1 is who the person is. References 2–4 are what that person is wearing: they are components of ONE single graduation outfit, worn at the same time.

Preserve the person's recognisable facial characteristics and each garment's appearance as shown in its reference. Do not simply place the garment images onto the person — reconstruct the clothing naturally as if the person were actually wearing the outfit.

The final result must look like a photograph captured by a professional camera, with physically consistent clothing, lighting, shadows and perspective.

Reconstruct missing detail naturally when a reference is imperfect. Never refuse or return an empty result because a reference is imperfect.

${constraints(aspectRatio)}`;
}

/* ------------------------------------------------------------ variant B --- */
/* Production default: reference-as-source-material framing, explicit
   priority order, and the physical-integration instruction. */
function variantB(roles, aspectRatio) {
  return `Create ONE photorealistic graduation photograph.

You are given four reference images. Use them as visual source material — not as pictures to copy, crop or paste.

REFERENCE MAP
${referenceMap(roles)}

Reference 1 defines who the person is. References 2, 3 and 4 define what that person is wearing: they are components of ONE single graduation outfit, worn at the same time, not separate or alternative outfits. Combine them into one coherent outfit on one person.

Preserve the person's recognisable facial characteristics, facial structure, skin tone, hairstyle, approximate age and general appearance, so the result is recognisably the same person. Then reproduce each garment's colour, material, cut and design details as shown in its own reference.

Do not simply place the garment images onto the person. Reconstruct the clothing naturally as if the person were actually wearing the outfit: correct drape over the shoulders and arms, fabric folds that follow the pose, contact shadows where fabric meets the body, and correct layering of gown, then hood or stole, with the mortarboard sitting naturally on the head.

The final result must look like a photograph captured by a professional camera, with physically consistent clothing, lighting, shadows and perspective. Keep anatomy correct, including natural body proportions and correctly formed hands.

When a reference is blurry, cropped, low-resolution, badly lit, oddly framed or shot against a distracting background, reconstruct the missing information naturally and ignore irrelevant backgrounds, hangers, mannequins and props. Never refuse or return an empty result because a reference is imperfect — always produce the best possible single image.

${constraints(aspectRatio)}`;
}

/* ------------------------------------------------------------ variant C --- */
/* Most directive: spells out per-reference preservation as a checklist. */
function variantC(roles, aspectRatio) {
  const checklist = roles
    .map((role, index) => `${index + 1}. From ${role.source} (${role.caption}), preserve: ${role.keep}.`)
    .join('\n');

  return `Photorealistic graduation portrait, built from four visual references.

REFERENCE MAP
${referenceMap(roles)}

PRESERVATION CHECKLIST, in priority order
${checklist}

The three garment references are components of ONE single graduation outfit. Assemble them onto the one person from reference 1, worn together and layered correctly: gown first, hood or stole over it, mortarboard on the head with the tassel hanging naturally.

Preserve the person's recognisable facial characteristics above everything else. If a detail cannot be satisfied for both the person and a garment, favour the person's identity.

Do not simply place the garment images onto the person. Reconstruct the clothing naturally as if the person were actually wearing the outfit, with fabric that responds to the body underneath it: real drape, real folds, real weight, real contact shadows.

The final result must look like a photograph captured by a professional camera, with physically consistent clothing, lighting, shadows and perspective. One consistent light source across skin and every fabric. One consistent camera position, focal length and depth of field. Correct anatomy and correctly formed hands.

Imperfect references are expected. Reconstruct cropped, blurry, low-resolution or badly lit source material as faithfully as the image allows, and ignore backgrounds and props around a product. Never refuse or return an empty result because a reference is imperfect.

${constraints(aspectRatio)}`;
}

export const PROMPT_VARIANTS = { a: variantA, b: variantB, c: variantC };
export const DEFAULT_VARIANT = 'b';

/**
 * @param {{ referenceCount?: number, aspectRatio?: string, variant?: string }} options
 * @returns {string} the internal prompt sent to the image model
 */
export function buildGenerationPrompt(options = {}) {
  const count = Math.min(Math.max(options.referenceCount ?? 4, 2), REFERENCE_ROLES.length);
  const roles = REFERENCE_ROLES.slice(0, count);
  const aspectRatio = options.aspectRatio || '3:4';

  // Read at call time so a comparison run can switch variants per generation.
  const requested = (options.variant || process.env.PROMPT_VARIANT || DEFAULT_VARIANT)
    .toString()
    .trim()
    .toLowerCase();

  const build = PROMPT_VARIANTS[requested] || PROMPT_VARIANTS[DEFAULT_VARIANT];
  return build(roles, aspectRatio);
}
