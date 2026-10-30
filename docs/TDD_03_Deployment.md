# TDD 03 — Deployment, Environments & Migrations

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.

---

## 1. Phase 1 — Google Cloud Run (MVP → product-market fit)

```
Google Cloud
├─ Cloud Run
│  ├─ api-service     (min: 1, max: 20, 1Gi, concurrency 80)     public
│  ├─ web-service     (min: 1, max: 10, 512Mi)                   public
│  ├─ admin-service   (min: 0, max: 2,  512Mi)                   behind Identity-Aware Proxy
│  └─ worker-service  (min: 1, max: 5,  1Gi, CPU always allocated) internal, no ingress
├─ Cloud SQL (PostgreSQL 18.6, HA in production)
├─ Cloud Memorystore (Redis 8.10)
├─ PgBouncer sidecar in api-service and worker-service (edoburu/pgbouncer 1.25)
├─ ClamAV as a Cloud Run service (clamav/clamav 1.5, min 1, internal)
├─ AWS S3 (media, exports, cold audit archive) — cross-cloud on purpose, see TDD_01 §2.3
└─ Cloudflare in front of app.*, api.*, widget.* (TLS, WAF, CDN for static assets)
```

**Why Cloud Run first:** no cluster to operate, pay-per-request pricing suits pre-PMF traffic.
WebSocket works because the Redis Adapter removes the need for sticky sessions; the API
service sets `--timeout=3600` and `--session-affinity` so long-lived sockets are not cut.

**The worker is not request-driven.** A BullMQ worker is a persistent process that pulls
from Redis; Cloud Run only wakes an instance for HTTP traffic. Therefore
`worker-service` runs with `--min-instances=1 --no-cpu-throttling` (CPU always allocated)
and exposes only `/health` for the platform's own probes. Scale-to-zero would mean jobs
are never processed.

**Cloud Build pipeline (one build, three images, four deploys):**
```yaml
# cloudbuild.yaml
substitutions:
  _REGION: us-central1
  _NODE_IMAGE: node:24.20.0-slim

steps:
  - id: install
    name: ${_NODE_IMAGE}
    entrypoint: bash
    args: ['-c', 'corepack enable && corepack prepare pnpm@11.25.0 --activate && pnpm install --frozen-lockfile']

  - id: test
    name: ${_NODE_IMAGE}
    entrypoint: bash
    args: ['-c', 'pnpm nx run-many --target=test --projects=api,worker,web,core-* --parallel=3']

  - id: build-api
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/api:$COMMIT_SHA', '-f', 'apps/api/Dockerfile', '.']
  - id: build-worker
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/worker:$COMMIT_SHA', '-f', 'apps/worker/Dockerfile', '.']
  - id: build-web
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/web:$COMMIT_SHA', '-f', 'apps/web/Dockerfile', '.']
  - id: build-admin
    name: gcr.io/cloud-builders/docker
    args: ['build', '-t', '${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/admin:$COMMIT_SHA', '-f', 'apps/admin/Dockerfile', '.']

  - id: push
    name: gcr.io/cloud-builders/docker
    entrypoint: bash
    args: ['-c', 'docker push --all-tags ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/api && docker push --all-tags ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/worker && docker push --all-tags ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/web && docker push --all-tags ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/admin']

  # Migrations run from a Cloud Run Job that has Cloud SQL access, never from a CI runner.
  - id: migrate
    name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: bash
    args:
      - -c
      - |
        gcloud run jobs update migrate --region=${_REGION} \
          --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/api:$COMMIT_SHA \
          --command=pnpm --args=prisma,migrate,deploy \
          --set-secrets=DIRECT_DATABASE_URL=direct-database-url:latest
        gcloud run jobs execute migrate --region=${_REGION} --wait

  - id: deploy-api
    name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - api-service
      - --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/api:$COMMIT_SHA
      - --region=${_REGION}
      - --min-instances=1
      - --max-instances=20
      - --memory=1Gi
      - --cpu=1
      - --concurrency=80
      - --timeout=3600
      - --session-affinity
      - --set-env-vars=NODE_ENV=production,APP_ROLE=api,COMMIT_SHA=$COMMIT_SHA,PORT=8080
      - --set-secrets=/etc/platform/env=api-env:latest        # One secret holds the full env file, see TDD_05 §1.1

  - id: deploy-worker
    name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - worker-service
      - --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/worker:$COMMIT_SHA
      - --region=${_REGION}
      - --min-instances=1
      - --max-instances=5
      - --memory=1Gi
      - --cpu=1
      - --no-cpu-throttling
      - --ingress=internal
      - --set-env-vars=NODE_ENV=production,APP_ROLE=worker,COMMIT_SHA=$COMMIT_SHA,PORT=8080
      - --set-secrets=/etc/platform/env=worker-env:latest

  - id: deploy-web
    name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args: ['run', 'deploy', 'web-service', '--image=${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/web:$COMMIT_SHA', '--region=${_REGION}', '--min-instances=1', '--max-instances=10', '--memory=512Mi', '--set-secrets=/etc/platform/env=web-env:latest']

  - id: deploy-admin
    name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args: ['run', 'deploy', 'admin-service', '--image=${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/admin:$COMMIT_SHA', '--region=${_REGION}', '--min-instances=0', '--max-instances=2', '--memory=512Mi', '--ingress=internal-and-cloud-load-balancing', '--set-secrets=/etc/platform/env=admin-env:latest']

images:
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/api:$COMMIT_SHA
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/worker:$COMMIT_SHA
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/web:$COMMIT_SHA
  - ${_REGION}-docker.pkg.dev/$PROJECT_ID/platform/admin:$COMMIT_SHA
```

Each service's entrypoint sources `/etc/platform/env` before starting Node, so the
Zod schema in `TDD_02` §9 sees every variable it requires. Rolling back = redeploying the
previous `$COMMIT_SHA` image (§5.4).

**Estimated monthly cost (Phase 1):**
```
Cloud Run (api + web + worker + admin + clamav)   ~$95
Cloud SQL (db-custom-1-3840, HA)                  ~$70
Cloud Memorystore (Basic 1GB)                     ~$50
AWS S3 + egress                                   ~$15
Cloudflare Pro                                    ~$20
Networking                                        ~$20
──────────────────────────────────────────────────────
Total                                             ~$270/month
```

---

## 2. Phase 2 — Kubernetes (only when justified)

**Migration triggers — migrate when ANY two are true:**
- \> 500-1,000 daily active users
- \> 1,000 sustained requests/min
- Cloud Run cost > $500/month
- More than 5 services running 24/7
- Need for network policies or fine-grained resource control

**Target architecture:**
```
Kubernetes Cluster (GKE)
├─ Ingress (Nginx + cert-manager)
├─ Namespace: production
│  ├─ api      (Deployment, 3-10 replicas, HPA)
│  ├─ web      (Deployment, 2-5 replicas, HPA)
│  ├─ admin    (Deployment, 1-2 replicas)
│  ├─ worker   (Deployment, 2-5 replicas, spot nodes)
│  ├─ pgbouncer (Deployment, 2 replicas)
│  ├─ clamav   (Deployment, 1 replica)
│  ├─ Services (ClusterIP)
│  └─ ConfigMaps + Secrets (Vault-injected)
├─ Cloud SQL (managed, outside cluster, reached through the Cloud SQL Auth Proxy sidecar)
├─ Cloud Memorystore (managed, outside cluster)
└─ Namespace: monitoring (Prometheus + Grafana + Loki)
```

**Helm values:**
```yaml
# helm/platform/values.yaml
api:
  image:
    repository: us-central1-docker.pkg.dev/PROJECT_ID/platform/api
    tag: ""            # Set by CI to the commit sha, never "latest"
  replicas: 3
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits:   { cpu: 500m, memory: 1Gi }
  hpa:
    minReplicas: 3
    maxReplicas: 10
    targetCPU: 70

web:
  replicas: 2
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits:   { cpu: 500m, memory: 1Gi }

worker:
  replicas: 2
  nodeSelector: { workload: worker }
  tolerations:
    - key: spot
      operator: Equal
      value: "true"
      effect: NoSchedule
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits:   { cpu: 1000m, memory: 1Gi }
```

**Estimated monthly cost (Phase 2):**
```
GKE control plane                $75
3 nodes (n2-standard-2)          $170
Load Balancer                    $20
Cloud SQL (n2-standard-2, HA)    $160
Cloud Memorystore                $50
──────────────────────────────────────
Total                            ~$475-500/month
```

---

## 3. Environments

### 3.1 Development (local)

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:18.6-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: platform
      POSTGRES_PASSWORD: dev_password
      POSTGRES_DB: platform_dev
      PGBOUNCER_AUTH_PASSWORD: dev_pgbouncer_password
    volumes:
      # Postgres 18 keeps its data in a versioned subdirectory, so the volume is mounted one level up
      - postgres_data:/var/lib/postgresql
      # Creates the pgbouncer role and the SECURITY DEFINER user_lookup function (first start only)
      - ./scripts/postgres-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U platform -d platform_dev"]
      interval: 5s
      timeout: 3s
      retries: 10

  pgbouncer:
    image: edoburu/pgbouncer:v1.25.2-p0
    ports: ["6432:6432"]
    environment:
      # Only names the database and the auth_user password. Every other role (platform_app,
      # platform_worker, the owner) is looked up with auth_query, so no fixed DB_USER
      DATABASE_URL: postgres://pgbouncer:dev_pgbouncer_password@postgres:5432/platform_dev
      LISTEN_PORT: 6432
      AUTH_TYPE: scram-sha-256
      AUTH_USER: pgbouncer
      AUTH_QUERY: SELECT uname, phash FROM pgbouncer.user_lookup($1)
      POOL_MODE: transaction
      MAX_CLIENT_CONN: 1000
      DEFAULT_POOL_SIZE: 25
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -p 6432"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:8.10.1-alpine
    ports: ["6379:6379"]
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10

  # S3-compatible storage. MinIO stopped publishing images in October 2025; SeaweedFS creates
  # the bucket itself from S3_BUCKET.
  seaweedfs:
    image: chrislusf/seaweedfs:4.48
    ports: ["8333:8333"]
    environment:
      AWS_ACCESS_KEY_ID: dev_access_key
      AWS_SECRET_ACCESS_KEY: dev_secret_key
      S3_BUCKET: platform-dev
    volumes:
      - seaweedfs_data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8333/healthz"]
      interval: 5s
      timeout: 3s
      retries: 10

  mailpit:
    image: axllent/mailpit:v1.28
    ports: ["1025:1025", "8025:8025"]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8025/readyz"]
      interval: 5s
      timeout: 3s
      retries: 10

  clamav:
    image: clamav/clamav:1.5.4-debian
    ports: ["3310:3310"]
    volumes:
      - clamav_data:/var/lib/clamav
    healthcheck:
      test: ["CMD", "clamdcheck.sh"]
      interval: 30s
      timeout: 10s
      retries: 20
      start_period: 120s

volumes:
  postgres_data:
  redis_data:
  seaweedfs_data:
  clamav_data:
```

`docker compose up -d --wait` returns only when every healthcheck passes (there is no init container: SeaweedFS creates the bucket). Local `DATABASE_URL` points at `pgbouncer:6432`
exactly like production; `DIRECT_DATABASE_URL` points at `postgres:5432` for migrations.

**Local endpoints:**
```
App              http://localhost:3000
Admin console    http://localhost:3100
API              http://localhost:8080          (routes under /api/v1, staff under /admin/v1)
API docs         http://localhost:8080/docs
Queue dashboard  http://localhost:8080/admin/queues   (staff login required)
Email preview    http://localhost:3001          (pnpm email:dev)
Mail catcher     http://localhost:8025
S3 (SeaweedFS)   http://localhost:8333
Prisma Studio    http://localhost:5555
Storybook        http://localhost:6006
```

### 3.2 Staging

- Cloud Run, same topology as production at minimum sizes
- Cloud SQL db-custom-1-3840 (no HA)
- Redis Basic 1GB
- Synthetic / anonymized data only — **never production data**
- Auto-deploy on merge to `main`

### 3.3 Production

- Cloud Run per §1
- Cloud SQL with HA enabled
- Redis Standard with HA replica
- Cloudflare in front of every public hostname (TLS, WAF, static CDN)
- Deploy only on version tag, with manual approval

### 3.4 Comparison

| Aspect | Development | Staging | Production |
|--------|-------------|---------|------------|
| Infrastructure | Docker Compose | Cloud Run small | Cloud Run / K8s |
| Database | Postgres 18.6 container | Cloud SQL 18.6 | Cloud SQL 18.6 HA |
| Data | Seed fixtures | Synthetic | Real |
| Deploy trigger | `pnpm dev` | Push to `main` | Tag `v*` + approval |
| Cost | $0 | ~$120/mo | ~$270-500/mo |
| Uptime target | N/A | 95% | 99.9% |

---

## 4. CI/CD workflows

Every third-party action is pinned to a **commit SHA** (with the tag as a comment), never a
moving tag. Node and pnpm versions are read from `package.json` (`engines.node`,
`packageManager`) so CI never drifts from `TDD_01` §2.4.

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  security-events: write

env:
  NODE_ENV: test

jobs:
  lint-and-types:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@<sha> # v4.1.0   (reads packageManager from package.json)
      - uses: actions/setup-node@<sha> # v4.4.0
        with: { node-version-file: package.json, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm nx affected --target=lint --base=origin/main --parallel=3
      - run: pnpm nx affected --target=type-check --base=origin/main --parallel=3
      - run: pnpm validate:translations
      - run: pnpm validate:deprecations        # grep-based scanner for removed APIs, TDD_14 §6

  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@<sha> # v4.1.0
      - uses: actions/setup-node@<sha> # v4.4.0
        with: { node-version-file: package.json, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm nx affected --target=test --base=origin/main --parallel=3 -- --coverage
      - uses: codecov/codecov-action@<sha> # v5.4.3

  integration-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18.6-alpine
        env: { POSTGRES_USER: platform, POSTGRES_PASSWORD: test, POSTGRES_DB: platform_test }
        options: >-
          --health-cmd "pg_isready -U platform" --health-interval 5s --health-retries 10
        ports: ['5432:5432']
      redis:
        image: redis:8.10.1-alpine
        options: --health-cmd "redis-cli ping" --health-interval 5s --health-retries 10
        ports: ['6379:6379']
      seaweedfs:
        image: chrislusf/seaweedfs:4.48
        env:
          AWS_ACCESS_KEY_ID: dev_access_key
          AWS_SECRET_ACCESS_KEY: dev_secret_key
          S3_BUCKET: platform-dev
        options: --health-cmd "wget -qO- http://127.0.0.1:8333/healthz" --health-interval 5s --health-retries 10
        ports: ['8333:8333']
    env:
      DATABASE_URL: postgresql://platform:test@localhost:5432/platform_test
      DIRECT_DATABASE_URL: postgresql://platform:test@localhost:5432/platform_test
      REDIS_URL: redis://localhost:6379
      S3_ENDPOINT: http://localhost:8333
      S3_FORCE_PATH_STYLE: "true"
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
      - uses: pnpm/action-setup@<sha> # v4.1.0
      - uses: actions/setup-node@<sha> # v4.4.0
        with: { node-version-file: package.json, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: cp .env.ci .env.test
      - run: pnpm prisma migrate deploy
      - run: pnpm test:integration
      - run: pnpm test:contracts

  security-tests:                      # Required status check — cannot be bypassed (TDD_14 §8)
    runs-on: ubuntu-latest
    services: *integration-services    # Same services block as integration-tests (YAML anchor in the real file)
    env: *integration-env
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
      - uses: pnpm/action-setup@<sha> # v4.1.0
      - uses: actions/setup-node@<sha> # v4.4.0
        with: { node-version-file: package.json, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: cp .env.ci .env.test
      - run: pnpm prisma migrate deploy
      - run: pnpm test:security

  e2e-tests:
    runs-on: ubuntu-latest
    services: *integration-services
    env: *integration-env
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
      - uses: pnpm/action-setup@<sha> # v4.1.0
      - uses: actions/setup-node@<sha> # v4.4.0
        with: { node-version-file: package.json, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: cp .env.ci .env.test
      - run: pnpm prisma migrate deploy && pnpm prisma db seed
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm nx run-many --target=build --projects=api,web
      - run: pnpm test:e2e                 # playwright.config.ts starts api + web via webServer[]
      - uses: actions/upload-artifact@<sha> # v4.6.2
        if: failure()
        with: { name: playwright-report, path: playwright-report/ }

  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@<sha> # v2.3.9
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
      - name: Build image
        run: docker build -t platform/api:${{ github.sha }} -f apps/api/Dockerfile .
      - uses: aquasecurity/trivy-action@<sha> # 0.32.0
        with:
          image-ref: platform/api:${{ github.sha }}
          format: sarif
          output: trivy-results.sarif
          severity: CRITICAL,HIGH
          exit-code: '1'                   # Gate: CRITICAL/HIGH fails the job
          ignore-unfixed: true
      - uses: github/codeql-action/upload-sarif@<sha> # v3.29.2
        if: always()
        with: { sarif_file: trivy-results.sarif }
      - uses: snyk/actions/node@<sha> # 0.4.0
        env: { SNYK_TOKEN: '${{ secrets.SNYK_TOKEN }}' }
        with: { args: --severity-threshold=high --all-projects }

  lighthouse:
    needs: changes
    if: github.event_name == 'pull_request' && needs.changes.outputs.web == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services: { postgres: ..., redis: ..., mailpit: ... }   # as in e2e-tests
    env: { DIRECT_DATABASE_URL: ..., DB_APP_PASSWORD: ..., DB_WORKER_PASSWORD: ... }   # as in e2e-tests
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
      # Node, pnpm, dependencies, migrated database, Chromium: shared with e2e-tests
      - uses: ./.github/actions/web-stack
      # Builds the app, starts the three services, signs in with a magic link and runs the
      # `lighthouse` module over /login and the inbox; budgets from TDD_08 §4.4
      - run: pnpm exec nx run web-e2e:lighthouse --skip-nx-cache
      - uses: actions/upload-artifact@<sha>   # lighthouse-report, if: always()
        if: always()
        with:
          name: lighthouse-report
          path: |
            apps/web-e2e/lighthouse-report
            apps/web-e2e/lighthouse-results
          retention-days: 7
```

Weekly, not per PR: `zaproxy/action-baseline` against staging and Dependabot PRs
(`.github/dependabot.yml`, weekly, grouped by ecosystem).

```yaml
# .github/workflows/deploy-production.yml
name: Deploy Production
on:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write        # Workload Identity Federation, no long-lived GCP keys

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production   # Requires manual approval in GitHub
      url: https://app.platform.com
    steps:
      - uses: actions/checkout@<sha> # v4.2.2
      - uses: google-github-actions/auth@<sha> # v2.1.10
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_DEPLOY_SA }}
      - uses: google-github-actions/setup-gcloud@<sha> # v2.1.4
      - name: Build, migrate and deploy
        run: gcloud builds submit --config cloudbuild.yaml --substitutions=COMMIT_SHA=${{ github.sha }}
```

Tests are not re-run here: a tag can only be cut from a `main` commit whose CI already
passed (branch protection, `TDD_14` §8). Migrations run inside Cloud Build via the
`migrate` Cloud Run Job (§1), which is the only thing with Cloud SQL network access.

---

## 5. Database migrations

### 5.1 Zero-downtime pattern (three phases)

Never deploy a schema change and the code that depends on it in the same release.

```
Phase 1 (Deploy A) — add, stay backward compatible
  Migration: ADD COLUMN new_field (nullable)
  Code A:    reads old_field, ignores new_field

Phase 2 (Deploy B) — dual read, backfill
  Migration: backfill new_field in batches, then SET NOT NULL
  Code B:    reads COALESCE(new_field, old_field), writes both

Phase 3 (Deploy C) — remove old
  Migration: DROP COLUMN old_field
  Code C:    reads only new_field
```

Each phase is a separate, independently deployable release.
Wait until Phase N is stable in production before starting Phase N+1.

### 5.2 Large table operations

```sql
-- Indexes: always CONCURRENTLY on tables > 1M rows
CREATE INDEX CONCURRENTLY idx_messages_store_created
  ON messages (store_id, created_at ASC);

DROP INDEX CONCURRENTLY IF EXISTS idx_messages_old;

-- Backfill in batches, never a single UPDATE
DO $$
DECLARE
  batch_size INT := 1000;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE messages
    SET metadata_v2 = metadata
    WHERE id IN (
      SELECT id FROM messages
      WHERE metadata_v2 IS NULL
      ORDER BY id
      LIMIT batch_size
    );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    PERFORM pg_sleep(0.1);   -- Reduce lock contention
  END LOOP;
END $$;

-- Setting NOT NULL after backfill is fast (no table rewrite in PG 12+)
ALTER TABLE messages ALTER COLUMN metadata_v2 SET NOT NULL;
```

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction: such migrations are written
as a separate migration file with `-- prisma: no-transaction` semantics (Prisma runs each
migration file as a unit; keep concurrent index builds alone in their own file).

### 5.3 Commands

All Prisma commands read `prisma.config.ts` at the repo root (`TDD_01` §2.3), so no
`--schema` flag is ever needed.

```bash
# Development — generates migration, do NOT run in production
pnpm prisma migrate dev --name add_conversation_state

# Review before applying
cat libs/core/database/prisma/migrations/*_add_conversation_state/migration.sql

# Production — explicit, never automatic; executed by the migrate Cloud Run Job
pnpm prisma migrate deploy

# Status check
pnpm prisma migrate status
```

### 5.4 Rollback

Prisma migrations are not auto-reversible. **Every migration must ship with a
rollback script.** Rollbacks live **outside** the `migrations/` directory — Prisma treats
every subdirectory of `migrations/` as a migration and would fail on one without
`migration.sql`.

```
libs/core/database/
├─ prisma/
│  ├─ schema.prisma
│  └─ migrations/
│     ├─ 20260903120000_init/
│     │  └─ migration.sql
│     └─ 20260903120100_raw_sql/
│        └─ migration.sql
└─ rollbacks/
   ├─ 20260903120000_init.rollback.sql
   └─ 20260903120100_raw_sql.rollback.sql
```

```sql
-- rollbacks/20260910090000_add_conversation_priority.rollback.sql
ALTER TABLE conversations DROP COLUMN IF EXISTS priority;

-- Verification query — must return 0
SELECT COUNT(*) FROM information_schema.columns
WHERE table_name = 'conversations' AND column_name = 'priority';
```

A CI check (`scripts/check-rollbacks.ts`) fails when a migration directory has no matching
rollback file.

**Emergency rollback procedure:**
```bash
# 1. Stop writes
gcloud run services update api-service --region=us-central1 --max-instances=0
gcloud run services update worker-service --region=us-central1 --max-instances=0

# 2. Apply rollback SQL through the migrate job (has Cloud SQL access)
gcloud run jobs execute migrate --region=us-central1 --wait \
  --args="psql,\$DIRECT_DATABASE_URL,-f,libs/core/database/rollbacks/TIMESTAMP_name.rollback.sql"

# 3. Mark the migration as rolled back so migrate deploy does not re-apply it
gcloud run jobs execute migrate --region=us-central1 --wait \
  --args="prisma,migrate,resolve,--rolled-back,TIMESTAMP_name"

# 4. Deploy previous images
gcloud run deploy api-service --region=us-central1 --image=us-central1-docker.pkg.dev/$PROJECT_ID/platform/api:$PREVIOUS_SHA
gcloud run deploy worker-service --region=us-central1 --image=us-central1-docker.pkg.dev/$PROJECT_ID/platform/worker:$PREVIOUS_SHA

# 5. Restore capacity
gcloud run services update api-service --region=us-central1 --min-instances=1 --max-instances=20
gcloud run services update worker-service --region=us-central1 --min-instances=1 --max-instances=5

# 6. Verify
curl https://api.platform.com/health/ready
```

### 5.5 Seed data

Seeds must be **idempotent** — safe to run repeatedly. The seed is a script, so
`console.log` is allowed there (`TDD_14` §6 lint override for `**/seed.ts` and `scripts/**`).

```typescript
// libs/core/database/prisma/seed.ts
import { PrismaClient } from '../generated/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { faker } from '@faker-js/faker'
import { hash } from '@node-rs/argon2'
import { RoleNames, RolePresets } from '@platform/core/auth'
import {
  ConversationStatus, MembershipStatus, ChannelType, ChannelConnectionStatus,
  MessageType, AuthorType, DeliveryStatus,
} from '@platform/core/domain'
import { PlanTiers, BillingIntervals, SubscriptionStatus } from '@platform/core/billing'
import { encryptJson } from '@platform/core/crypto'

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL }),
})

const SEED_PASSWORD = 'password123'

async function upsertSystemRole(name: string, permissions: readonly string[]): Promise<{ id: string }> {
  // System roles have storeId = null; uniqueness comes from the partial index in TDD_01 §5,
  // so we look them up explicitly instead of relying on a compound unique.
  const existing = await prisma.role.findFirst({ where: { storeId: null, name } })
  if (existing) return existing
  return prisma.role.create({
    data: { name, isSystem: true, permissions: { create: permissions.map(p => ({ name: p })) } },
  })
}

async function upsertUser(email: string, name: string): Promise<{ id: string }> {
  return prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash: await hash(SEED_PASSWORD), emailVerified: true },
    update: {},
  })
}

async function upsertMembership(userId: string, organizationId: string, storeId: string, roleId: string): Promise<void> {
  await prisma.membership.upsert({
    where: { userId_storeId: { userId, storeId } },
    create: { userId, organizationId, storeId, roleId, status: MembershipStatus.ACTIVE },
    update: {},
  })
}

async function upsertStore(organizationId: string, slug: string, name: string): Promise<{ id: string }> {
  const store = await prisma.store.upsert({
    where: { organizationId_slug: { organizationId, slug } },
    create: {
      organizationId, name, slug,
      timezone: 'America/El_Salvador', currency: 'USD',
      settings: { create: {} },
      retentionSettings: { create: {} },
      aiSettings: { create: {} },
    },
    update: {},
  })
  return store
}

async function main(): Promise<void> {
  // 1. System roles
  const roles = {} as Record<string, { id: string }>
  for (const [roleName, permissions] of Object.entries(RolePresets)) {
    roles[roleName] = await upsertSystemRole(roleName, permissions)
  }

  // 2. Organization on the Free tier (no Stripe objects yet)
  const org = await prisma.organization.upsert({
    where: { slug: 'test-org' },
    create: {
      name: 'Test Organization', slug: 'test-org', billingEmail: 'billing@test.com',
      subscription: {
        create: {
          tier: PlanTiers.FREE, interval: BillingIntervals.MONTHLY, status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: new Date(), currentPeriodEnd: faker.date.soon({ days: 30 }),
        },
      },
      aiCreditBalance: { create: { remaining: 0, periodStart: new Date() } },
    },
    update: {},
  })

  // 3. Two stores — the second one exists so multi-store switching is testable
  const main = await upsertStore(org.id, 'main', 'Main Store')
  const escalon = await upsertStore(org.id, 'tienda-escalon', 'Tienda Escalón')

  // 4. Users — one per role, plus a multi-store user (TDD_13 §4)
  const admin = await upsertUser('admin@test.com', 'Admin User')
  const agent = await upsertUser('agent@test.com', 'Agent User')
  const viewer = await upsertUser('viewer@test.com', 'Viewer User')
  const multi = await upsertUser('multi-store@test.com', 'Multi Store User')

  await upsertMembership(admin.id, org.id, main.id, roles[RoleNames.ADMIN].id)
  await upsertMembership(agent.id, org.id, main.id, roles[RoleNames.AGENT].id)
  await upsertMembership(viewer.id, org.id, main.id, roles[RoleNames.VIEWER].id)
  await upsertMembership(multi.id, org.id, main.id, roles[RoleNames.ADMIN].id)
  await upsertMembership(multi.id, org.id, escalon.id, roles[RoleNames.AGENT].id)

  // 5. A WhatsApp connection for the main store (credentials are dummies, encrypted like real ones)
  const connection = await prisma.channelConnection.upsert({
    where: { pluginId_connectionId: { pluginId: ChannelType.WHATSAPP, connectionId: 'seed-phone-number-id' } },
    create: {
      storeId: main.id, pluginId: ChannelType.WHATSAPP, connectionId: 'seed-phone-number-id',
      displayName: '+503 2222-3333', status: ChannelConnectionStatus.ACTIVE,
      credentials: encryptJson({ accessToken: 'seed-token', businessAccountId: 'seed-waba' }),
    },
    update: {},
  })

  // 6. Tags
  for (const tag of [{ name: 'vip', color: '#8b5cf6' }, { name: 'urgent', color: '#ef4444' }, { name: 'wholesale', color: '#3b82f6' }]) {
    await prisma.tag.upsert({
      where: { storeId_name: { storeId: main.id, name: tag.name } },
      create: { storeId: main.id, ...tag },
      update: {},
    })
  }

  // 7. Products
  for (let i = 0; i < 30; i++) {
    const sku = `SKU-${String(i).padStart(4, '0')}`
    await prisma.product.upsert({
      where: { storeId_sku: { storeId: main.id, sku } },
      create: {
        storeId: main.id, sku,
        name: faker.commerce.productName(),
        description: faker.commerce.productDescription(),
        priceCents: faker.number.int({ min: 500, max: 20000 }),
      },
      update: {},
    })
  }

  // 8. Customers, identities, conversations and messages (only if empty)
  const existingCustomers = await prisma.customer.count({ where: { storeId: main.id } })
  if (existingCustomers === 0) {
    for (let i = 0; i < 25; i++) {
      const phone = `+5037${faker.string.numeric(7)}`
      const customer = await prisma.customer.create({
        data: {
          storeId: main.id,
          name: faker.person.fullName(),
          email: faker.internet.email(),
          phone, phoneNormalized: phone.replace(/\D/g, ''),
        },
      })
      const identity = await prisma.customerIdentity.create({
        data: { storeId: main.id, customerId: customer.id, channelType: ChannelType.WHATSAPP, channelIdentity: phone.replace('+', ''), lastInboundAt: new Date() },
      })
      const conv = await prisma.conversation.create({
        data: {
          storeId: main.id, customerId: customer.id, customerIdentityId: identity.id,
          channelConnectionId: connection.id, channelType: ChannelType.WHATSAPP,
          status: faker.helpers.arrayElement([ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.RESOLVED]),
          lastMessageAt: faker.date.recent({ days: 7 }),
        },
      })
      const messageCount = faker.number.int({ min: 3, max: 15 })
      for (let m = 0; m < messageCount; m++) {
        const fromCustomer = m % 2 === 0
        await prisma.message.create({
          data: {
            storeId: main.id, conversationId: conv.id, type: MessageType.TEXT,
            content: faker.lorem.sentence(),
            authorType: fromCustomer ? AuthorType.CUSTOMER : AuthorType.AGENT,
            authorId: fromCustomer ? null : admin.id,
            channelMessageId: fromCustomer ? `wamid.${faker.string.alphanumeric(20)}` : null,
            deliveryStatus: fromCustomer ? null : DeliveryStatus.DELIVERED,
          },
        })
      }
    }
  }

  console.log('Seed completed')
  console.log(`  org:    ${org.slug}`)
  console.log(`  stores: main (${main.id}), tienda-escalon (${escalon.id})`)
  console.log(`  logins: admin@test.com / agent@test.com / viewer@test.com / multi-store@test.com — ${SEED_PASSWORD}`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
```

---

## 6. Cost optimization

### 6.1 Right-sizing with VPA recommendations (Phase 2)

```bash
# Deploy VPA in recommendation-only mode
kubectl apply -f - <<EOF
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata: { name: api-vpa }
spec:
  targetRef: { apiVersion: apps/v1, kind: Deployment, name: api }
  updatePolicy: { updateMode: "Off" }
EOF

# After 24-48h of real traffic
kubectl describe vpa api-vpa
# Apply the recommended requests, keep limits ~2x requests
```

### 6.2 Autoscaling policy (Phase 2)

Queue-depth scaling needs `prometheus-adapter` exposing `platform_queue_depth` as an
external metric; that is part of the Phase 2 monitoring install (`TDD_04` §5).

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: worker-hpa }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: worker }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
    - type: External
      external:
        metric:
          name: platform_queue_depth
          selector: { matchLabels: { state: waiting } }
        target: { type: AverageValue, averageValue: "100" }
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies: [{ type: Pods, value: 1, periodSeconds: 60 }]
    scaleUp:
      stabilizationWindowSeconds: 30
      policies: [{ type: Pods, value: 2, periodSeconds: 30 }]
```

### 6.3 Spot instances for workers (Phase 2)

Workers are idempotent and retryable, making them ideal for spot capacity.

```bash
gcloud container node-pools create workers-spot \
  --cluster platform-prod \
  --machine-type n2-standard-2 \
  --spot \
  --enable-autoscaling --min-nodes 0 --max-nodes 10 \
  --node-labels workload=worker \
  --node-taints spot=true:NoSchedule
```

```yaml
# Graceful shutdown so in-flight jobs complete
lifecycle:
  preStop:
    exec: { command: ["/bin/sh", "-c", "sleep 30"] }
terminationGracePeriodSeconds: 60
```

### 6.4 S3 storage tiering

```json
{
  "Rules": [
    {
      "ID": "media-tiering",
      "Status": "Enabled",
      "Filter": { "Prefix": "stores/" },
      "Transitions": [
        { "Days": 30,  "StorageClass": "STANDARD_IA" },
        { "Days": 90,  "StorageClass": "GLACIER_IR" }
      ]
    },
    {
      "ID": "exports-expire",
      "Status": "Enabled",
      "Filter": { "Prefix": "stores/", "Tag": { "Key": "purpose", "Value": "export" } },
      "Expiration": { "Days": 14 }
    },
    {
      "ID": "audit-archive",
      "Status": "Enabled",
      "Filter": { "Prefix": "audit/" },
      "Transitions": [{ "Days": 0, "StorageClass": "DEEP_ARCHIVE" }]
    }
  ]
}
```

Retention deletion is driven by the retention worker (`TDD_05` §10.4), never by an S3
expiration rule on media — the database must stay the source of truth.

### 6.5 Reserved capacity strategy

| Component | Strategy | Savings |
|-----------|----------|---------|
| API service | Committed use discount (1 year) | ~17-30% |
| Worker service | Spot (Phase 2 only) | 60-80% |
| Database | 1-year committed (never spot) | ~25% |
| Redis | 1-year committed | ~25% |

---

## 7. Backup & disaster recovery

### 7.1 Objectives

```
RTO (Recovery Time Objective):  < 4 hours
RPO (Recovery Point Objective): < 15 minutes
```

### 7.2 Database backups

```bash
gcloud sql instances patch platform-db \
  --backup-start-time=04:30 \
  --retained-backups-count=30 \
  --enable-point-in-time-recovery \
  --retained-transaction-log-days=7
```

Daily snapshots with 30-day retention, plus point-in-time recovery within the last 7 days.
The backup window (04:30 UTC) is deliberately away from the retention worker (03:00 store
local, `TDD_05` §10.4) and the analytics rollups.

```bash
# Restore from snapshot
gcloud sql backups restore BACKUP_ID --backup-instance=platform-db

# Point-in-time restore to a NEW instance (never in place)
gcloud sql instances clone platform-db platform-db-pitr \
  --point-in-time=2026-09-03T10:23:00Z
```

### 7.3 Object storage backups (S3)

```bash
# Versioning on the production bucket
aws s3api put-bucket-versioning --bucket platform-production \
  --versioning-configuration Status=Enabled

# Cross-region replication to platform-production-replica (us-west-2)
aws s3api put-bucket-replication --bucket platform-production \
  --replication-configuration file://s3-replication.json
```

### 7.4 Kubernetes backups (Phase 2 only)

```bash
helm install velero vmware-tanzu/velero \
  --namespace velero --create-namespace \
  --set configuration.provider=gcp \
  --set configuration.backupStorageLocation.bucket=platform-k8s-backups

velero schedule create daily-prod \
  --schedule="0 2 * * *" \
  --include-namespaces production \
  --ttl 720h
```

### 7.5 Recovery runbooks

**Scenario A — database corruption**
```bash
# 1. Stop writes
gcloud run services update api-service --region=us-central1 --max-instances=0
gcloud run services update worker-service --region=us-central1 --max-instances=0

# 2. Restore
gcloud sql backups restore BACKUP_ID --backup-instance=platform-db

# 3. Verify integrity (mapped table names, TDD_01 §4)
psql "$DIRECT_DATABASE_URL" -c "SELECT COUNT(*) FROM conversations;"
psql "$DIRECT_DATABASE_URL" -c "SELECT MAX(created_at) FROM messages;"

# 4. Restore service
gcloud run services update api-service --region=us-central1 --min-instances=1 --max-instances=20
gcloud run services update worker-service --region=us-central1 --min-instances=1 --max-instances=5

# RTO: 1-2 hours | RPO: < 15 min with PITR
```

**Scenario B — full region loss**
```bash
# 1. Provision replacement infrastructure
gcloud sql instances create platform-db-recovery --region=us-east1 --database-version=POSTGRES_18

# 2. Restore database from the most recent backup
gcloud sql backups restore BACKUP_ID --backup-instance=platform-db-recovery

# 3. Point S3 clients at the replica bucket (S3_BUCKET=platform-production-replica)

# 4. Deploy services to the new region
gcloud run deploy api-service --region=us-east1 --image=...
gcloud run deploy worker-service --region=us-east1 --image=...
gcloud run deploy web-service --region=us-east1 --image=...

# 5. Update Cloudflare origins to the new load balancer

# RTO: 2-4 hours | RPO: < 15 min
```

### 7.6 Backup testing schedule

```
Monthly    Restore a database backup into a scratch instance and verify row counts
Quarterly  Full disaster recovery drill against Scenario A
Annually   Cross-region failover drill against Scenario B
```

**An untested backup is not a backup.** Each drill must be logged with date,
operator, duration and outcome in `docs/runbooks/database-restore.md`.
