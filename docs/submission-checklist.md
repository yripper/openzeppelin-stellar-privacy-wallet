# Submission checklist

## Done (repo state as of this commit)

- [x] `pnpm test` green across `app` (119 tests), `api` (173 tests, with a
      local Postgres up), `packages/shared` (7 tests), and `packages/ctd-sdk`'s
      verified subset (`parity.mjs` 7 cases, `prove.mjs` 3 real proofs). See
      README's [Testing](../README.md#testing) section for the one known,
      pre-existing gap (`disclosure.mjs`, an unvendored sibling package —
      documented since Task 4, unrelated to this task).
- [x] `pnpm build` green across every buildable workspace package.
- [x] Deployed to Railway: app + api + worker + managed Postgres, all live
      (URLs below).
- [x] README: pitch, architecture diagram, monorepo layout, local run
      instructions (every command verified by actually running it), deployed
      URLs, contract addresses, bootnode usage doc for other builders,
      compliance story, attribution, license note.
- [x] `docs/demo-script.md` — a 3-4 minute recording script matching the
      spec's demo story.
- [x] Unified Activity view (CT + SPP boundary events), error humanization
      (CT contract codes, relayer errors, SPP pool contract errors),
      empty/loading states — see `docs/modules/app.md`'s Task 14 entry.
- [x] Per-module docs (`docs/modules/`) updated in the same commits as the
      code they describe.

## Not this task's job — user actions required

### 1. Create the GitHub repo and push

**This repo has no git remote configured** (`git remote -v` returns
nothing) — pushing to GitHub was explicitly out of scope for this task and
was not done. To make the repo public on GitHub:

```bash
# From the repo root:
gh repo create <your-org-or-username>/grantfox-privacy-wallet --public --source=. --remote=origin
git push -u origin main
```

(Or, without the `gh` CLI: create an empty public repo on github.com first,
then `git remote add origin <the repo's URL>` and `git push -u origin main`.)

**Before pushing**, double-check nothing secret is staged — the repo-root
`.env` (with `CT_AUDITOR_SECRET_HEX` and the local `DATABASE_URL`) is
already gitignored (`.gitignore`), but it's worth a final
`git status`/`git diff --cached` pass to be sure.

### 2. Record the demo video

Follow `docs/demo-script.md`. The user records this — it wasn't automated as
part of this task.

### 3. Find and fill out the actual hackathon submission form

**No specific hackathon submission portal/URL is captured anywhere in this
repo's docs** (`docs/superpowers/specs/`'s design doc names a Tuesday
deadline and the requirements — public GitHub repo, demo video, "100%
original app code" — but not a submission platform). Don't invent one here;
use whatever portal/form the hackathon you're entering actually specifies,
and fill in:

- **GitHub repo URL** — from step 1 above (must be public).
- **Demo video** — from step 2 above (upload to whatever the form asks for —
  YouTube unlisted link, direct upload, etc.).
- **Live app URL**: https://app-production-2f5e.up.railway.app
- **Live API URL**: https://api-production-70a0.up.railway.app
- **Write-up / README**: this repo's `README.md` — it already covers the
  pitch, architecture, and the bootnode-for-other-builders differentiator,
  so it should cover most "project description" fields directly.

## Quick links

| What | Where |
|---|---|
| Wallet app | https://app-production-2f5e.up.railway.app |
| API health | https://api-production-70a0.up.railway.app/health |
| Bootnode (for other SPP builders) | https://api-production-70a0.up.railway.app/rpc |
| README | [`README.md`](../README.md) |
| Demo script | [`docs/demo-script.md`](demo-script.md) |
| Module docs index | [`docs/modules/README.md`](modules/README.md) |
