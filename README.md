# brkdllc.com

Marketing site for Brookfield Digital. Astro 6 static site hosted on Cloudflare Pages. The contact form is backed by a Cloudflare Pages Function that relays messages through [Resend](https://resend.com).

## Commands

| Command           | Action                                    |
| :---------------- | :---------------------------------------- |
| `npm install`     | Install dependencies                      |
| `npm run dev`     | Astro dev server at `http://localhost:4321` (no Functions) |
| `npm run build`   | Build to `./dist/`                        |
| `npm run preview` | Preview the built site with Astro         |

## Structure

```
./
├── functions/api/contact.ts   Cloudflare Pages Function — contact form backend
├── public/                    Static assets
└── src/                       Astro pages, layouts, components
```

## Contact form backend

`POST /api/contact` accepts either JSON or form-encoded payloads:

```json
{ "name": "...", "email": "...", "message": "...", "website": "" }
```

The function validates input, drops submissions where the hidden `website` honeypot is filled, rate-limits each client IP to 5 submissions per 10 minutes, and forwards the message to `eric@brkdllc.com` via Resend.

### Required environment variables

Configure these in the Cloudflare dashboard under **Pages → brkdllc-com → Settings → Environment variables** (set them for both Production and Preview):

| Name              | Required | Notes                                                                                     |
| :---------------- | :------- | :---------------------------------------------------------------------------------------- |
| `RESEND_API_KEY`  | yes      | Create at https://resend.com/api-keys. Store as an **encrypted** environment variable.    |
| `CONTACT_FROM`    | no       | Override the from address (defaults to `Brookfield Digital <onboarding@resend.dev>`).     |
| `CONTACT_TO`      | no       | Override the destination address (defaults to `eric@brkdllc.com`).                        |

### Optional KV rate limit binding

By default the rate limiter uses an in-memory `Map`, which is sufficient for low traffic but resets per Worker instance. For durable rate limiting, create a KV namespace and bind it as `CONTACT_RATE_LIMIT`:

```sh
npx wrangler kv namespace create CONTACT_RATE_LIMIT
# Then in Pages → Settings → Functions → KV namespace bindings:
#   Variable name: CONTACT_RATE_LIMIT → bind to the namespace above.
```

### Resend sender setup

Resend's sandbox `onboarding@resend.dev` sender works immediately and is fine for launch. To send from `@brkdllc.com`, verify the domain at https://resend.com/domains (adds SPF, DKIM, and DMARC records to your DNS) and set `CONTACT_FROM` to e.g. `Eric Brookfield <eric@brkdllc.com>`.

### Local testing with Functions

`astro dev` does not run Pages Functions. To test `/api/contact` locally, build and run with Wrangler:

```sh
npm run build
RESEND_API_KEY=re_... npx wrangler pages dev dist --local
```

Then POST to `http://localhost:8788/api/contact`.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds the Astro site and runs `wrangler pages deploy dist/`. The `functions/` directory is picked up automatically from the project root.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — Pages: Edit permission
- `CLOUDFLARE_ACCOUNT_ID`
