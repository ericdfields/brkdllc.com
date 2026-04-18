# brkdllc.com

Marketing site for Brookfield Digital. Astro 6 static site deployed as a **Cloudflare Worker with Assets** (Worker name `brookfield-digital`, custom domain `brkdllc.com`). The contact form is handled by the same Worker and relays messages through [Amazon SES](https://aws.amazon.com/ses/) (v2 `SendEmail`, SigV4-signed fetch via [`aws4fetch`](https://github.com/mhart/aws4fetch)).

## Commands

| Command           | Action                                                   |
| :---------------- | :------------------------------------------------------- |
| `npm install`     | Install dependencies                                     |
| `npm run dev`     | Astro dev server at `http://localhost:4321` (no Worker)  |
| `npm run build`   | Build static assets to `./dist/`                         |
| `npm run preview` | Preview the built site with Astro                        |

## Structure

```
./
├── src/
│   ├── worker.ts          Cloudflare Worker entry (API + asset fallthrough)
│   ├── pages/             Astro pages
│   ├── layouts/
│   └── components/
├── public/                Static assets copied into dist/
├── wrangler.jsonc         Worker + Assets config
└── .github/workflows/deploy.yml
```

## Contact form backend

`POST /api/contact` accepts either JSON or form-encoded payloads:

```json
{ "name": "...", "email": "...", "message": "...", "website": "" }
```

The Worker validates input, silently drops submissions where the hidden `website` honeypot is filled, rate-limits each client IP to 5 submissions per 10 minutes, and forwards the message to `eric@brkdllc.com` via Amazon SES.

### Required secrets / vars

Configure on the `brookfield-digital` Worker. Secrets via `wrangler secret put`, plain vars via `wrangler.jsonc` → `vars` or the dashboard.

| Name                        | Kind   | Required | Notes                                                                                      |
| :-------------------------- | :----- | :------- | :----------------------------------------------------------------------------------------- |
| `AWS_SES_ACCESS_KEY_ID`     | secret | yes      | IAM access key ID scoped to `ses:SendEmail` on the verified identity.                      |
| `AWS_SES_SECRET_ACCESS_KEY` | secret | yes      | Matching secret key.                                                                        |
| `AWS_SES_REGION`            | var    | no       | SES region the identity is verified in (default `us-east-1` in `wrangler.jsonc`).          |
| `AWS_SES_SESSION_TOKEN`     | secret | no       | Only needed for temporary STS credentials.                                                 |
| `CONTACT_FROM`              | var    | no       | Override from address (default `Brookfield Digital <eric@brkdllc.com>`). Must be a verified SES identity. |
| `CONTACT_TO`                | var    | no       | Override destination (default `eric@brkdllc.com`).                                         |

Set the secrets:

```sh
npx wrangler secret put AWS_SES_ACCESS_KEY_ID
npx wrangler secret put AWS_SES_SECRET_ACCESS_KEY
```

### IAM policy for the access key

Minimum policy — replace `IDENTITY_ARN` with the ARN of the verified SES identity (domain or email):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["ses:SendEmail"], "Resource": "IDENTITY_ARN" }
  ]
}
```

### SES sender setup

- Verify the sender identity in the SES console (either the `brkdllc.com` domain or the `eric@brkdllc.com` email).
- If SES is still in sandbox, verify `eric@brkdllc.com` as a destination too, or request production access.
- `CONTACT_FROM` must be a verified identity. `Reply-To` is automatically set to the submitter's address so replies land with them.

### Optional KV rate limit binding

By default the rate limiter uses an in-memory `Map`, which is sufficient for low traffic but resets per Worker instance. For durable rate limiting, create a KV namespace and add a binding named `CONTACT_RATE_LIMIT`:

```sh
npx wrangler kv namespace create CONTACT_RATE_LIMIT
# Add the returned id as a kv_namespaces binding in wrangler.jsonc:
# "kv_namespaces": [{ "binding": "CONTACT_RATE_LIMIT", "id": "..." }]
```

### Local testing

`astro dev` does not run the Worker. To test `/api/contact` locally, build and run with Wrangler:

```sh
npm run build
AWS_SES_ACCESS_KEY_ID=... \
AWS_SES_SECRET_ACCESS_KEY=... \
npx wrangler dev
```

Then POST to `http://localhost:8787/api/contact`.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds the site and runs `wrangler deploy`. The Worker serves `./dist/` as static assets via the `ASSETS` binding and intercepts `/api/*` requests.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — needs `Account → Cloudflare Pages → Edit`, `Account → Workers Scripts → Edit`, `Account → Account Settings → Read`, and `User → User Details → Read`
- `CLOUDFLARE_ACCOUNT_ID` — `50e564a0884c74905e9312d0f9506c2a`

To deploy manually:

```sh
npm run build
npx wrangler deploy
```
