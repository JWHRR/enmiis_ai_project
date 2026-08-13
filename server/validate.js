import { config } from './config.js';

/** Errors that carry a French, user-facing message. */
export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.userMessage = message;
  }
}

const DATA_URL_RE = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i;

/**
 * Reads the real image type from the file's magic bytes, so a renamed or
 * mislabelled file cannot slip through on its declared MIME type alone.
 */
function sniffType(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function pngSize(buf) {
  // IHDR is always the first chunk: length(4) type(4) width(4) height(4)
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let offset = 2; // skip SOI
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];

    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan: pixel data begins, dimensions were already declared.
    if (marker === 0xda) break;

    const length = buf.readUInt16BE(offset + 2);
    const isSOF =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSOF) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    // Key frame header: 3-byte frame tag, 3-byte sync code, then 16-bit dims.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return null;
}

function imageSize(buf, mimeType) {
  try {
    if (mimeType === 'image/png') return pngSize(buf);
    if (mimeType === 'image/jpeg') return jpegSize(buf);
    if (mimeType === 'image/webp') return webpSize(buf);
  } catch {
    return null;
  }
  return null;
}

const LABELS = {
  person: 'votre photo',
  piece1: 'la pièce 1',
  piece2: 'la pièce 2',
  piece3: 'la pièce 3',
};

/**
 * Validates one incoming data URL and returns a normalised reference.
 * @returns {{ base64: string, mimeType: string, bytes: number, width: number|null, height: number|null }}
 */
export function validateImage(dataUrl, field) {
  const label = LABELS[field] || 'cette image';

  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw new ValidationError(`Il manque ${label}.`, field);
  }

  const match = DATA_URL_RE.exec(dataUrl.trim());
  if (!match) {
    throw new ValidationError(
      `Nous n'avons pas pu lire ${label}. Veuillez réessayer avec un fichier JPG, PNG ou WEBP.`,
      field
    );
  }

  const declaredMime = match[1].toLowerCase();
  if (!config.limits.allowedMimeTypes.includes(declaredMime)) {
    throw new ValidationError(
      `Le format de ${label} n'est pas pris en charge. Formats acceptés : JPG, JPEG, PNG, WEBP.`,
      field
    );
  }

  let buf;
  try {
    buf = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  } catch {
    buf = null;
  }
  if (!buf || buf.length === 0) {
    throw new ValidationError(`Nous n'avons pas pu lire ${label}. Veuillez la remplacer.`, field);
  }

  if (buf.length > config.limits.maxImageBytes) {
    const mb = Math.round(config.limits.maxImageBytes / (1024 * 1024));
    throw new ValidationError(`${capitalise(label)} est trop volumineuse (maximum ${mb} Mo).`, field);
  }

  const actualMime = sniffType(buf);
  if (!actualMime) {
    throw new ValidationError(
      `Nous n'avons pas pu lire ${label}. Veuillez utiliser un fichier JPG, PNG ou WEBP valide.`,
      field
    );
  }

  const size = imageSize(buf, actualMime);
  if (size && (size.width < config.limits.minDimension || size.height < config.limits.minDimension)) {
    throw new ValidationError(
      'Cette image est trop petite pour obtenir un résultat optimal.',
      field
    );
  }

  return {
    base64: buf.toString('base64'),
    mimeType: actualMime,
    bytes: buf.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

/**
 * Validates the whole payload: one person + three outfit pieces.
 */
export function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError("La requête est invalide. Veuillez recharger la page.", null);
  }

  const person = validateImage(body.person, 'person');
  const pieces = ['piece1', 'piece2', 'piece3'].map((field) => validateImage(body[field], field));

  return { person, pieces };
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
