# RNXA Timesheet · Backend API

Node 22+, Express 5, TypeScript, Prisma 6 on MongoDB Atlas, Claude via `@anthropic-ai/sdk`. The web app lives in the companion repo **rnxa-timesheet-frontend**.

## Run locally

```bash
npm install
npx prisma generate
cp .env.example .env   # then fill in the values
npm run db:setup       # syncs indexes and seeds the policy and super admin
npm run dev
```

## Deploy (Render)

- **Build command:** `npm ci --include=dev && npx prisma generate && npm run build`
- **Start command:** `npm start`
- **Health check:** `/api/health`
- **Environment:** the variables in `.env.example`, with `NODE_ENV=production`. Set `TRUST_PROXY_HOPS=2` when the frontend reaches the API through a Vercel rewrite.
- **Database access:** MongoDB Atlas must allow Render's outbound IPs (or 0.0.0.0/0) under Network Access.
- **Uploaded files:** attachments are stored in `UPLOAD_DIR`. On Render's free plan the disk is reset on every deploy, so attach a persistent disk (paid) or move storage to S3 or another object store.

## Tests

```bash
npm test
```

Tests run against a separate `rnxats_test` database derived from `DATABASE_URL`.
