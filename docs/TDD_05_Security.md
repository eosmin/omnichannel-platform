# TDD 05 — Security & Compliance

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: secrets, network, rate limiting, DDoS, TLS, scanning, pentest, audit, GDPR

---

## 1. Secrets management

### 1.1 Phase 1 — Google Secret Manager

Each Cloud Run service mounts **one** secret as an env file (`/etc/platform/env`,
`TDD_03` §1). The file is the complete set of variables the Zod schema (`TDD_02` §9)
requires for that `APP_ROLE`; the container entrypoint sources it before starting Node.

```bash
# Create / update the env file for the API (never commit the local copy)
gcloud secrets create api-env --data-file=./secrets/api.env
gcloud secrets versions add api-env --data-file=./secrets/api.env

# Individual secrets used by Cloud Run Jobs
gcloud secrets create direct-database-url --data-file=- <<< "postgresql://..."

# Generate strong values
openssl rand -base64 48                    # JWT_SECRET
openssl rand -hex 32                       # CREDENTIALS_ENCRYPTION_KEY (32 bytes hex, AES-256-GCM)

# Grant access to each service account only
gcloud secrets add-iam-policy-binding api-env \
  --member="serviceAccount:api-service@PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

`api-env`, `worker-env`, `web-env` and `admin-env` are separate secrets with separate IAM
bindings: the web service never receives `DATABASE_URL` or `STRIPE_SECRET_KEY`.

**Rotation:**
```bash
gcloud secrets versions add api-env --data-file=./secrets/api.env
gcloud run services update api-service --region=us-central1   # Picks up :latest
```

Rotate quarterly, and immediately after any suspected exposure. `JWT_SECRET` rotation
invalidates every access token (15-minute TTL) — refresh tokens keep working because they
are opaque values, not JWTs. `CREDENTIALS_ENCRYPTION_KEY` rotation requires the
`scripts/rotate-credentials-key.ts` re-encryption job (reads with the old key, writes with
the new one, both keys present during the run).

### 1.2 Phase 2 — HashiCorp Vault

Migrate when: more than ~50 secrets, dynamic database credentials needed,
or audit-of-secret-access becomes a compliance requirement.

```bash
helm install vault hashicorp/vault \
  --namespace vault --create-namespace \
  --set server.ha.enabled=true \
  --set server.ha.replicas=3
```

**Dynamic database credentials — the main reason to adopt Vault:**
```hcl
vault write database/roles/api-role \
  db_name=platform \
  creation_statements="CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' IN ROLE platform_app;" \
  default_ttl="1h" \
  max_ttl="24h"
```

Credentials rotate hourly. A leaked credential expires on its own. The generated role
inherits `platform_app` (RLS-subject) or `platform_worker` (`BYPASSRLS`), never a
superuser (`TDD_01` §3.2).

```yaml
# Injected via Vault Agent sidecar
annotations:
  vault.hashicorp.com/agent-inject: "true"
  vault.hashicorp.com/role: "api-role"
  vault.hashicorp.com/agent-inject-secret-db: "database/creds/api-role"
```

### 1.3 Rules

- No secret is ever committed to git. `.env*` is gitignored except `.env.example`
- `.env.example` lists **every** variable in the `TDD_02` §9 schema with a placeholder
- Local development uses dummy secrets, never production values
- Staging and production never share secrets
- Channel credentials (`ChannelConnection.credentials`), tenant webhook secrets and API key
  material are encrypted at rest with AES-256-GCM (`libs/core/crypto`, key from
  `CREDENTIALS_ENCRYPTION_KEY`) before being written to Postgres. API keys, refresh tokens,
  verification tokens and invitation tokens are stored **hashed** (SHA-256), never encrypted
  — they only need to be compared, never read back.

---

## 2. Network policies (Phase 2 — Kubernetes)

Default deny, then explicitly allow. Cloud SQL and Memorystore live **outside** the cluster
(`TDD_03` §2): the API reaches them through the Cloud SQL Auth Proxy sidecar (localhost)
and the Memorystore private IP range, so egress rules target IP blocks, not pod selectors.

```yaml
# Default: deny everything
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-all, namespace: production }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# API egress: managed data services, DNS, external HTTPS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-egress, namespace: production }
spec:
  podSelector: { matchLabels: { app: api } }
  policyTypes: [Egress]
  egress:
    - to: [{ ipBlock: { cidr: 10.20.0.0/24 } }]            # Memorystore reserved range
      ports: [{ protocol: TCP, port: 6379 }]
    - to: [{ ipBlock: { cidr: 10.30.0.0/24 } }]            # Cloud SQL private IP range (via proxy sidecar)
      ports: [{ protocol: TCP, port: 3307 }]
    - to: [{ podSelector: { matchLabels: { app: clamav } } }]
      ports: [{ protocol: TCP, port: 3310 }]
    - to: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: kube-system } } }]
      ports: [{ protocol: UDP, port: 53 }]
    - to: [{ ipBlock: { cidr: 0.0.0.0/0, except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16] } }]
      ports: [{ protocol: TCP, port: 443 }]   # External APIs: Meta, Stripe, S3, AI providers
---
# Only the ingress controller may reach the API
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: ingress-to-api, namespace: production }
spec:
  podSelector: { matchLabels: { app: api } }
  policyTypes: [Ingress]
  ingress:
    - from: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: ingress-nginx } } }]
      ports: [{ protocol: TCP, port: 8080 }]
    - from: [{ namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: monitoring } } }]
      ports: [{ protocol: TCP, port: 8080 }]   # /metrics scrape
```

Verify with a throwaway pod:
```bash
kubectl run netpol-test --image=busybox -it --rm -- sh
nc -zv 10.30.0.5 3307      # Should fail from an unauthorized pod
```

**Phase 1 equivalent on Cloud Run:** `worker-service` and `clamav` use `--ingress=internal`;
`admin-service` sits behind Identity-Aware Proxy restricted to the staff Google Workspace
group (`TDD_15` §1); `/metrics` is only reachable from the managed Prometheus collector.

---

## 3. Rate limiting — three layers

### 3.1 Application layer (NestJS Throttler, Redis-backed)

In-memory throttling would give each Cloud Run instance its own counter. Storage is Redis
so limits hold across instances.

```typescript
// apps/api/src/app.module.ts
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      useFactory: (redis: Redis) => ({
        throttlers: [{ name: ThrottlerNames.DEFAULT, ttl: 60_000, limit: 100 }],
        storage: new ThrottlerStorageRedisService(redis),
      }),
      inject: [REDIS_CLIENT],
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: PlanAwareThrottlerGuard }],
})
export class AppModule {}

// libs/core/auth/throttler-names.ts
export const ThrottlerNames = { DEFAULT: 'default', AUTH: 'auth', PUBLIC: 'public' } as const
```

**Stricter limits on sensitive endpoints:**
```typescript
@Controller()
export class AuthController {
  @Post(ApiRoutes.auth.login)
  @Throttle({ [ThrottlerNames.DEFAULT]: { limit: 5, ttl: 60_000 } })
  async login(@Body(new ZodValidationPipe(loginSchema)) input: LoginInput) { }

  @Post(ApiRoutes.auth.signup)
  @Throttle({ [ThrottlerNames.DEFAULT]: { limit: 3, ttl: 3_600_000 } })
  async signup(@Body(new ZodValidationPipe(signupSchema)) input: SignupInput) { }

  @Post(ApiRoutes.auth.forgotPassword)
  @Throttle({ [ThrottlerNames.DEFAULT]: { limit: 3, ttl: 3_600_000 } })
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) input: ForgotPasswordInput) { }

  @Post(ApiRoutes.auth.resendVerification)
  @Throttle({ [ThrottlerNames.DEFAULT]: { limit: 3, ttl: 3_600_000 } })
  async resendVerification(@Body(new ZodValidationPipe(resendVerificationSchema)) input: ResendVerificationInput) { }
}
```

Public unauthenticated endpoints (`ApiRoutes.referrals.trackClick`, `ApiRoutes.compliance.dsrVerify`,
`ApiRoutes.widget.*`, `ApiRoutes.invitations.byToken`) get `@Throttle` by IP with the
`PUBLIC` profile (30/min).

**Plan-aware limits for authenticated traffic.** The tracker is the store (so one busy
agent cannot starve a colleague) and the limit comes from the effective plan:

```typescript
@Injectable()
export class PlanAwareThrottlerGuard extends ThrottlerGuard {
  constructor(
    options: ThrottlerModuleOptions,
    storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly planLimits: EffectivePlanLimitsService,
  ) { super(options, storage, reflector) }

  protected override async getTracker(req: AuthenticatedRequest): Promise<string> {
    if (req.store) return `store:${req.store.id}`
    if (req.pluginInstallation) return `plugin:${req.pluginInstallation.id}`
    return `ip:${req.ip}`
  }

  // Called by ThrottlerGuard v6 for each throttler definition; returning a resolved
  // limit overrides the static one.
  protected override async handleRequest(details: ThrottlerRequest): Promise<boolean> {
    const req = details.context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (req.organization) {
      const limits = await this.planLimits.resolve(req.organization.id)
      return super.handleRequest({ ...details, limit: limits.apiRateLimitPerMinute })
    }
    return super.handleRequest(details)
  }
}
```

Response headers `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `Retry-After` are set by
the guard. Exceeding the limit yields `RATE_LIMIT_EXCEEDED` through `GlobalExceptionFilter`.

### 3.2 Ingress layer (Nginx, Phase 2)

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-connections: "20"
    nginx.ingress.kubernetes.io/limit-burst-multiplier: "3"
```

Separate, stricter ingress rule for `/api/v1/auth/*` paths (5 rps).

### 3.3 Edge layer (Cloudflare)

```
Security → Rate Limiting Rules

Rule: Login brute force
  Expression: http.request.uri.path eq "/api/v1/auth/login"
  Requests:   5 per 1 minute per IP
  Action:     Block for 10 minutes

Rule: API flood
  Expression: starts_with(http.request.uri.path, "/api/")
  Requests:   1000 per 1 minute per IP
  Action:     Managed Challenge

Rule: Widget flood
  Expression: starts_with(http.request.uri.path, "/api/v1/widget/")
  Requests:   120 per 1 minute per IP
  Action:     Block for 5 minutes
```

---

## 4. DDoS protection

**Primary: Cloudflare** (proxy all public hostnames: `app.`, `api.`, `widget.`)

```
Security → WAF
  ✓ OWASP Core Ruleset
  ✓ Cloudflare Managed Ruleset

Security → DDoS
  ✓ HTTP DDoS Attack Protection

Security → Bots
  ✓ Block likely automated traffic
  ✓ Allow verified bots (search engines)

SSL/TLS
  Mode: Full (strict)
  Minimum TLS version: 1.2
  ✓ Always Use HTTPS
  ✓ Automatic HTTPS Rewrites
```

**Important:** exclude from bot challenges — they are legitimate automated traffic:
- `/api/v1/webhooks/channels/*` (Meta)
- `/api/v1/webhooks/stripe`, `/api/v1/webhooks/resend`
- `/api/v1/widget/*` (visitor browsers on third-party sites; rate-limited instead)

`admin.platform.com` is **not** proxied publicly: Identity-Aware Proxy + Workspace group
(`TDD_15` §1).

**Alternative: Google Cloud Armor** if not using Cloudflare.
```bash
gcloud compute security-policies rules create 1000 \
  --security-policy platform-security \
  --expression "true" \
  --action rate-based-ban \
  --rate-limit-threshold-count 100 \
  --rate-limit-threshold-interval-sec 60 \
  --ban-duration-sec 600 \
  --conform-action allow --exceed-action deny-403

gcloud compute security-policies rules create 3000 \
  --security-policy platform-security \
  --expression "evaluatePreconfiguredExpr('sqli-stable')" \
  --action deny-403
```

---

## 5. TLS certificates

**Phase 1 — Cloud Run:** automatic. Google-managed certificates on the load balancer,
Cloudflare Full (strict) in front. Map custom domains with
`gcloud run domain-mappings create` or the HTTPS load balancer.

**Phase 2 — Kubernetes with cert-manager:**
```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-prod }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@platform.com
    privateKeySecretRef: { name: letsencrypt-prod }
    solvers:
      - http01: { ingress: { class: nginx } }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: api-ingress
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
spec:
  tls:
    - hosts: [api.platform.com]
      secretName: api-tls-cert
```

cert-manager renews automatically 30 days before expiry.
Monitor with `kubectl get certificates -A`.

---

## 6. Security headers

Two surfaces, two configurations.

**API (`apps/api`) — Helmet with a minimal, API-appropriate policy:**
```typescript
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-site' },
}))
app.enableCors({
  origin: [env.FRONTEND_URL, env.ADMIN_URL].filter(Boolean),
  credentials: true,
  allowedHeaders: ['Authorization', 'Content-Type', TenantHeaders.STORE_ID, CORRELATION_ID_HEADER],
})
```

Widget routes (`ApiRoutes.widget.*`) are served with `Access-Control-Allow-Origin` set to
the store's registered site origins (`ChannelConnection.metadata.allowedOrigins`,
`TDD_10` §5.4), never `*`.

**Web app (`apps/web`) — the CSP carries a nonce, so `proxy.ts` sets it on every request; the headers that never change are in `next.config.ts`. This is where CSP matters:**
```typescript
// apps/web/lib/security-headers.ts (excerpt; buildContentSecurityPolicy, called by proxy.ts)
const directives = [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,   // Next puts the nonce of the request on its own scripts
  "style-src 'self' 'unsafe-inline'",                    // Tailwind 4 needs no inline styles; the Radix portals inject a few. Revisit with a nonce.
  `img-src 'self' data: blob: ${CUSTOMER_AVATAR_IMAGE_HOSTS.join(' ')}`,   // https://*.fbcdn.net https://*.cdninstagram.com https://platform-lookaside.fbsbx.com: the avatars Meta hands over (untrusted, initials when they fail). The bucket host joins img-src, and media-src is added, with the attachments of Step 3.4
  `connect-src 'self' <api origin> <websocket origin> [<Sentry dsn origin>]`,
  "font-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",                                    // The origins of the plugin widget iframes (TDD_10 §7) join it per store, in the step that builds them; Stripe is Phase 2
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self'",                                   // Service worker
  "manifest-src 'self'"
]

// apps/web/next.config.ts: STATIC_SECURITY_HEADERS, on every path
//   Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
//   Referrer-Policy: strict-origin-when-cross-origin
//   X-Content-Type-Options: nosniff
//   Permissions-Policy: camera=(self), microphone=(), geolocation=()
```

`upgrade-insecure-requests` is left out on purpose: the end to end suite drives the production build over `http://localhost`, and HSTS already makes a browser use https on the deployed host. A page under a nonce is rendered per request, never statically (Next requires it); the app reads the locale cookie on every page anyway.

Verify with https://securityheaders.com — target grade A on `app.platform.com`.

---

## 7. Security scanning in CI

The gates below are the ones implemented in `.github/workflows/ci.yml` (`TDD_03` §4);
this table and that file must agree.

| Tool | Scans | When | Gate |
|------|-------|------|------|
| **gitleaks** | Committed secrets | Pre-commit hook + CI `security-scan` job | Fail on any finding |
| **Trivy** | Container image vulnerabilities | CI `security-scan` job | `exit-code: 1` on CRITICAL/HIGH (fixed ones) |
| **Snyk** | npm dependency vulnerabilities | CI `security-scan` job | Fail on HIGH+ |
| **Dependabot** | Automated dependency PRs | Weekly | PR review |
| **OWASP ZAP** | Running application (staging) | Weekly scheduled workflow | Report to #security |
| **Deprecation scanner** | Removed/renamed APIs (`pnpm validate:deprecations`) | CI `lint-and-types` job | Fail on any hit |

All GitHub Actions are pinned to commit SHAs (`TDD_03` §4).

```yaml
# .github/workflows/zap-weekly.yml
name: ZAP baseline
on:
  schedule: [{ cron: '0 6 * * 1' }]
jobs:
  zap:
    runs-on: ubuntu-latest
    steps:
      - uses: zaproxy/action-baseline@<sha> # v0.14.0
        with: { target: 'https://staging.platform.com' }
```

---

## 8. Penetration testing

### 8.1 Internal checklist (run quarterly)

```markdown
## Authentication & authorization
- [ ] SQL injection in login form
- [ ] Brute force protection on login, signup, password reset, resend verification
- [ ] Session fixation
- [ ] JWT algorithm confusion / signature stripping
- [ ] Refresh token reuse revokes the whole family
- [ ] Privilege escalation: agent → admin
- [ ] Horizontal escalation: store A → store B      ← highest priority
- [ ] X-Store-Id spoofing without a membership
- [ ] Password reset token reuse and prediction
- [ ] Invitation token reuse; accepting with a different email
- [ ] OAuth redirect URI manipulation
- [ ] Impersonation token used after expiry / after the customer ended the session
- [ ] Write while impersonating in read-only mode

## API
- [ ] IDOR on every :id parameter
- [ ] Mass assignment (can the client set storeId, role, price, totals?)
- [ ] Rate limit bypass via header spoofing (X-Forwarded-For)
- [ ] CORS misconfiguration
- [ ] API versioning bypass
- [ ] Tenant API key scoped to the wrong store or exceeding its scopes

## Input validation
- [ ] XSS: stored, reflected, DOM-based (search snippets, customer names, message content)
- [ ] SQL injection on every endpoint accepting free text (search, filters)
- [ ] Command injection in file names
- [ ] Path traversal in media keys; confirmUpload with a foreign store prefix
- [ ] SSRF via webhook URL configuration (DNS rebinding, IPv6, decimal IPs)
- [ ] Malicious file upload (polyglot files, oversized, wrong content-type)
- [ ] Prompt injection through customer messages, store names, tag descriptions (TDD_12 §11)

## Business logic
- [ ] Price manipulation after order creation
- [ ] Order status transition bypass
- [ ] Inventory manipulation to negative
- [ ] Race condition: two agents resolving simultaneously
- [ ] Billing bypass: exceeding quota via concurrent requests
- [ ] Chispa balance going negative under concurrent AI calls
- [ ] Referral self-referral and fraud; $0 trial invoice qualifying a referral

## Multi-tenancy (critical)
- [ ] Access another store's conversation by ID
- [ ] Access another store's customer, order, product, media, tag, snippet, webhook, API key
- [ ] Store switching without membership
- [ ] Cross-tenant data leakage in search results
- [ ] Cross-tenant leakage in analytics aggregates
- [ ] Plugin API key scoped to the wrong store
- [ ] Widget site key from store A accepted on store B's connection

## Infrastructure
- [ ] Exposed .env or config files
- [ ] Directory listing enabled
- [ ] Database port publicly reachable
- [ ] Redis without authentication
- [ ] S3 bucket public read
- [ ] Verbose error messages leaking stack traces
- [ ] /metrics, /docs, /admin/queues publicly accessible
- [ ] admin.platform.com reachable without IAP

## Plugins
- [ ] Plugin API key leakage to the iframe
- [ ] Webhook HMAC signature bypass
- [ ] Plugin scope escalation
- [ ] postMessage source validation (MessageChannel port ownership)
```

### 8.2 External testing

```
Frequency: annually, and before any major architectural change
Budget:    $5,000 - $15,000
Duration:  1-2 weeks

Scope in:
  - app.platform.com, api.platform.com, widget.platform.com
  - Authenticated flows with provided test accounts (one per role)
  - Multi-tenant isolation (explicitly emphasized)
  - Staff console with a test staff account (impersonation flows)

Scope out:
  - Social engineering
  - Physical security
  - DoS attacks
  - Third-party services (Stripe, Meta, AWS, AI providers)

Remediation SLA:
  Critical  → 7 days
  High      → 30 days
  Medium    → 90 days
  Low       → next planning cycle
```

### 8.3 Bug bounty (MATURE)

```
Platform: HackerOne or Bugcrowd

Rewards:
  Critical (RCE, auth bypass, cross-tenant data access)  $500 - $2,000
  High     (XSS, IDOR, privilege escalation)             $200 - $500
  Medium   (CSRF, information disclosure)                $50 - $200
  Low                                                     $25 - $50

Out of scope:
  - Missing security headers with no demonstrated impact
  - Self-XSS
  - Rate limiting on non-sensitive endpoints
  - Social engineering
```

---

## 9. Audit logging

### 9.1 Actions to audit

```typescript
// libs/core/audit/audit-actions.ts
export const AuditAction = {
  // Auth
  USER_LOGIN: 'user.login',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGOUT: 'user.logout',
  PASSWORD_CHANGED: 'user.password_changed',
  PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  SESSION_FAMILY_REVOKED: 'user.session_family_revoked',

  // Tenancy
  ORGANIZATION_CREATED: 'organization.created',
  STORE_CREATED: 'store.created',
  STORE_UPDATED: 'store.updated',
  STORE_DELETED: 'store.deleted',
  MEMBER_INVITED: 'member.invited',
  INVITATION_REVOKED: 'member.invitation_revoked',
  MEMBER_JOINED: 'member.joined',
  MEMBER_REMOVED: 'member.removed',
  ROLE_CHANGED: 'member.role_changed',
  ROLE_UPDATED: 'role.updated',
  PERMISSION_DENIED: 'permission.denied',
  TENANT_ACCESS_DENIED: 'tenant.access_denied',

  // Data access (sensitive reads)
  CUSTOMER_VIEWED: 'customer.viewed',
  CUSTOMER_EXPORTED: 'customer.exported',
  CONVERSATION_EXPORTED: 'conversation.exported',
  ORDER_EXPORTED: 'order.exported',
  ANALYTICS_EXPORTED: 'analytics.exported',
  MEDIA_BULK_DOWNLOADED: 'media.bulk_downloaded',
  AUDIT_LOG_VIEWED: 'audit_log.viewed',
  AUDIT_LOG_EXPORTED: 'audit_log.exported',

  // Data modification
  CUSTOMER_DELETED: 'customer.deleted',
  CUSTOMER_MERGED: 'customer.merged',
  CUSTOMER_UNMERGED: 'customer.unmerged',
  ORDER_CANCELLED: 'order.cancelled',
  CONVERSATION_DELETED: 'conversation.deleted',
  BULK_ACTION_EXECUTED: 'conversation.bulk_action',

  // Security configuration
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',
  PLUGIN_INSTALLED: 'plugin.installed',
  PLUGIN_REVOKED: 'plugin.revoked',
  CHANNEL_CONNECTED: 'channel.connected',
  CHANNEL_DISCONNECTED: 'channel.disconnected',
  SETTINGS_CHANGED: 'settings.changed',
  ROUTING_RULE_CHANGED: 'routing_rule.changed',
  RETENTION_CHANGED: 'retention.changed',
  AI_SETTINGS_CHANGED: 'ai_settings.changed',
  AI_CONSENT_CHANGED: 'ai_consent.changed',
  AI_AUTONOMOUS_CONSENT_CHANGED: 'ai_autonomous_consent.changed',   // TDD_12 §10

  // Compliance
  DSR_CREATED: 'dsr.created',
  DSR_VERIFIED: 'dsr.verified',
  DSR_ERASURE_COMPLETED: 'dsr.erasure_completed',
  DSR_EXPORT_COMPLETED: 'dsr.export_completed',
  DSR_REJECTED: 'dsr.rejected',
  CONSENT_RECORDED: 'consent.recorded',

  // Billing
  SUBSCRIPTION_CHANGED: 'subscription.changed',
  PAYMENT_METHOD_UPDATED: 'payment_method.updated',
  AI_CREDITS_PURCHASED: 'ai_credits.purchased',
  AI_PAYG_CHANGED: 'ai_payg.changed',

  // Internal admin (staff actor — TDD_15_InternalAdmin.md)
  STAFF_LOGIN: 'staff.login',
  ORG_VIEWED_BY_STAFF: 'org.viewed_by_staff',
  ORG_OVERRIDE_CREATED: 'org_override.created',
  ORG_OVERRIDE_REVOKED: 'org_override.revoked',
  ORG_SUSPENDED: 'org.suspended',
  ORG_REINSTATED: 'org.reinstated',
  ORG_TRIAL_EXTENDED: 'org.trial_extended',
  ORG_PLAN_FORCED: 'org.plan_forced',
  ORG_CREDIT_APPLIED: 'org.credit_applied',
  IMPERSONATION_STARTED: 'impersonation.started',
  IMPERSONATION_ELEVATED: 'impersonation.elevated',
  IMPERSONATION_WRITE: 'impersonation.write',
  IMPERSONATION_ENDED: 'impersonation.ended',
  AI_PROVIDER_SWITCHED: 'ai_provider.switched',
  AI_MODEL_REGISTRY_CHANGED: 'ai_model_registry.changed',
  AI_KILL_SWITCH_CHANGED: 'ai_kill_switch.changed',
  AI_CREDIT_ADJUSTED: 'ai_credit.adjusted',
  PLUGIN_SUBMISSION_REVIEWED: 'plugin_submission.reviewed',
  PLUGIN_SUSPENDED: 'plugin.suspended',
  FEATURE_FLAG_CHANGED: 'feature_flag.changed',
  PLATFORM_SETTING_CHANGED: 'platform_setting.changed',
} as const

export type AuditActionType = typeof AuditAction[keyof typeof AuditAction]
```

`AuditAction` values intentionally overlap with `Events` values where the same thing is
both a domain event and an audited action; they are separate constants because not every
event is audited and not every audited action is an event.

### 9.2 Service

Writes never block the request: the entry is enqueued in-process and flushed by a
bounded background writer. A failed audit write is logged and counted — it is never thrown
at the caller, and never silently dropped.

```typescript
// libs/core/audit/audit.service.ts
export interface AuditEntry {
  action: AuditActionType
  // Exactly one of userId/staffId — enforced by the CHECK constraint in TDD_01 §5 and
  // by the AuditActor union below.
  actor: { userId: string } | { staffId: string }
  storeId?: string
  organizationId?: string          // Org-level actions with no single store
  impersonationSessionId?: string
  resourceType?: string
  resourceId?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(AuditService.name) private readonly logger: PinoLogger,
  ) {}

  log(entry: AuditEntry): void {
    const write = this.prisma.client.auditLog
      .create({ data: this.toRow(entry) })
      .then(() => undefined)
      .catch((err: unknown) => this.logger.error({ err, action: entry.action }, 'audit log write failed'))
      .finally(() => this.pending.delete(write))
    this.pending.add(write)
  }

  // Graceful shutdown waits for in-flight audit writes (TDD_07 §1.6)
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.pending)
  }

  private toRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
    const { actor, metadata, ...rest } = entry
    return {
      ...rest,
      userId: 'userId' in actor ? actor.userId : null,
      staffId: 'staffId' in actor ? actor.staffId : null,
      metadata: metadata as Prisma.InputJsonValue | undefined,   // validated Record<string, unknown> → JSON boundary
    }
  }
}
```

**Interceptor for automatic auditing:**
```typescript
// libs/core/audit/audit.decorator.ts + audit.interceptor.ts
export const AUDIT_KEY = 'audit'
export const Audit = (action: AuditActionType, options: { resourceType: string; resourceIdParam?: string }) =>
  SetMetadata(AUDIT_KEY, { action, ...options })

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMetadata | undefined>(AUDIT_KEY, context.getHandler())
    if (!meta) return next.handle()
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>()
    return next.handle().pipe(tap(() => {
      this.audit.log({
        action: meta.action,
        actor: req.staff ? { staffId: req.staff.id } : { userId: req.user.id },
        storeId: req.store?.id,
        organizationId: req.organization?.id,
        impersonationSessionId: req.impersonation?.id,
        resourceType: meta.resourceType,
        resourceId: req.params[meta.resourceIdParam ?? 'id'],
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      })
    }))
  }
}

// Usage
@Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: 'customer' })
@Get(ApiRoutes.customers.byId(':id'))
async findOne(@Param('id') id: string) { }
```

**Staff and internal access.** Everything in this file — secrets, network
policies, rate limiting, TLS, GDPR — governs the customer-facing app.
Staff SSO, staff RBAC, impersonation, and IAP for the internal
admin console are a distinct concern, specified in full in
`TDD_15_InternalAdmin.md`. This `AuditService`/`AuditAction` pair is the single audit
trail for both — `TDD_15` reuses it rather than a parallel log.

### 9.3 Retention and access

- Audit logs are **immutable and append-only**: the `platform_app` role has `INSERT` and
  `SELECT` on `audit_logs`, never `UPDATE`/`DELETE`.
- Hot retention in Postgres: **2 years**, not configurable by tenants.
- Monthly job (`Schedules.EXPORT_AUDIT_LOGS`, `JobNames.EXPORT_AUDIT_LOGS_TO_COLD_STORAGE`)
  exports every entry older than 2 years to `s3://…/audit/{year}/{month}/audit-logs.jsonl.gz`
  (Deep Archive, `TDD_03` §6.4), verifies the object checksum, and only then deletes those
  rows with the `platform_worker` role. Cold copies are kept **7 years**. Nothing is
  deleted early, nothing is patched.
- Viewing the audit log is itself audited (`AUDIT_LOG_VIEWED`)
- Tenant viewer requires `Permissions.ORG_VIEW_AUDIT_LOG`; staff viewer requires
  `StaffPermissions.AUDIT_LOG_VIEW`
- Exportable to CSV for compliance requests (`AUDIT_LOG_EXPORTED`)

---

## 10. Compliance (GDPR / CCPA)

### 10.1 Constants

`DsrType` and `DsrStatus` are enums in `TDD_02` §5. The rest lives in
`libs/core/compliance/compliance-constants.ts`:

```typescript
export const ComplianceConfig = {
  DSR_RESPONSE_DEADLINE_DAYS: 30,
  DSR_DEADLINE_ALERT_DAY: 25,
  DSR_EXTENSION_DAYS: 60,
  DSR_VERIFICATION_TOKEN_DAYS: 7,
  DSR_EXPORT_LINK_DAYS: 7,
  BREACH_NOTIFICATION_HOURS: 72,
  ERASURE_GRACE_PERIOD_DAYS: 30,
  UNMERGE_WINDOW_DAYS: 30,
  ERASED_CONTENT_PLACEHOLDER: '[erased]',      // Written into Message.content on erasure
} as const

// Platform-wide floors/ceilings. Tenant-configurable values live in RetentionSettings;
// the effective window is min(RetentionSettings.*, plan historyRetentionDays) for
// conversations/messages (TDD_11 §1).
export const DataRetentionPolicies = {
  CONVERSATIONS:      { defaultDays: 730,  configurable: true  },   // Messages follow conversations
  MEDIA:              { defaultDays: 365,  configurable: true  },
  ORDERS:             { defaultDays: 2555, configurable: false },   // Tax: 7 years
  AUDIT_LOGS_HOT:     { defaultDays: 730,  configurable: false },   // Then cold storage, §9.3
  AUDIT_LOGS_COLD:    { defaultDays: 2555, configurable: false },
  ANALYTICS_EVENTS:   { defaultDays: 395,  configurable: true  },
  SESSIONS:           { defaultDays: 30,   configurable: false },
  VERIFICATION_TOKENS:{ defaultDays: 7,    configurable: false },
  NOTIFICATIONS:      { defaultDays: 90,   configurable: true  },
  WEBHOOK_DELIVERIES: { defaultDays: 30,   configurable: false },
  EXPORTS:            { defaultDays: 14,   configurable: false },
  CUSTOMER_MERGES:    { defaultDays: 30,   configurable: false },
} as const

export const LegalBases = {
  CONSENT: 'consent',
  CONTRACT: 'contract',
  LEGAL_OBLIGATION: 'legal_obligation',
  LEGITIMATE_INTERESTS: 'legitimate_interests',
} as const
```

### 10.2 Data subject request flow

```
Request filed (by subject through the public form, or by a store admin on their behalf)
  ↓  DataSubjectRequest { status: PENDING_VERIFICATION, deadlineAt: now + 30d }
  ↓  VerificationToken { type: DSR_VERIFICATION, expiresAt: now + 7d } → email (SEND_EMAIL, DSR_VERIFICATION)
Subject clicks verification link → POST /compliance/dsr/verify
  ↓  status → IN_PROGRESS, verifiedAt set, AuditAction.DSR_VERIFIED
ACCESS / PORTABILITY  → JobNames.DSR_EXPORT_DATA → encrypted ZIP → resultKey, resultExpiresAt = now + 7d
ERASURE               → JobNames.DSR_ERASE_DATA → anonymize + delete, respecting legal holds (§10.3)
RECTIFICATION / RESTRICTION / OBJECTION → status MANUAL_REVIEW, appears in the staff console
                        org detail view (TDD_15 §3) and in Settings → Compliance for the org admin
  ↓
status → COMPLETED, retainedRecordsSummary written, notification email sent
  ↓
Schedules.CHECK_DSR_DEADLINES (daily): any IN_PROGRESS / MANUAL_REVIEW request with
deadlineAt within DSR_DEADLINE_ALERT_DAY notifies org admins (NotificationTypes.DSR_DEADLINE_APPROACHING)
and staff (#compliance Slack), once (deadlineAlertSentAt).
```

### 10.3 Erasure with legal hold

Erasure is **anonymization plus targeted deletion**, not a blanket `DELETE`:

```
1. Customer record   → name replaced with the placeholder, email/phone/phoneNormalized nulled, erasedAt set
2. Channel identities → hard deleted (direct identifiers). A later message from the same
                       handle creates a brand-new Customer.
3. Message content   → replaced with ComplianceConfig.ERASED_CONTENT_PLACEHOLDER; rows kept for metrics
4. Media files       → deleted from S3 (all variants) and from the database
5. Addresses, notes  → hard deleted
6. Orders            → shipping address and customer notes cleared;
                       financial records retained under tax obligation (7 years, LegalBases.LEGAL_OBLIGATION)
7. Consents          → all revoked with timestamp
8. Billing           → BillableConversation rows kept (no PII), UsageRecords untouched
9. Audit entry       → DSR_ERASURE_COMPLETED with retainedRecordsSummary
```

The completion notice explicitly states which records were retained
and under which legal basis.

### 10.4 Automated retention enforcement

`Schedules.ENFORCE_RETENTION` runs hourly; each run picks the stores whose local time is
03:00 (`Store.timezone`), so every store is processed once a day at its own 03:00 and the
work is spread across the day instead of colliding with backups (`TDD_03` §7.2).

Per store, `JobNames.ENFORCE_RETENTION` (`HEAVY_PROCESSING` queue):
- Deletes resolved/archived conversations (and their messages) past
  `min(RetentionSettings.conversationDays, plan.historyRetentionDays)`, in batches of 500
- Deletes expired media from both S3 and the database
- Deletes analytics events past the window
- Deletes read notifications past the window
- Logs counts per category

Platform-wide, not per store (`Schedules.CLEANUP_PLATFORM_DATA`, daily):
- Expired sessions and verification tokens
- `WebhookDelivery` older than 30 days
- `Export` rows past `expiresAt` (and their S3 objects)
- `CustomerMerge` rows past `unmergeUntil` (the absorbed `Customer` row is then hard-deleted)

Orders and audit logs are never touched by tenant-configurable policies.

### 10.5 Cookie consent

```typescript
export const CookieCategories = {
  NECESSARY: 'necessary',     // No consent required
  FUNCTIONAL: 'functional',   // Language, last store
  ANALYTICS: 'analytics',     // Product usage
  MARKETING: 'marketing',     // Not used currently
} as const

export const COOKIE_POLICY_VERSION = '2026-09-01'
```

A public cookie registry page lists every cookie with name, category, purpose,
duration and provider. Consent choices are stored client-side (cookie `platform_cc`) and
recorded server-side in `CookieConsent` (`TDD_01` §4) keyed by `visitorId` and, once
logged in, `userId` — this covers platform users and anonymous visitors, who are not
`Customer` rows. A new `COOKIE_POLICY_VERSION` re-prompts.

### 10.6 Breach response runbook

```
T+0        Detection (Sentry alert, TenantViolation alert, audit anomaly, external report)
T+0-2h     Containment: isolate, revoke credentials, rotate secrets,
           preserve forensic evidence, assign incident commander
T+2-24h    Assessment: what data, how many subjects, which tenants,
           root cause, ongoing or contained, risk level
T+24-72h   Notification:
             - Supervisory authority within 72h (GDPR Art. 33)
             - Data subjects if high risk (Art. 34)
             - All affected organization admins regardless of risk
             - Status page incident
T+72h+     Remediation: permanent fix, regression test, threat model update,
           blameless post-mortem, runbook update
```

Full runbook: `docs/runbooks/data-breach.md`.

---

## 11. Application security checklist

Verify before every production release:

- [ ] All new endpoints have `AuthGuard` and `TenantGuard` (or are listed as public in `ApiRoutes.webhooks` / `ApiRoutes.widget`)
- [ ] All new endpoints declare required permissions
- [ ] All new queries filter by `storeId`
- [ ] `storeId` is never read from the request body or query string — only `request.store` from `TenantGuard`
- [ ] New mutating endpoints respect `AccessLevelGuard` (read-only dunning / impersonation)
- [ ] New request bodies have Zod schemas (and therefore no `storeId`/`organizationId` fields)
- [ ] New destructive actions have confirmation requirements
- [ ] New destructive actions are audited
- [ ] No new secrets in code or config files; new env vars added to the schema **and** `.env.example`
- [ ] New external calls have timeouts and error handling
- [ ] New file uploads validate type, size and key prefix
- [ ] New user-facing strings are i18n keys
- [ ] New LLM prompts keep tenant text out of the system prompt and validate output with Zod
- [ ] Tenant isolation tests updated for new resources
