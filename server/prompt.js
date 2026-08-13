/**
 * Internal generation prompt.
 *
 * Backend-only asset: never returned by the API, never rendered in the browser.
 * It is built from the references that were actually uploaded and is written
 * for multi-reference image models, where each image must carry an explicit
 * role so the model knows which one is the identity and which are products.
 */

/** The four reference slots, in the order they are sent to the model. */
export const REFERENCE_ROLES = [
  {
    slot: 'person',
    caption: 'IMAGE 1 = PERSON REFERENCE (identity)',
    detail:
      "the person who must appear in the final photograph: their face, facial structure, skin tone, hairstyle, approximate age and overall appearance",
  },
  {
    slot: 'gown',
    caption: 'IMAGE 2 = GOWN / ROBE REFERENCE',
    detail:
      'the graduation gown or robe: its exact colour, fabric, sheen, cut, length, sleeves, collar, facings and construction',
  },
  {
    slot: 'hood',
    caption: 'IMAGE 3 = HOOD / STOLE REFERENCE',
    detail:
      'the hood or stole worn over the gown: its exact colours, lining, trim, shape, embroidery, patterns, insignia and the way it drapes',
  },
  {
    slot: 'cap',
    caption: 'IMAGE 4 = MORTARBOARD / CAP REFERENCE',
    detail:
      'the mortarboard or graduation cap: its exact shape, colour, material, tassel colour and the way it sits on the head',
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

/**
 * @param {{ referenceCount?: number, aspectRatio?: string }} options
 * @returns {string} the internal prompt sent to the image model
 */
export function buildGenerationPrompt(options = {}) {
  const count = Math.min(Math.max(options.referenceCount ?? 4, 2), REFERENCE_ROLES.length);
  const roles = REFERENCE_ROLES.slice(0, count);
  const aspectRatio = options.aspectRatio || '3:4';

  const referenceMap = roles.map((role) => `${role.caption} — ${role.detail}.`).join('\n');
  const garments = roles.slice(1);
  const garmentList = garments
    .map((role) => `- ${role.caption.split('=')[1].trim()}`)
    .join('\n');

  return `Create ONE highly photorealistic photograph of the person shown in the first reference image.

REFERENCE MAP
${referenceMap}

The ${garments.length} garment references are components of ONE single graduation outfit. They are not separate outfits and not alternatives. Combine them into one coherent outfit and place that complete outfit naturally on the person from the first reference image.

IDENTITY
Preserve the person's recognisable facial characteristics, facial structure, eyes, nose, mouth, skin tone, hairstyle, hair colour, approximate age, build and overall appearance as accurately as the reference allows. The result must read as the same person. Do not substitute a different or AI-invented face. Do not beautify, slim, smooth or re-age the person.

OUTFIT
The person must be wearing, at the same time:
${garmentList}
Reproduce each garment's original colours, materials, textures, proportions, construction, trims, embroidery, patterns and insignia as shown in its reference. Do not redesign, restyle or embellish them. Do not add clothing, jewellery or accessories that are not present in the references.

TOLERANCE FOR IMPERFECT REFERENCES
Reconstruct missing visual information naturally when the reference images are incomplete, cropped, blurry, low-resolution, oddly framed, badly lit or otherwise imperfect. Infer the hidden parts of a cropped garment. Ignore irrelevant backgrounds, hangers, mannequins, props and packaging around a product. Normalise differing image ratios. Never refuse or return an empty result because a reference is imperfect — always make the best possible visual interpretation from what is available and produce one final image.

RENDERING
Render realistic anatomy and proportions, correctly formed hands, realistic fabric behaviour, natural folds and drape, contact shadows where fabric meets the body, correct layering between gown, hood/stole and cap, and clean edges where garments meet skin, hair and background. Match the garments to the person's body naturally. Use one consistent lighting environment, colour temperature and camera perspective across the face, skin and every fabric. Keep the background simple and uncluttered. Portrait orientation, approximately ${aspectRatio}.

OUTPUT
A single professional, realistic graduation photograph that looks captured with a high-end camera: natural skin texture, realistic catchlights, accurate white balance, natural micro-contrast.

The final image must contain exactly ONE person.
Do not create a collage.
Do not show the reference images themselves.
Do not create multiple people.
Do not create multiple versions of the person.
Do not place garments floating around the person.
Do not distort the face.
Do not add text, captions or watermarks.
Do not stylize, illustrate or cartoon the image.
Do not refuse solely because the input references are imperfect.

Photorealistic commercial graduation photography.`;
}
