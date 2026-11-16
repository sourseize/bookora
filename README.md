# Bookora

**Your business. Your time. Beautifully organised.**

Bookora is an appointment booking and business-management application for small service businesses, including salons, wellness providers, tutors, trainers, and consultants.

## Product overview

Bookora is being built around reliable scheduling, clear staff availability, safe appointment management, and a simple customer booking experience. Its design direction combines deep teal and emerald with warm neutrals and restrained gold accents.

## Architecture

The implementation plan selects TypeScript, React with Vite, an Express API, and SQLite as the initial persistence layer. Server-side authorization and business rules are authoritative; scheduling logic will remain separate from the UI and persistence code.

See [plan/PLAN.md](./plan/PLAN.md) for the architecture decisions, data model, feature sequence, scheduling rules, security requirements, and progress. This working plan is intentionally ignored by Git.

## Prerequisites

- Node.js 20.19+ or 22.12+
- npm

## Installation, build, and run

```powershell
npm install
npm run dev
```

Open the Vite URL printed in the terminal (by default, `http://127.0.0.1:5173`). The development server proxies API requests to the local Express server.

Create and verify a production build with:

```powershell
npm run typecheck
npm run build
npm start
```

The production server serves both the API and the built client on port `3000` by default.

## Configuration and database

The server reads configuration from its environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; configure for the deployment environment |
| `DATABASE_PATH` | `data/bookora.sqlite` | SQLite database file |
| `APP_ORIGIN` | `http://localhost:5173` | Base URL used in account emails |
| `SMTP_HOST`, `SMTP_PORT` | — | SMTP server used for reset and staff-invitation emails |
| `SMTP_USER`, `SMTP_PASSWORD` | — | SMTP credentials |
| `SMTP_FROM` | — | Verified sender address |

The database schema is initialized when the server starts. Back up the SQLite file before replacing or moving it. Password reset and staff invitation delivery require all SMTP settings; those endpoints report an explicit configuration error if they are missing. In production, set `NODE_ENV=production` so session cookies are marked `Secure`, serve the application over HTTPS, and set `APP_ORIGIN` to the canonical HTTPS URL.

Local environment files and database files are intentionally excluded from Git. The working implementation plan is kept at [plan/PLAN.md](./plan/PLAN.md) and is intentionally ignored by Git.

## Manual verification

Run `npm run typecheck` and `npm run build`, then start the server and verify:

1. Register an owner and confirm the account screen shows the business name.
2. Register a customer and confirm the business API is forbidden to that account.
3. Sign out and confirm the old session no longer accesses protected endpoints.
4. Try an incorrect password, missing CSRF header on sign-out, and invalid registration values; each should be rejected.
5. Configure SMTP and verify a reset link and owner-issued staff invitation can be used once and expire as described.
