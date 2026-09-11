# Atelier — AI Virtual Outfit Studio

A standalone web application with a single purpose: produce a highly realistic
image of a specific person wearing a specific graduation outfit.

The user uploads **four references** — a person, a gown, a hood/stole and a
mortarboard — and the application returns **one photorealistic photograph** of
that person wearing that complete outfit.

```
FACE + GOWN + HOOD + CAP  →  Gemini (Nano Banana 2)  →  ONE realistic person
                                                        wearing the complete outfit
```

---

## Quick start

```bash
npm start          # → http://localhost:3000
```

Nothing to install — **zero runtime dependencies**, Node 18.17+ (developed on 24).

Without a key the app runs in demo mode. To enable real generation:

```bash
cp .env.example .env
```

```ini
GEMINI_API_KEY=your-key-here
```

That is the only value you need. Get a free key from
[Google AI Studio](https://aistudio.google.com/apikey).

Verify it works before touching the UI:

```bash
npm run check                                  # placeholder references
npm run check -- face.jpg gown.jpg hood.jpg cap.jpg
```

It runs the exact code path the web app uses and writes `check-output.png`.

---

## The generation model

**Gemini 3.1 Flash Image (Nano Banana 2)** is the primary provider. It is a
native multi-reference image model, which is what this workflow actually needs:
four reference images in one request, image-to-image editing, identity
reference, strong instruction following, and consistency across references. A
generic text-to-image model cannot do this.

The four references are sent in **one request**, each preceded by a caption
naming its role:

```
IMAGE 1 = PERSON REFERENCE (identity)
IMAGE 2 = GOWN / ROBE REFERENCE
IMAGE 3 = HOOD / STOLE REFERENCE
IMAGE 4 = MORTARBOARD / CAP REFERENCE
```

### Model ladder

If the configured model is not available to your key, the adapter walks down
this list automatically instead of failing:

| Model                         | Name              |
| ----------------------------- | ----------------- |
| `gemini-3.1-flash-image`      | Nano Banana 2 — **default** |
| `gemini-3-pro-image`          | Nano Banana Pro   |
| `gemini-2.5-flash-image`      | Nano Banana       |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite |

Override with `GEMINI_IMAGE_MODEL`.

### Two API surfaces

Google moved image generation to the **Interactions API** while
`:generateContent` remains available. The adapter tries them in that order, per
model, because a 404 can mean either "unknown model" or "this surface is not
enabled for this project" and the two are not reliably separable:

1. `POST /v1beta/interactions`
2. `POST /v1beta/models/{model}:generateContent`

Responses are parsed with a tolerant search for inline base64 image data, so a
field rename on Google's side does not break generation.

---

## Provider: Hugging Face Inference Providers

```ini
HF_TOKEN=hf_xxx        # https://huggingface.co/settings/tokens
AI_PROVIDER=hf
```

HF routes each model to the third-party GPU provider that serves it. The
adapter walks a ladder, **preferring models that can actually use the uploads**:

| Model | Route | Uses your photos | Identity |
| --- | --- | --- | --- |
| `Qwen/Qwen-Image-Edit-2509` | fal-ai | yes, 3 refs | preserved |
| `black-forest-labs/FLUX.1-Kontext-dev` | fal-ai | yes, 1 ref | preserved |
| `black-forest-labs/FLUX.1-Kontext-dev` | replicate | yes, 1 ref | preserved |
| `black-forest-labs/FLUX.1-schnell` | nscale | **no** | **invented** |
| `black-forest-labs/FLUX.1-dev` | fal-ai | **no** | **invented** |

### Why the last two are opt-in

FLUX.1-dev and FLUX.1-schnell are **text-to-image** models. They accept a
prompt and nothing else, so the uploaded person, gown, hood and cap never reach
them. They produce a convincing graduation photo **of a stranger**, which is
not what this product promises.

They are therefore disabled unless `HF_ALLOW_TEXT_TO_IMAGE=1`. When one is used
the API returns `identityPreserved: false` plus a `warning`, and the result page
tells the user the face is not theirs.

### Cost

Image-editing models are billed per call through HF. A free account includes a
small monthly credit allowance; once spent, edit models return **402** and only
the cheaper text-to-image route keeps working. Add credits or subscribe to PRO
at <https://huggingface.co/settings/billing>.

### Error handling

| Status | Behaviour |
| --- | --- |
| 401 / 403 | token rejected — stops the ladder |
| 402 | credits exhausted for that provider — **tries the next model** |
| 429 | rate limited — tries the next model |
| 400 / 422 | request rejected — tries the next model |
| 503 | model cold-starting — tries the next model |

---

## Deploying to Vercel

```bash
npm i -g vercel
vercel link
vercel env add HF_TOKEN production
vercel env add AI_PROVIDER production      # value: hf
vercel --prod
```

`vercel.json` serves `public/` statically and exposes `api/config.js` and
`api/generate.js` as functions. Both reuse the same `server/` modules as the
standalone server, so local and deployed behaviour match.

**Platform limits that matter here**

- **Function duration** — 60s on Hobby, 300s on Pro. One generation takes
  10-40s, but walking a failing ladder can exceed 60s. Keep `AI_TIMEOUT_MS`
  below the ceiling and pin `HF_MODEL` in production to avoid long fallbacks.
- **Request body** — 4.5 MB. The browser shrinks the four references to stay
  under ~3.6 MB before sending.


---

## Provider chain and fallback

```
generateVirtualOutfit()
   → gemini    fails? →
   → fal       fails? →
   → replicate fails? →  error
```

A failure of any kind — API error, timeout, quota, unavailable model, network
fault, unusable response — moves to the next provider automatically. The user
sees an error only once **every** provider has failed.

```ini
AI_PROVIDER=gemini
AI_PROVIDER_CHAIN=gemini,fal,replicate
```

Leave `AI_PROVIDER_CHAIN` empty and the chain becomes the primary provider
followed by every other provider that has a key. Providers without credentials
are skipped rather than attempted.

| Provider    | Key env              | Default model             |
| ----------- | -------------------- | ------------------------- |
| `gemini`    | `GEMINI_API_KEY`     | `gemini-3.1-flash-image`  |
| `fal`       | `FAL_KEY`            | `fal-ai/nano-banana/edit` |
| `replicate` | `REPLICATE_API_TOKEN`| `google/nano-banana`      |
| `openai`    | `OPENAI_API_KEY`     | `gpt-image-1`             |
| `fashn`     | `FASHN_API_KEY`      | `tryon-v1.6`              |

**Demo mode is a last resort only.** It runs when no provider has a credential
at all. It is never substituted after a real provider fails — a failure shows
the error screen rather than a fake result, and the demo asset is always
labelled as a demonstration.

**On FASHN:** it is a true try-on model but takes one garment and no text
prompt, so the three components must be applied in sequential passes and the
role captions are lost. It is available but is not a good fit for this
four-reference workflow; the multi-reference providers are.

---

## How it works

```
Browser  ──►  POST /api/generate  ──►  provider chain  ──►  image model
   ▲                                                            │
   └────────────  inline image (data URL)  ◄───────────────────┘
```

The browser never talks to an AI provider and never sees an API key. It only
calls this application's own backend.

`generateVirtualOutfit()` in [`server/generate.js`](server/generate.js) is the
single abstraction the rest of the app uses. Every adapter in
[`server/providers/`](server/providers/) has the same signature, so changing or
reordering providers is configuration, not code.

### The internal prompt

[`server/prompt.js`](server/prompt.js) builds the prompt from the references
that were actually uploaded. It maps each image to its role, states that the
three garment images are components of **one** outfit, and constrains identity
preservation, product fidelity, single-person output and photorealism.

It is a backend-only asset — never returned by the API, never rendered in the
browser. `DEBUG_PROMPT=1` prints it to the server console during development.

---

## Input tolerance

Imperfect references are expected and handled by the model, not blocked by the
app. Blurry faces, low-resolution garments, cropped gowns, mixed aspect ratios,
poor lighting and busy backgrounds all generate anyway — the prompt explicitly
instructs the model to reconstruct missing information and never to refuse
because a reference is imperfect.

Uploads are refused **only** for technical and security reasons, checked in the
browser and re-checked on the server:

- **Format** — JPG, JPEG, PNG, WEBP only, confirmed by magic bytes so a renamed
  file cannot slip through.
- **Structure** — the bytes must really be a valid image of that type.
- **Size** — 20 MB per image, 60 MB per request.

There is no sharpness, resolution or face-detection gate.

---

## Project layout

```
server/
  index.js            HTTP server, static files, /api routes
  config.js           .env loading, provider chain, credentials, limits
  validate.js         format / structure / size checks
  prompt.js           internal four-role generation prompt
  generate.js         generateVirtualOutfit() + chain with fallback
  providers/
    gemini.js         two API surfaces + model ladder
    fal.js  replicate.js  fashn.js  openai.js  demo.js
scripts/
  check-provider.mjs  live end-to-end check against the real API
public/
  index.html  styles.css  app.js  demo/
```

---

## Privacy

- Uploads are held in memory for the duration of the request. **Nothing is
  written to disk**, so there is no stored copy to expire or clean up.
- The generated image is returned inline as a data URL, so the browser never
  contacts the provider's storage.
- When a provider is configured the images *are* sent to that third party for
  the duration of the render — the interface says so explicitly rather than
  claiming a deletion the backend cannot guarantee.
- In demo mode no image leaves the machine.

---

## Configuration reference

| Variable              | Default                  | Purpose                                |
| --------------------- | ------------------------ | -------------------------------------- |
| `GEMINI_API_KEY`      | —                        | Gemini credential. Backend only.       |
| `GEMINI_IMAGE_MODEL`  | `gemini-3.1-flash-image` | Primary image model.                   |
| `GEMINI_IMAGE_SIZE`   | `2K`                     | Requested output size: 1K / 2K / 4K.   |
| `GEMINI_API_BASE`     | official endpoint        | Point at a proxy, gateway or mock.     |
| `AI_PROVIDER`         | `gemini`                 | Provider tried first.                  |
| `AI_PROVIDER_CHAIN`   | derived                  | Explicit ordered fallback chain.       |
| `FAL_KEY` etc.        | —                        | Optional fallback provider keys.       |
| `AI_ASPECT_RATIO`     | `3:4`                    | Output ratio hint.                     |
| `AI_TIMEOUT_MS`       | `180000`                 | Per-provider budget, enforced centrally. |
| `PORT`                | `3000`                   | HTTP port.                             |
| `DEBUG_PROMPT`        | `0`                      | Print the internal prompt. Dev only.   |

Never commit `.env`; it is git-ignored. No key is ever sent to the browser —
`/api/config` returns only the provider name, model, chain and limits.
