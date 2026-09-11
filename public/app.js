/* ==========================================================================
   ATELIER — Virtual Outfit Studio (frontend)

   The browser never talks to an AI provider. It only ever calls this
   application's own backend at /api/generate.
   ========================================================================== */

/* The four reference slots, in the order the model receives them:
   person → gown → hood/stole → mortarboard/cap. */
const FIELDS = ['person', 'gown', 'hood', 'cap'];

const LIMITS = {
  accepted: ['image/jpeg', 'image/png', 'image/webp'],
  maxBytes: 20 * 1024 * 1024,
  maxEdge: 1536,
};

/* Only technical problems are refused. An image is never rejected for being
   blurry, small, cropped or badly lit — the model reconstructs from what it
   is given, so blocking on quality would only stop a workable generation. */
const COPY = {
  badFormat: 'Format non pris en charge. Utilisez un fichier JPG, JPEG, PNG ou WEBP.',
  tooLarge: 'Cette image est trop volumineuse (maximum 20 Mo).',
  unreadable: "Ce fichier n'a pas pu être lu. Veuillez en choisir un autre.",
  missing: 'Veuillez ajouter une image pour continuer.',
};

/* Loading copy. These are interface messages on a timer — they describe the
   wait, not distinct processing stages happening on the server. */
const LOADING_MESSAGES = [
  'Analyse de votre photo…',
  'Analyse des pièces…',
  'Assemblage de votre tenue…',
  'Application des détails…',
  'Finalisation du rendu…',
];

const REVIEW_LABELS = {
  person: 'Personne',
  gown: 'Robe',
  hood: 'Étole',
  cap: 'Toque',
};

const state = {
  view: 'landing',
  step: 1,
  refs: { person: null, gown: null, hood: null, cap: null },
  result: null,
  config: null,
  request: null,
  loadingTimer: null,
};

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/* ------------------------------------------------------------- routing --- */

function setView(name) {
  state.view = name;

  $$('[data-view]').forEach((section) => {
    section.hidden = section.dataset.view !== name;
  });

  const active = $(`[data-view="${name}"]`);
  const heading = active && $('h1, h2', active);
  if (heading) requestAnimationFrame(() => heading.focus({ preventScroll: true }));

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setStep(step) {
  state.step = Math.min(Math.max(step, 1), 5);

  $$('[data-panel]').forEach((panel) => {
    panel.hidden = Number(panel.dataset.panel) !== state.step;
  });

  $$('.stepper li').forEach((item) => {
    const index = Number(item.dataset.step);
    item.classList.toggle('is-active', index === state.step);
    item.classList.toggle('is-done', index < state.step);
  });

  if (state.step === 5) renderReview();

  const panel = $(`[data-panel="${state.step}"]`);
  const heading = panel && $('h2', panel);
  if (heading) requestAnimationFrame(() => heading.focus({ preventScroll: true }));

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------------------------------------------------- image utils --- */

async function decodeImage(file) {
  if ('createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      /* fall through to the <img> path */
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('decode failed'));
      element.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    // The bitmap has been rasterised; the object URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Re-encodes the image for upload: bounded dimensions, flattened onto white
 * (so cut-out products keep clean edges), good quality JPEG. The user's
 * original file is never modified.
 */
function buildPayload({ source, width, height }, maxEdge = LIMITS.maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);

  return canvas.toDataURL('image/jpeg', 0.92);
}

/** Total size of a candidate payload, in bytes on the wire. */
function payloadBytes(payload) {
  return FIELDS.reduce((total, field) => total + (payload[field]?.length || 0), 0);
}

/**
 * Builds the request body, re-encoding the references at a smaller size if the
 * combined payload would exceed what a serverless function will accept.
 */
async function fitPayload() {
  const budget = 3.6 * 1024 * 1024; // headroom under Vercel's 4.5 MB limit
  let payload = Object.fromEntries(FIELDS.map((f) => [f, state.refs[f].payload]));

  for (const edge of [1280, 1024, 832]) {
    if (payloadBytes(payload) <= budget) break;

    payload = Object.fromEntries(
      await Promise.all(
        FIELDS.map(async (field) => {
          const decoded = await decodeImage(await dataUrlToBlob(state.refs[field].payload));
          const shrunk = buildPayload(decoded, edge);
          if (decoded.source.close) decoded.source.close();
          return [field, shrunk];
        })
      )
    );
  }

  return payload;
}

function dataUrlToBlob(dataUrl) {
  const [header, data] = dataUrl.split(',');
  const mime = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
  const bytes = atob(data);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: mime });
}

/* ---------------------------------------------------------- validation --- */

/**
 * Accepts an uploaded file. Refuses it only for technical reasons: an
 * unsupported format, an oversized file, or bytes that do not decode as an
 * image. Sharpness, resolution, framing and lighting are deliberately not
 * checked — imperfect references are handled by the generation model.
 */
async function acceptFile(field, file) {
  const uploader = $(`.uploader[data-field="${field}"]`);
  const feedback = $(`[data-feedback="${field}"]`);

  const fail = (message) => {
    uploader.classList.add('is-invalid');
    feedback.textContent = message;
    feedback.classList.add('is-error');
    return false;
  };

  if (!file) return false;

  const type = (file.type || '').toLowerCase();
  const extensionOk = /\.(jpe?g|png|webp)$/i.test(file.name || '');
  if (!LIMITS.accepted.includes(type) && !extensionOk) return fail(COPY.badFormat);
  if (file.size > LIMITS.maxBytes) return fail(COPY.tooLarge);

  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch {
    return fail(COPY.unreadable);
  }

  if (!decoded.width || !decoded.height) return fail(COPY.unreadable);

  releaseRef(state.refs[field]);

  state.refs[field] = {
    original: URL.createObjectURL(file),
    payload: buildPayload(decoded),
    width: decoded.width,
    height: decoded.height,
    name: file.name || 'image',
  };

  if (decoded.source.close) decoded.source.close();

  uploader.classList.remove('is-invalid');
  feedback.classList.remove('is-error');
  feedback.textContent = '';

  renderUploader(field);
  return true;
}

function releaseRef(ref) {
  if (ref?.original) URL.revokeObjectURL(ref.original);
}

/* ------------------------------------------------------------ rendering --- */

function renderUploader(field) {
  const uploader = $(`.uploader[data-field="${field}"]`);
  const preview = $('.uploader__preview', uploader);
  const zone = $('.uploader__zone', uploader);
  const ref = state.refs[field];

  if (ref) {
    $('img', preview).src = ref.original;
    preview.hidden = false;
    zone.hidden = true;
  } else {
    preview.hidden = true;
    zone.hidden = false;
  }
}

function renderReview() {
  const container = $('#review');
  container.innerHTML = '';

  FIELDS.forEach((field, index) => {
    const ref = state.refs[field];
    const item = document.createElement('div');
    item.className = 'review__item';

    const label = document.createElement('p');
    label.className = 'review__label';
    label.textContent = REVIEW_LABELS[field];

    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.src = ref ? ref.original : '';
    img.alt = `Référence : ${REVIEW_LABELS[field].toLowerCase()}`;
    figure.append(img);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'link review__edit';
    edit.textContent = 'Modifier';
    edit.addEventListener('click', () => setStep(index + 1));

    item.append(label, figure, edit);
    container.append(item);
  });

  const ready = FIELDS.every((field) => state.refs[field]);
  const generateBtn = $('[data-action="generate"]');
  generateBtn.disabled = !ready;
  $('#reviewNote').textContent = ready
    ? 'La génération prend généralement moins d\'une minute.'
    : 'Ajoutez les quatre images pour lancer la génération.';
}

function renderConfig() {
  const config = state.config;
  const note = $('#privacyNote');

  if (!config) return;

  $('#demoBadge').hidden = !config.demo;

  note.textContent = config.demo
    ? "Mode démonstration : aucune image n'est envoyée à un service de génération."
    : 'Vos images sont transmises au service de génération le temps du rendu. Elles ne sont pas enregistrées sur nos serveurs.';
}

/* ----------------------------------------------------------- generation --- */

function startLoadingMessages() {
  const status = $('#loadingStatus');
  let index = 0;

  status.textContent = LOADING_MESSAGES[0];

  state.loadingTimer = setInterval(() => {
    index = Math.min(index + 1, LOADING_MESSAGES.length - 1);
    status.textContent = LOADING_MESSAGES[index];
    status.style.animation = 'none';
    void status.offsetWidth;
    status.style.animation = '';
  }, 3400);
}

function stopLoadingMessages() {
  clearInterval(state.loadingTimer);
  state.loadingTimer = null;
}

async function generate() {
  if (!FIELDS.every((field) => state.refs[field])) {
    setStep(5);
    return;
  }

  setView('loading');
  startLoadingMessages();

  const controller = new AbortController();
  state.request = controller;

  // Serverless platforms cap the request body (Vercel: 4.5 MB). Shrink the
  // references rather than letting the upload fail outright.
  const payload = await fitPayload();

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => null);

    if (!response.ok || !body?.image) {
      throw new Error(body?.error || '');
    }

    state.result = {
      image: body.image,
      mimeType: body.mimeType,
      demo: Boolean(body.demo),
      warning: body.warning || null,
    };

    stopLoadingMessages();
    $('#loadingStatus').textContent = 'Votre tenue est prête.';

    await new Promise((resolve) => setTimeout(resolve, 900));
    showResult();
  } catch (error) {
    stopLoadingMessages();

    if (error.name === 'AbortError') {
      setView('studio');
      setStep(5);
      return;
    }

    $('#errorDetail').textContent =
      error.message && error.message !== "Nous n'avons pas pu générer votre tenue."
        ? error.message
        : '';
    setView('error');
  } finally {
    state.request = null;
  }
}

function showResult() {
  const { image, demo } = state.result;

  $('#resultImage').src = image;
  $('#beforeImage').src = state.refs.person?.original || '';

  setCompare('after');

  $('#resultNote').textContent = demo
    ? "Mode démonstration : ceci est un exemple prédéfini. Cette image n'a pas été générée à partir de vos photos."
    : state.result.warning || '';

  $('#demoBadge').hidden = !demo && !state.config?.demo;

  setView('result');
}

function setCompare(which) {
  $('#resultImage').classList.toggle('is-visible', which === 'after');
  $('#beforeImage').classList.toggle('is-visible', which === 'before');

  $$('.compare__tab').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.compare === which));
  });
}

function download() {
  if (!state.result) return;

  const extension = (state.result.mimeType || 'image/png').includes('svg')
    ? 'svg'
    : (state.result.mimeType || 'image/png').split('/')[1] || 'png';

  const link = document.createElement('a');
  link.href = state.result.image;
  link.download = `ma-tenue.${extension}`;
  document.body.append(link);
  link.click();
  link.remove();
}

function restart() {
  FIELDS.forEach((field) => {
    releaseRef(state.refs[field]);
    state.refs[field] = null;

    const input = $(`#file-${field}`);
    if (input) input.value = '';

    const feedback = $(`[data-feedback="${field}"]`);
    if (feedback) {
      feedback.textContent = '';
      feedback.classList.remove('is-error');
    }

    renderUploader(field);
  });

  state.result = null;
  $('#demoBadge').hidden = !state.config?.demo;
  setView('landing');
}

/* -------------------------------------------------------------- events --- */

function bindUploaders() {
  FIELDS.forEach((field) => {
    const uploader = $(`.uploader[data-field="${field}"]`);
    const input = $('.uploader__input', uploader);

    input.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await acceptFile(field, file);
      input.value = '';
    });

    $('[data-action="replace"]', uploader).addEventListener('click', () => input.click());

    $('[data-action="remove"]', uploader).addEventListener('click', () => {
      releaseRef(state.refs[field]);
      state.refs[field] = null;
      $(`[data-feedback="${field}"]`).textContent = '';
      renderUploader(field);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      uploader.addEventListener(type, (event) => {
        event.preventDefault();
        uploader.classList.add('is-dragging');
      });
    });

    ['dragleave', 'drop'].forEach((type) => {
      uploader.addEventListener(type, (event) => {
        event.preventDefault();
        uploader.classList.remove('is-dragging');
      });
    });

    uploader.addEventListener('drop', async (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) await acceptFile(field, file);
    });
  });
}

function bindActions() {
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const panel = trigger.closest('[data-panel]');
    const step = panel ? Number(panel.dataset.panel) : null;

    switch (action) {
      case 'home':
        event.preventDefault();
        setView('landing');
        break;

      case 'start':
        setView('studio');
        setStep(1);
        break;

      case 'next': {
        const field = FIELDS[step - 1];
        if (!state.refs[field]) {
          const feedback = $(`[data-feedback="${field}"]`);
          feedback.textContent = COPY.missing;
          feedback.classList.add('is-error');
          $(`.uploader[data-field="${field}"]`).classList.add('is-invalid');
          return;
        }
        setStep(step + 1);
        break;
      }

      case 'back':
        if (step === 1) setView('landing');
        else setStep(step - 1);
        break;

      case 'generate':
      case 'regenerate':
        generate();
        break;

      case 'cancel':
        state.request?.abort();
        break;

      case 'edit':
        setView('studio');
        setStep(5);
        break;

      case 'download':
        download();
        break;

      case 'restart':
        restart();
        break;

      default:
        break;
    }
  });

  $$('.compare__tab').forEach((tab) => {
    tab.addEventListener('click', () => setCompare(tab.dataset.compare));
  });
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    state.config = await response.json();
  } catch {
    state.config = null;
  }
  renderConfig();
}

/* ---------------------------------------------------------------- boot --- */

bindUploaders();
bindActions();
loadConfig();
setView('landing');
setStep(1);

window.addEventListener('beforeunload', () => {
  FIELDS.forEach((field) => releaseRef(state.refs[field]));
});
