# Atelier — AI Virtual Outfit Studio

A standalone web application with a single purpose: produce a highly realistic
image of a specific person wearing a specific custom graduation robe.

The user uploads **one photo of a person** and **three images of the outfit's
components**. The application combines them into **one photorealistic
photograph** of that person wearing that exact outfit.

> One real person + three exact outfit references → one highly realistic image
> of that person wearing that exact outfit.

---

## Quick start

```bash
npm start
```

Then open <http://localhost:3000>.

There is nothing to install — the project has **zero runtime dependencies** and
runs on Node 18.17+ (developed on Node 24).

Without an API key the app runs in **demo mode**: the whole interface works and
a clearly-labelled demonstration asset stands in for the generated image.

## Enabling real generation

```bash
cp .env.example .env
```

Then set:

```ini
AI_PROVIDER=gemini
AI_API_KEY=your-key-here
```

Restart the server. The "Mode démonstration" badge disappears once a provider
is configured.

### Supported providers

| `AI_PROVIDER` | Default model            | Notes                                                        |
| ------------- | ------------------------ | ------------------------------------------------------------ |
| `gemini`      | `gemini-2.5-flash-image` | Multi-image editing. Each reference is captioned with its role. |
| `fal`         | `fal-ai/nano-banana/edit`| Any fal model taking `prompt` + `image_urls`.                 |
| `replicate`   | `google/nano-banana`     | Set `AI_INPUT_IMAGES_KEY` if the model names its image array differently. |
| `fashn`       | `tryon-v1.6`             | True VTON. See the caveat below.                              |
| `openai`      | `gpt-image-1`            | Multipart image edits.                                        |
| `demo`        | —                        | No network calls at all.                                      |

Override the model with `AI_MODEL`.

**FASHN caveat:** FASHN dresses one model image with one garment image and
accepts no text prompt. The three components are therefore applied
*sequentially* — each pass's output becomes the next pass's model image. Identity
preservation and product fidelity come from the model itself, not from the
internal prompt. The multi-reference providers (`gemini`, `fal`, `replicate`,
`openai`) receive all four images together and are the better fit for this brief.

## How it works

```
Browser  ──►  POST /api/generate  ──►  provider adapter  ──►  image model
   ▲                                                              │
   └──────────────  inline image (data URL)  ◄────────────────────┘
```

The browser never talks to an AI provider and never sees an API key. It only
calls this application's own backend.

`generateVirtualOutfit()` in [`server/generate.js`](server/generate.js) is the
single abstraction the rest of the app uses. Every adapter in
[`server/providers/`](server/providers/) exposes the same signature, so changing
provider is a configuration change rather than a code change.

### The internal prompt

[`server/prompt.js`](server/prompt.js) builds the generation prompt dynamically
from the references that were actually uploaded. It maps each image to a role
(identity / robe / detailing / accessory), states that the three garment images
are components of **one** outfit, and constrains the model on identity
preservation, product fidelity, and photorealism.

This prompt is a backend-only asset. It is never returned by the API and never
rendered in the browser. Set `DEBUG_PROMPT=1` to print it to the server console
during development.

## Project layout

```
server/
  index.js            HTTP server, static files, /api routes
  config.js           .env loading, provider resolution, limits
  validate.js         format / size / dimension / magic-byte checks
  prompt.js           internal generation prompt
  generate.js         generateVirtualOutfit() + provider registry
  providers/          one adapter per provider, same signature
public/
  index.html          landing, 4-step wizard, review, loading, result, error
  styles.css          design system
  app.js              upload handling, validation, generation, result
  demo/               demonstration asset used in demo mode
```

## Image validation

Checked in the browser *and* re-checked on the server (the browser's answer is
never trusted):

- **Format** — JPG, JPEG, PNG, WEBP only; the server confirms with magic bytes,
  so a renamed file cannot slip through.
- **Size** — 15 MB per image, 40 MB per request.
- **Dimensions** — parsed from the file header; below 200 px the image is
  rejected.
- **Readability** — the file must decode.

The browser additionally offers *advisory* hints it cannot prove: a
Laplacian-variance sharpness estimate flags blurry uploads, and the platform
face detector is consulted when the browser exposes one. These produce guidance,
never a blocked upload.

## Privacy

- Uploads are held in memory for the duration of the request. **Nothing is
  written to disk**, so there is no stored copy to expire or clean up.
- The generated image is returned inline as a data URL, so the browser never
  contacts the provider's storage.
- When a provider is configured, the images *are* sent to that third party for
  the duration of the render — the interface says so explicitly rather than
  claiming deletion the backend cannot guarantee.
- In demo mode no image leaves the machine.

## Configuration reference

| Variable              | Default    | Purpose                                        |
| --------------------- | ---------- | ---------------------------------------------- |
| `AI_PROVIDER`         | `demo`     | Which adapter to use.                          |
| `AI_API_KEY`          | —          | Provider credential. Backend only.             |
| `AI_MODEL`            | per provider | Override the default model.                  |
| `AI_INPUT_IMAGES_KEY` | `image_input` | Replicate: name of the image array field.   |
| `AI_ASPECT_RATIO`     | `3:4`      | Output ratio hint.                             |
| `AI_TIMEOUT_MS`       | `240000`   | Generation budget, enforced centrally.         |
| `PORT`                | `3000`     | HTTP port.                                     |
| `DEBUG_PROMPT`        | `0`        | Print the internal prompt. Development only.   |

An unset key, or an unknown `AI_PROVIDER`, falls back to demo mode and prints a
warning at startup rather than failing at generation time.
