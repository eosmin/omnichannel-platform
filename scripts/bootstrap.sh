#!/usr/bin/env bash
set -euo pipefail

echo "→ Checking prerequisites"
command -v node   >/dev/null || { echo "Node.js 22+ required"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
corepack enable >/dev/null 2>&1 || true          # pnpm version comes from package.json "packageManager"

command -v gitleaks >/dev/null || { echo "gitleaks required by the pre-commit hook: brew install gitleaks (other systems: https://github.com/gitleaks/gitleaks)"; exit 1; }
command -v pnpm   >/dev/null || { echo "pnpm required: run 'corepack enable' (it may need elevated permissions)"; exit 1; }

node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$node_major" -ge 22 ] || { echo "Node.js 22+ required, found $(node -v)"; exit 1; }

echo "→ Installing dependencies"
pnpm install --frozen-lockfile

echo "→ Creating local environment files"
[ -f .env.local ] || cp .env.example .env.local
[ -f apps/web/.env.local ] || cp apps/web/.env.example apps/web/.env.local

echo "→ Starting infrastructure (postgres, pgbouncer, redis, seaweedfs, mailpit, clamav)"
docker compose up -d --wait                      # SeaweedFS creates the S3 bucket itself

echo "→ Migrating the database and loading the development fixtures"
pnpm db:migrate                                  # prisma migrate deploy, then the two role passwords
pnpm db:fixtures

cat <<'DONE'

Setup complete.

  Postgres        localhost:5432   (PgBouncer on localhost:6432)
  Redis           localhost:6379
  S3 (SeaweedFS)  http://localhost:8333   bucket platform-dev
  Mail catcher    http://localhost:8025

DONE
