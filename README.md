# brkdllc.com

Marketing site for Brookfield Digital. Astro 6 static site hosted on Cloudflare Pages. The contact form is backed by a Cloudflare Pages Function that relays messages through [Amazon SES](https://aws.amazon.com/ses/) (v2 `SendEmail`, SigV4-signed fetch via [`aws4fetch`](https://github.com/mhart/aws4fetch)).

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

The function validates input, drops submissions where the hidden `website` honeypot is filled, rate-limits each client IP to 5 submissions per 10 minutes, and forwards the message to `eric@brkdllc.com` via Amazon SES.

### Required environment variables

Configure these in the Cloudflare dashboard under **Pages → brkdllc-com → Settings → Environment variables** (set them for both Production and Preview):

| Name                        | Required | Notes                                                                                      |
| :-------------------------- | :------- | :----------------------------------------------------------------------------------------- |
| `AWS_SES_ACCESS_KEY_ID`     | yes      | IAM access key ID scoped to `ses:SendEmail` on the verified identity. **Encrypted.**       |
| `AWS_SES_SECRET_ACCESS_KEY` | yes      | Matching secret key. **Encrypted.**                                                        |
| `AWS_SES_REGION`            | no       | SES region the identity is verified in (default `us-east-1`).                              |
| `AWS_SES_SESSION_TOKEN`     | no       | Only needed for temporary STS credentials.                                                 |
| `CONTACT_FROM`              | no       | Override the from address (default `Brookfield Digital <eric@brkdllc.com>`). Must be a verified SES identity. |
| `CONTACT_TO`                | no       | Override the destination address (default `eric@brkdllc.com`).                             |

### IAM policy for the access key

Create a dedicated IAM user (or use an existing scoped credential) with the minimum policy below, replacing `IDENTITY_ARN` with the ARN of the verified SES identity (domain or email):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail"],
      "Resource": "IDENTITY_ARN"
    }
  ]
}
```

### SES sender setup

- Verify the sender identity in the SES console (either the `brkdllc.com` domain or the `eric@brkdllc.com` email).
- If the SES account is still in the sandbox, also verify `eric@brkdllc.com` as a destination or request production access.
- Set `CONTACT_FROM` to a verified identity. `Reply-To` is automatically set to the submitter's address so replies go straight to them.

### Optional KV rate limit binding

By default the rate limiter uses an in-memory `Map`, which is sufficient for low traffic but resets per Worker instance. For durable rate limiting, create a KV namespace and bind it as `CONTACT_RATE_LIMIT`:

```sh
npx wrangler kv namespace create CONTACT_RATE_LIMIT
# Then in Pages → Settings → Functions → KV namespace bindings:
#   Variable name: CONTACT_RATE_LIMIT → bind to the namespace above.
```

### Local testing with Functions

`astro dev` does not run Pages Functions. To test `/api/contact` locally, build and run with Wrangler:

```sh
npm run build
AWS_SES_ACCESS_KEY_ID=... \
AWS_SES_SECRET_ACCESS_KEY=... \
AWS_SES_REGION=us-east-1 \
npx wrangler pages dev dist --local
```

Then POST to `http://localhost:8788/api/contact`.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds the Astro site and runs `wrangler pages deploy dist/`. The `functions/` directory is picked up automatically from the project root.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN` — Pages: Edit permission
- `CLOUDFLARE_ACCOUNT_ID`
