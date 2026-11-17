# bulk-to-text

Drop many images (JPG, PNG, WebP, HEIC; a hundred or more at once, or a whole folder) on a web page and get the text out of each one. Claude (Anthropic API) reads the images. Lives at https://bulk-to-text.peytonhunter.com.

The server is stateless: it never stores images or text. Each image is posted on its own to `POST /api/ocr`, converted if needed (HEIC, sideways or over 2000 px becomes an upright JPEG), sent to Claude, and the text is returned. The browser runs four at a time, retries busy answers with backoff, and builds the downloads (one combined `.txt`, or a `.zip` with one `.txt` per image).

## Run it

```sh
npm install
APP_PASSWORD=pick-one SESSION_SECRET=$(openssl rand -hex 32) ANTHROPIC_API_KEY=sk-ant-... npm start   # serves dist/web after npm run build
npm run dev   # Vite on :5173, proxying /api to :3000
```

| Env | |
|---|---|
| `APP_PASSWORD` | The one shared login password. Required. |
| `SESSION_SECRET` | Signs the login cookie. At least 32 characters. Required. |
| `ANTHROPIC_API_KEY` | Without it the app runs and says reading isn't set up yet. |
| `OCR_MODEL` | Default `claude-opus-5-5`. Costs shown in the app come from the price table in `src/server/ocr.ts`. |
| `ANTHROPIC_BASE_URL` | Only for tests (the fake API). |

Each read logs one JSON line: model, tokens and cost in USD.

## Checks

`npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e` (starts the real server against a fake Anthropic API).

## Deploy

CI builds `ghcr.io/peyhunter/bulk-to-text` and writes the new tag into `deploy/kustomization.yaml`; Argo CD syncs `deploy/`. First time only: run `scripts/make-secrets.sh` on k3s-1.
