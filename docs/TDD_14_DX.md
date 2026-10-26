# TDD 14 — Developer Experience

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: local setup, tooling, linting, git workflow, Nx, documentation

---

## 1. One-command setup

`pnpm setup` is a **built-in pnpm command** (it configures pnpm's global directory), so the
project script is called `bootstrap`.

```bash
# scripts/bootstrap.sh
#!/usr/bin/env bash
set -euo pipefail

echo "→ Checking prerequisites"
command -v node   >/dev/null || { echo "Node.js 22+ required"; exit 1; }
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
corepack enable >/dev/null 2>&1 || true          # pnpm version comes from package.json "packageManager"

node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$node_major" -ge 22 ] || { echo "Node.js 22+ required, found $(node -v)"; exit 1; }

echo "→ Installing dependencies"
pnpm install --frozen-lockfile

echo "→ Creating local environment files"
[ -f .env.local ] || cp .env.example .env.local
[ -f apps/web/.env.local ] || cp apps/web/.env.example apps/web/.env.local

echo "→ Starting infrastructure (postgres, pgbouncer, redis, seaweedfs, mailpit, clamav)"
docker compose up -d --wait                      # SeaweedFS creates the bucket (TDD_03 §3.1)

echo "→ Generating Prisma client"
pnpm prisma generate

echo "→ Running migrations"
pnpm prisma migrate deploy

echo "→ Seeding database"
pnpm prisma db seed

cat <<'EOF'

Setup complete.

  pnpm dev                  Start api and web
  pnpm dev:all              Start api, web, worker and admin

  App             http://localhost:3000
  Admin console   http://localhost:3100
  API             http://localhost:8080
  API docs        http://localhost:8080/docs
  Queue admin     http://localhost:8080/admin/queues   (staff login)
  Mail catcher    http://localhost:8025
  S3 (SeaweedFS)  http://localhost:8333   (dev_access_key / dev_secret_key)

  Logins:  admin@test.com · agent@test.com · viewer@test.com · multi-store@test.com  /  password123

EOF
```

**Success criterion:** a new developer runs `pnpm bootstrap && pnpm dev` and has a
working environment with realistic data in under five minutes.

---

## 2. Scripts

```json
{
  "packageManager": "pnpm@11.25.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "bootstrap": "bash scripts/bootstrap.sh",

    "dev": "nx run-many --target=serve --projects=api,web --parallel",
    "dev:api": "nx serve api",
    "dev:web": "nx serve web",
    "dev:worker": "nx serve worker",
    "dev:admin": "nx serve admin",
    "dev:all": "nx run-many --target=serve --projects=api,web,worker,admin --parallel",

    "build": "nx run-many --target=build --all",
    "build:affected": "nx affected --target=build --base=origin/main",

    "test": "nx run-many --target=test --all",
    "test:watch": "nx run-many --target=test --all -- --watch",
    "test:cov": "nx run-many --target=test --all -- --coverage",
    "test:affected": "nx affected --target=test --base=origin/main",
    "test:integration": "jest --config tests/jest.integration.config.ts --runInBand",
    "test:security": "jest --config tests/jest.security.config.ts --runInBand",
    "test:contracts": "jest --config tests/jest.contracts.config.ts",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:load": "k6 run tests/load/inbox.load.js",

    "lint": "nx run-many --target=lint --all",
    "lint:fix": "nx run-many --target=lint --all -- --fix",
    "format": "prettier --write \"**/*.{ts,tsx,json,md,yml,yaml}\"",
    "format:check": "prettier --check \"**/*.{ts,tsx,json,md,yml,yaml}\"",
    "type-check": "nx run-many --target=type-check --all",

    "prisma:generate": "prisma generate",
    "prisma:migrate:dev": "prisma migrate dev",
    "prisma:migrate:deploy": "prisma migrate deploy",
    "prisma:studio": "prisma studio",
    "prisma:seed": "prisma db seed",
    "prisma:reset": "prisma migrate reset --force",

    "infra:up": "docker compose up -d --wait",
    "infra:down": "docker compose down",
    "infra:reset": "docker compose down -v && docker compose up -d --wait && pnpm prisma migrate deploy && pnpm prisma db seed",
    "infra:logs": "docker compose logs -f",

    "email:dev": "email dev --dir libs/core/email/templates --port 3001",
    "storybook": "storybook dev -p 6006",
    "build-storybook": "storybook build",

    "validate:translations": "tsx scripts/validate-translations.ts",
    "validate:deprecations": "tsx scripts/validate-deprecations.ts",
    "validate:rollbacks": "tsx scripts/check-rollbacks.ts",
    "validate:isolation": "tsx scripts/check-isolation-coverage.ts",
    "validate:all": "pnpm lint && pnpm type-check && pnpm validate:translations && pnpm validate:deprecations && pnpm validate:rollbacks && pnpm validate:isolation && pnpm test",
    "validate:ci": "pnpm validate:all && pnpm test:integration && pnpm test:contracts && pnpm test:security"
  }
}
```

`pnpm validate:all` is the pre-push check (no infrastructure needed). `pnpm validate:ci`
runs everything CI runs and needs `docker compose up`.

All Prisma commands read `prisma.config.ts` at the repo root (`TDD_01` §2.3) — no
`--schema` flag anywhere. The `type-check` target is defined in each `project.json` as
`tsc -p tsconfig.json --noEmit`.

---

## 3. Hot reload

```
api      NestJS watch mode with --inspect on port 9229
worker   NestJS watch mode with --inspect on port 9230
web      Next.js Fast Refresh, native
admin    Next.js Fast Refresh, native (port 3100)
prisma   pnpm prisma generate --watch regenerates the client on schema change
```

**VS Code debug configuration:**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Attach to API",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Attach to Worker",
      "type": "node",
      "request": "attach",
      "port": 9230,
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    },
    {
      "name": "Debug current Jest file",
      "type": "node",
      "request": "launch",
      "program": "${workspaceFolder}/node_modules/.bin/jest",
      "args": ["--runInBand", "${relativeFile}"],
      "console": "integratedTerminal"
    }
  ]
}
```

---

## 4. API documentation

Generated from the shared Zod schemas through `nestjs-zod` — DTOs are never written twice
(`TDD_02` §13). `SwaggerModule.setup` mounts at `InfraRoutesdocs` outside the API prefix.

```typescript
// apps/api/src/main.ts
if (env.NODE_ENV !== 'production') {
  patchNestJsSwagger(); // nestjs-zod: Zod schemas → OpenAPI

  const config = new DocumentBuilder()
    .setTitle('Platform API')
    .setDescription('Omnichannel Commerce Platform')
    .setVersion('1')
    .addBearerAuth()
    .addGlobalParameters({
      name: TenantHeaders.STORE_ID,
      in: 'header',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(InfraRoutesdocs, app, document, {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
  });
}
```

**Every endpoint must be documented:**

```typescript
@ApiTags('conversations')
@ApiBearerAuth()
@Controller()
export class ConversationsController {
  @Get(ApiRoutes.conversations.list)
  @ApiOperation({ summary: 'List conversations for the current store' })
  @ApiQuery({ name: 'status', required: false, enum: ConversationStatus })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: ConversationListPageDto }) // createZodDto(cursorPageSchema(conversationListItemSchema))
  @ApiForbiddenResponse({ description: ErrorCodes.TENANT_ACCESS_DENIED })
  async list(
    @Query(new ZodValidationPipe(listConversationsSchema))
    query: ListConversationsInput,
  ) {}
}
```

The OpenAPI spec is exported as a build artifact and published to the
developer documentation site for plugin authors. The staff API (`/admin/v1`) gets a separate
document, never published.

---

## 5. Storybook

```bash
pnpm storybook    # http://localhost:6006
```

```tsx
// apps/web/components/inbox/ConversationItem.stories.tsx
import type { Meta, StoryObj } from '@storybook/nextjs';
import { ConversationItem } from './ConversationItem';
import {
  ConversationStatus,
  ConversationHandler,
  ChannelType,
  AuthorType,
  MessageType,
} from '@platform/core-domain';
import { buildConversationListItem } from '../../../../tests/builders/conversation-list-item.builder';

const meta: Meta<typeof ConversationItem> = {
  component: ConversationItem,
  parameters: { layout: 'padded' },
  argTypes: {
    conversation: { control: 'object' },
  },
};
export default meta;

type Story = StoryObj<typeof ConversationItem>;

// The prop is the ConversationListItem view model defined in TDD_09 §2 — not the Prisma entity
export const Open: Story = {
  args: {
    conversation: buildConversationListItem({
      status: ConversationStatus.OPEN,
      handler: ConversationHandler.HUMAN,
      channelType: ChannelType.WHATSAPP,
      unreadCount: 3,
      customer: {
        id: 'cust_1',
        name: 'Juan Pérez',
        displayIdentity: '+503 7123-4567',
      },
      lastMessage: {
        id: 'msg_1',
        authorType: AuthorType.CUSTOMER,
        type: MessageType.TEXT,
        contentPreview: 'Hola, necesito ayuda con mi pedido',
        createdAt: new Date().toISOString(),
      },
    }),
  },
};

export const Assigned: Story = {
  /* ... */
};
export const Snoozed: Story = {
  /* ... */
};
export const AiHandling: Story = {
  /* handler: AI */
};
export const WithLongMessage: Story = {
  /* ... */
};
export const Loading: Story = {
  /* ... */
};
```

**Every shared component needs stories covering:** default, loading, empty,
error, and each meaningful state variant. `@storybook/addon-a11y` runs on every story.

---

## 6. Linting and formatting

ESLint 10 supports **flat config only**; there is no `.eslintrc.*` in the repository.

```javascript
// eslint.config.js
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nx from '@nx/eslint-plugin';
import importX from 'eslint-plugin-import-x';

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description', 'ts-ignore': true },
      ],

      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../../*'],
              message: 'Use a workspace alias instead of deep relative imports',
            },
            {
              group: ['@platform/core/config'],
              message:
                'Only libs/core may read env; apps/web and apps/admin use their own lib/env.ts',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message: 'Read configuration through the validated env object',
        },
        {
          selector:
            "CallExpression[callee.property.name='update'][callee.object.property.name='conversation'] > ObjectExpression > Property[key.name='data'] > ObjectExpression > Property[key.name='status']",
          message:
            'Change conversation status through ConversationsService.updateStatus',
        },
        // The statuses and the usual answers come from libs/core/domain/errors: a number in
        // PlatformException, @HttpCode or res.status, a constant HTTP_* of your own, or
        // ErrorCodes.RESOURCE_NOT_FOUND / RESOURCE_CONFLICT / AUTH_UNAUTHORIZED by hand are refused
        // (httpStatusBans in eslint.config.js). The specs are exempt: they say the number on purpose.
      ],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' },
        },
      ],

      '@nx/enforce-module-boundaries': [
        'error',
        {
          depConstraints: [
            {
              sourceTag: 'scope:api',
              onlyDependOnLibsWithTags: [
                'scope:core',
                'scope:core-domain',
                'scope:plugins',
                'scope:channels',
              ],
            },
            {
              sourceTag: 'scope:worker',
              onlyDependOnLibsWithTags: [
                'scope:core',
                'scope:core-domain',
                'scope:plugins',
                'scope:channels',
              ],
            },
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: [
                'scope:core-domain',
                'scope:api-client',
              ],
            },
            {
              sourceTag: 'scope:admin',
              onlyDependOnLibsWithTags: [
                'scope:core-domain',
                'scope:api-client',
              ],
            },
            {
              sourceTag: 'scope:widget',
              onlyDependOnLibsWithTags: ['scope:core-domain'],
            },
            {
              sourceTag: 'scope:api-client',
              onlyDependOnLibsWithTags: ['scope:core-domain'],
            },
            {
              sourceTag: 'scope:channels',
              onlyDependOnLibsWithTags: [
                'scope:plugins',
                'scope:core',
                'scope:core-domain',
              ],
            },
            {
              sourceTag: 'scope:plugins',
              onlyDependOnLibsWithTags: ['scope:core-domain'],
            },
            {
              sourceTag: 'scope:core',
              onlyDependOnLibsWithTags: ['scope:core', 'scope:core-domain'],
            },
            {
              sourceTag: 'scope:core-domain',
              onlyDependOnLibsWithTags: ['scope:core-domain'],
            },
          ],
        },
      ],
    },
  },

  // Scripts and the seed are allowed to print; everything else uses Pino
  {
    files: [
      'scripts/**/*.ts',
      'libs/core/database/prisma/seed.ts',
      'tests/load/**/*.js',
    ],
    rules: { 'no-console': 'off' },
  },

  // Frontend apps may read NEXT_PUBLIC_* in exactly one file
  {
    files: [
      'apps/web/lib/env.ts',
      'apps/admin/lib/env.ts',
      'apps/widget/src/env.ts',
      'libs/core/config/env.ts',
      'prisma.config.ts',
      'libs/core/database/prisma.config.ts',
    ],
    rules: { 'no-restricted-syntax': 'off' },
  },

  { ignores: ['**/dist/**', '**/generated/**', '**/.next/**', 'coverage/**'] },
]);
```

**`no-console` is an error, not a warning.** Use the Pino logger.

**Module boundaries are enforced by lint**, which is what keeps the modular
monolith from decaying into a tangle. The `scope:core-domain` tag marks the browser-safe
subset of `libs/core` (`TDD_01` §1).

**Deprecation scanner** (`scripts/validate-deprecations.ts`, runs in `lint-and-types`):
greps the codebase for removed or renamed APIs and fails on any hit. The list is the
compat notes of this TDD set; each entry names the replacement:

| Pattern                                          | Replacement                          |
| ------------------------------------------------ | ------------------------------------ |
| `prisma.$use(`                                   | `$extends` (Prisma 7)                |
| `prisma-client-js`                               | generator `prisma-client`            |
| `datasourceUrl:` / `datasources: {`              | driver adapter (`PrismaPg`)          |
| `z.nativeEnum(`                                  | `z.enum(Enum)`                       |
| `z.string().url()` / `.email()` / `.uuid()`      | `z.url()` / `z.email()` / `z.uuid()` |
| `z.coerce.boolean(`                              | `z.stringbool()`                     |
| `createUsageRecord(`                             | `billing.meterEvents.create`         |
| `utcToZonedTime(`                                | `toZonedTime` (date-fns-tz v3)       |
| `from 'redis'`                                   | `ioredis`                            |
| `prom-client`                                    | `@prometheus-io/client`              |
| `middleware.ts` (file in apps/web)               | `proxy.ts`                           |
| `useQuery(key, fn)`                              | object form                          |
| `ReactDOM.render(`                               | `createRoot`                         |
| `ConversationStatusLabels`                       | `ConversationStatusI18nKeys`         |
| `request.query.storeId` / `request.body.storeId` | `request.store` from `TenantGuard`   |

```json
// .prettierrc
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "none",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "avoid",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

---

## 7. Pre-commit hooks

```bash
pnpm add -D husky lint-staged @commitlint/cli @commitlint/config-conventional
pnpm exec husky init
brew install gitleaks          # Go binary, TDD_01 §2.4 — CI downloads the same pinned release
```

```json
// package.json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix --max-warnings=0", "prettier --write"],
    "*.{json,md,yml,yaml}": ["prettier --write"],
    "libs/core/database/prisma/schema.prisma": "prisma format",
    "apps/web/messages/*.json": "pnpm validate:translations",
    "libs/core/database/prisma/migrations/**/migration.sql": "pnpm validate:rollbacks"
  }
}
```

(`prisma format` reads the schema path from `prisma.config.ts`, so lint-staged's file
argument is irrelevant to it and is ignored; the entry exists to trigger it.)

```bash
# .husky/pre-commit
pnpm lint-staged
gitleaks git --pre-commit --staged --no-banner --redact   # Block committed secrets
```

```bash
# .husky/commit-msg
pnpm exec commitlint --edit "$1"
```

```javascript
// commitlint.config.js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'test',
        'chore',
        'perf',
        'ci',
        'revert',
        'build',
      ],
    ],
    'scope-enum': [
      1,
      'always',
      [
        'api',
        'web',
        'admin',
        'widget',
        'worker',
        'db',
        'infra',
        'ci',
        'auth',
        'tenancy',
        'conversations',
        'messages',
        'customers',
        'orders',
        'products',
        'media',
        'search',
        'notifications',
        'realtime',
        'analytics',
        'billing',
        'plugins',
        'channels',
        'whatsapp',
        'instagram',
        'messenger',
        'web-widget',
        'email',
        'ai',
        'i18n',
        'compliance',
        'referrals',
        'settings',
        'webhooks',
        'queues',
        'storage',
        'support',
        'deps',
        'docs',
      ],
    ],
    'subject-max-length': [2, 'always', 72],
    'body-max-line-length': [1, 'always', 100],
  },
};
```

**Valid commits:**

```
feat(conversations): add snooze until custom date
fix(orders): correct total when discount exceeds subtotal
perf(search): cache product autocomplete for 60s
chore(db): add partial index on active conversations
test(tenancy): cover cross-store media access
```

---

## 8. Git workflow

**Trunk-based development.**

```
main                    Always deployable
 ├── feat/snooze        Short-lived, under 2 days
 ├── fix/order-total    Short-lived, under 1 day
 └── chore/upgrade-nx

Merge to main via PR only
main → staging          Automatic on merge
main → production       Tag v1.2.3 with manual approval
```

**Branch protection on `main`** (status check names are the CI job names in `TDD_03` §4):

```
Require pull request:          1 approval
Require status checks:
  - lint-and-types
  - unit-tests
  - integration-tests
  - security-tests            ← cannot be bypassed
  - e2e-tests
  - security-scan
Require branches up to date:   yes
Require conversation resolution: yes
Allow force push:              no
Allow deletion:                no
```

**Incomplete work ships behind a feature flag**, never on a long-lived branch. Two flag
systems exist on purpose: `FEATURE_*` env variables (`TDD_02` §9) are deploy-time kill
switches for whole subsystems; the `FeatureFlag` table (`TDD_15` §8) is runtime rollout by
percentage/org. Code checks flags through `FeatureFlagService.isEnabled(key, organizationId)`,
which consults both.

```markdown
<!-- .github/pull_request_template.md -->

## Summary

<!-- What changes and why -->

## TDD reference

<!-- Which TDD section does this implement? e.g. TDD_07 §5.3 -->

## Checklist

- [ ] No magic strings — all constants from libs/core
- [ ] All queries scoped by storeId; storeId only from TenantGuard context
- [ ] New endpoints have AuthGuard, TenantGuard, AccessLevelGuard and permission decorators
- [ ] New request bodies have Zod schemas (no storeId/organizationId fields)
- [ ] New user-facing strings are i18n keys
- [ ] New env vars added to the Zod schema AND .env.example
- [ ] Tests added or updated
- [ ] Tenant isolation test added for any new resource
- [ ] Migration includes a rollback script
- [ ] No new secrets in code

## Migration notes

<!-- Deployment steps, breaking changes, or "none" -->

## Screenshots

<!-- For UI changes -->
```

---

## 9. Nx configuration

```json
// nx.json
{
  "namedInputs": {
    "default": ["{projectRoot}/**/*", "sharedGlobals"],
    "production": [
      "default",
      "!{projectRoot}/**/*.spec.ts",
      "!{projectRoot}/**/*.stories.tsx",
      "!{projectRoot}/tsconfig.spec.json"
    ],
    "sharedGlobals": [
      "{workspaceRoot}/package.json",
      "{workspaceRoot}/tsconfig.base.json",
      "{workspaceRoot}/eslint.config.js"
    ]
  },
  "targetDefaults": {
    "build": {
      "cache": true,
      "dependsOn": ["^build"],
      "inputs": ["production", "^production"]
    },
    "test": { "cache": true, "inputs": ["default", "^production"] },
    "lint": { "cache": true },
    "type-check": { "cache": true, "inputs": ["default", "^production"] }
  }
}
```

The Nx Cloud token is **not** in `nx.json`; CI provides `NX_CLOUD_ACCESS_TOKEN` as a secret
and local developers use a read-only token from `nx.json`'s gitignored sibling
`nx-cloud.env`.

**Project tags drive boundary enforcement:**

```json
// apps/api/project.json
{ "tags": ["scope:api", "type:app"] }

// apps/admin/project.json
{ "tags": ["scope:admin", "type:app"] }

// apps/widget/project.json
{ "tags": ["scope:widget", "type:app"] }

// libs/core/database/project.json
{ "tags": ["scope:core", "type:lib"] }

// libs/core/domain/project.json  (and events names, api routes, auth constants, i18n, notifications constants)
{ "tags": ["scope:core-domain", "type:lib"] }

// libs/api-client/project.json
{ "tags": ["scope:api-client", "type:lib"] }

// libs/channels/whatsapp/project.json
{ "tags": ["scope:channels", "type:lib"] }
```

**Effect of Nx Affected in CI:** a change touching only `apps/web` skips the
API build, API tests and worker tests entirely. Typical CI time drops from
around 8 minutes to around 2.

**Dependency graph:**

```bash
pnpm nx graph                    # Interactive visualization
pnpm nx affected:graph           # What a change impacts
```

---

## 10. Environment files

`.env.example` lists **every** key in the `TDD_02` §9.1 schema, in the same order, with a
placeholder or the local default. `scripts/validate-env-example.ts` (part of
`validate:deprecations`) diffs the two and fails on drift.

```bash
# .env.example  — committed, placeholders only (api + worker)
NODE_ENV=development
APP_ROLE=api
PORT=8080
API_URL=http://localhost:8080
FRONTEND_URL=http://localhost:3000
ADMIN_URL=http://localhost:3100
COMMIT_SHA=

# Database (pgbouncer for the app, direct for migrations — TDD_01 §2.3)
DATABASE_URL=postgresql://platform:dev_password@localhost:6432/platform_dev
DIRECT_DATABASE_URL=postgresql://platform:dev_password@localhost:5432/platform_dev
DATABASE_REPLICA_URL=

# Redis
REDIS_URL=redis://localhost:6379
REDIS_QUEUE_URL=

# Auth
JWT_SECRET=change-me-to-at-least-32-characters-long-value
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Encryption at rest (32 bytes hex) — generate with: openssl rand -hex 32
CREDENTIALS_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000

# Storage (SeaweedFS locally)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=dev_access_key
AWS_SECRET_ACCESS_KEY=dev_secret_key
S3_BUCKET=platform-dev
S3_ENDPOINT=http://localhost:8333
S3_FORCE_PATH_STYLE=true

# Email (Mailpit locally; Resend in deployed environments)
EMAIL_PROVIDER=resend
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=
EMAIL_FROM=noreply@platform.local
EMAIL_INBOUND_DOMAIN=inbound.platform.local

# Observability
SENTRY_DSN=
LOG_LEVEL=debug

# Push (generate with: pnpm exec web-push generate-vapid-keys)
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=

# Billing
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PUBLISHABLE_KEY=
STRIPE_PRICE_IDS_JSON=

# AI
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Meta (one app for WhatsApp, Instagram, Messenger)
META_APP_ID=
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
META_GRAPH_API_VERSION=v23.0

# Virus scanning
CLAMAV_HOST=localhost
CLAMAV_PORT=3310

# Staff SSO (TDD_15 §1)
STAFF_OIDC_ISSUER=
STAFF_OIDC_CLIENT_ID=
STAFF_OIDC_CLIENT_SECRET=
STAFF_ALLOWED_EMAIL_DOMAIN=platform.com

# Deploy-time kill switches — everything experimental off by default
FEATURE_BILLING_ENABLED=false
FEATURE_REFERRALS_ENABLED=false
FEATURE_AI_ENABLED=false
```

```bash
# apps/web/.env.example (TDD_02 §9.2)
NEXT_PUBLIC_API_URL=http://localhost:8080
NEXT_PUBLIC_WS_URL=http://localhost:8080
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
NEXT_PUBLIC_SENTRY_DSN=
NEXT_PUBLIC_WIDGET_SCRIPT_URL=http://localhost:4200/v1/widget.js
```

```gitignore
.env
.env.local
.env.*.local
nx-cloud.env
secrets/
!.env.example
```

Local email in development goes to Mailpit: the `ResendProvider` is swapped for an SMTP
provider (`MailpitProvider`, dev-only binding in `EmailModule`) when `NODE_ENV=development`
and `RESEND_API_KEY` is empty — that is the only place a second provider class exists.

---

## 11. Documentation in the repository

```
docs/
├─ adr/                        Architecture Decision Records
│  ├─ 0001-modular-monolith.md
│  ├─ 0002-shared-database-tenancy.md
│  ├─ 0003-plugins-for-channels.md
│  ├─ 0004-postgres-fts-before-elasticsearch.md
│  ├─ 0005-billing-by-conversation.md
│  ├─ 0006-store-context-via-header.md
│  ├─ 0007-plan-limits-const-plus-overrides.md
│  └─ 0008-autonomous-chatbot-exception.md
├─ runbooks/                   Linked from alert annotations (TDD_04 §6)
│  ├─ high-error-rate.md
│  ├─ tenant-violation.md
│  ├─ database-restore.md
│  ├─ channel-outage.md
│  ├─ queue-backlog.md
│  ├─ ai-kill-switch.md
│  └─ data-breach.md
└─ guides/
   ├─ adding-a-channel-plugin.md
   ├─ adding-a-tenant-scoped-resource.md
   ├─ writing-a-migration.md
   └─ debugging-realtime.md
```

**ADR template:**

```markdown
# ADR NNNN: Title

**Status:** Accepted | Superseded by ADR-XXXX
**Date:** YYYY-MM-DD

## Context

What forced a decision.

## Decision

What we chose.

## Consequences

What becomes easier. What becomes harder. What we accept.

## Alternatives considered

What we rejected and why.
```

**Rule:** any decision that would surprise a new engineer gets an ADR.

---

## 12. Onboarding a new developer

```
Day 1
  1. pnpm bootstrap
  2. pnpm dev, verify login works
  3. Read TDD_00_Overview.md and TDD_02_Conventions.md
  4. Read docs/adr/ in order
  5. Ship a trivial fix end to end to exercise the whole pipeline

Day 2-3
  6. Read TDD_01_Architecture.md
  7. Walk the inbound message pipeline in a debugger,
     from webhook → queue → worker → realtime broadcast
  8. Read TDD_13_Testing.md, write one integration test

Week 1
  9. Pick a task from the current milestone in IMPLEMENTATION_PLAN.md
```

**Definition of successful onboarding:** a merged PR on day one.

---

## 13. Common commands

```bash
# Reset everything when local state is broken
pnpm infra:reset

# Inspect the database
pnpm prisma:studio

# Preview an email template
pnpm email:dev

# Inspect queues and the dead letter queue
open http://localhost:8080/admin/queues

# Check which projects a change affects
pnpm nx affected:graph

# Run one test file
pnpm nx test api --testFile=orders.service.spec.ts

# Regenerate the Prisma client after a schema edit
pnpm prisma:generate

# Verify everything CI verifies (needs docker compose up)
pnpm validate:ci
```
