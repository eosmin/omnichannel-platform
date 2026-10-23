# TDD 15 — Internal Admin Console

> Part of the Omnichannel Commerce Platform TDD v1.1
> Covers: staff-only backoffice, organization management, impersonation,
> AI operations, plugin moderation, feature flags, audit log. Plan editor and
> cross-tenant analytics are specified as Phase 2 / MATURE.

---

## 1. Why this is a separate surface

Everything else in this TDD set (`apps/api` tenant routes, `apps/web`) is tenant-facing —
every query goes through `TenantGuard`, scoped to one `storeId`. This console
is the deliberate, audited exception: staff need to see and change things
**across** organizations. That is not a variation of the customer app; it is
a different application with a different threat model.

```
apps/admin/                    ← Next.js app, separate deploy (admin-service, TDD_03 §1)
  ├─ Staff SSO only (OIDC: Google Workspace or Okta) — never a customer credential
  ├─ admin.platform.com behind Identity-Aware Proxy restricted to the staff Workspace group (Phase 1)
  │  or an ingress allowlist + NetworkPolicy (Phase 2, TDD_05 §2) — defence in depth on top of SSO
  ├─ Not linked from any customer-facing page
  └─ Every mutation logged via AuditService (§9, reuses TDD_05 §9) — no exceptions, ever

apps/api/src/modules/admin/    ← the staff API: /admin/v1/* (AdminRoutes, TDD_02 §7)
  ├─ StaffAuthGuard (staff JWT) + StaffPermissionGuard on every route
  └─ Its own services; it never flips tenant scoping off in shared services (§11)
```

**Layered protection — every layer is independent; none is the only wall:**

| Layer | Mechanism | Phase |
|---|---|---|
| 1. Separate, unlinked host | `admin.platform.com`, `robots: noindex`, no link from the customer app | 1 |
| 2. Identity-aware proxy (zero trust) | Google IAP (Cloud Run) or Cloudflare Access in front of `admin-service` and `/admin/v1/*`; the request never reaches our code until the proxy has verified the staff identity and MFA against the corporate IdP | 1 |
| 3. Application SSO | OIDC login inside the app, staff JWT with `aud: 'staff'` — works even if layer 2 is misconfigured | 1 |
| 4. Staff RBAC | `StaffRolePresets` (§2); a stolen Support token cannot refund or override | 1 |
| 5. Short, revocable sessions | 8-hour staff JWT; `Staff.active = false` revokes on the next request | 1 |
| 6. Full audit trail | Every read of an org and every mutation, with reason (§9) | 1 |
| 7. WAF + rate limiting | Same Cloudflare rules as the public app, stricter thresholds on `/admin/v1/auth/*` | 1 |
| 8. Corporate IP allowlist | Cloud Armor / ingress allowlist when the company has fixed egress IPs — additive, never sufficient alone | optional |
| 9. Network policy | K8s `NetworkPolicy` limiting who can reach the admin pods | 2 |

A VPN is deliberately not the primary control: a VPN grants network access with one
stolen credential; the identity-aware proxy authorizes per application, per person, per
request.

**Staff authentication.** `GET /admin/v1/auth/login` starts an OIDC Authorization Code +
PKCE flow (`openid-client`, `STAFF_OIDC_*` env). The callback verifies the ID token, checks
`email_verified` and the `STAFF_ALLOWED_EMAIL_DOMAIN`, upserts the `Staff` row by
`ssoSubject`, and issues a **staff JWT** (`StaffTokenService`: 8-hour TTL, `aud: 'staff'`,
`sub: staffId`, `role`). `StaffAuthGuard` accepts only tokens with `aud: 'staff'`;
`AuthGuard` (tenant API) rejects them. Session revocation is by `Staff.active = false`
(checked on every request, cached 30s). MFA is enforced at the IdP.

**Design rule:** any read here that crosses tenant boundaries is intentional
and logged. Any write here that affects a customer org requires a `reason`
field — freeform text is mandatory, not optional, because "why did we do
this" is the question every post-incident review starts with.

**Design system:** there is no shared component package to reuse —
`apps/web/components/ui/` (`TDD_01` §2.1) is shadcn's normal copy-in-per-app pattern.
`apps/admin` follows the exact same convention: its own `components/ui/` copied from the
same shadcn primitives, styled with the same Tailwind tokens, so the two apps look related
without maintaining a shared package. A distinct top-level shell/nav and a flatter, denser
layout (this is a staff tool, not a marketed product) sit on top. Single locale (English),
no i18n layer.

---

## 2. Staff roles (internal RBAC — separate from customer `Permissions`)

```typescript
// libs/core/admin/staff-constants.ts
export const StaffRoles = {
  SUPPORT: 'support',                      // View orgs, impersonate (read-only), small comps
  SALES: 'sales',                          // Create overrides, extend trials, view billing, no refunds
  FINANCE: 'finance',                      // Refunds, credits, dunning overrides, revenue share ledger
  PRODUCT_OPS: 'product_ops',              // Feature flags, plugin moderation
  ENGINEERING_ADMIN: 'engineering_admin',  // AI provider switch, kill switches, queues, everything below
} as const

export type StaffRole = typeof StaffRoles[keyof typeof StaffRoles]

export const StaffPermissions = {
  ORG_VIEW: 'org:view',
  ORG_IMPERSONATE: 'org:impersonate',
  ORG_IMPERSONATE_WRITE: 'org:impersonate:write',
  ORG_OVERRIDE_WRITE: 'org:override:write',
  ORG_OVERRIDE_PERMANENT: 'org:override:permanent',   // Finance sign-off for expiresAt = null
  ORG_SUSPEND: 'org:suspend',
  ORG_TRIAL_EXTEND: 'org:trial:extend',
  ORG_PLAN_FORCE: 'org:plan:force',
  BILLING_REFUND: 'billing:refund',
  AI_PROVIDER_SWITCH: 'ai:provider:switch',
  AI_KILL_SWITCH: 'ai:kill_switch',
  AI_CREDIT_ADJUST: 'ai:credit:adjust',
  PLUGIN_MODERATE: 'plugin:moderate',
  FEATURE_FLAG_WRITE: 'feature_flag:write',
  QUEUES_VIEW: 'queues:view',
  QUEUES_REPLAY: 'queues:replay',
  AUDIT_LOG_VIEW: 'audit_log:view',
  COMPLIANCE_REVIEW: 'compliance:review',
} as const

export type StaffPermission = typeof StaffPermissions[keyof typeof StaffPermissions]

// The role → permission matrix. StaffPermissionGuard evaluates exactly this.
export const StaffRolePresets: Record<StaffRole, readonly StaffPermission[]> = {
  [StaffRoles.SUPPORT]: [
    StaffPermissions.ORG_VIEW, StaffPermissions.ORG_IMPERSONATE, StaffPermissions.AI_CREDIT_ADJUST,
    StaffPermissions.AUDIT_LOG_VIEW, StaffPermissions.COMPLIANCE_REVIEW,
  ],
  [StaffRoles.SALES]: [
    StaffPermissions.ORG_VIEW, StaffPermissions.ORG_OVERRIDE_WRITE, StaffPermissions.ORG_TRIAL_EXTEND,
    StaffPermissions.ORG_PLAN_FORCE, StaffPermissions.AUDIT_LOG_VIEW,
  ],
  [StaffRoles.FINANCE]: [
    StaffPermissions.ORG_VIEW, StaffPermissions.ORG_OVERRIDE_WRITE, StaffPermissions.ORG_OVERRIDE_PERMANENT,
    StaffPermissions.ORG_SUSPEND, StaffPermissions.BILLING_REFUND, StaffPermissions.AI_CREDIT_ADJUST,
    StaffPermissions.AUDIT_LOG_VIEW,
  ],
  [StaffRoles.PRODUCT_OPS]: [
    StaffPermissions.ORG_VIEW, StaffPermissions.PLUGIN_MODERATE, StaffPermissions.FEATURE_FLAG_WRITE,
    StaffPermissions.AUDIT_LOG_VIEW,
  ],
  [StaffRoles.ENGINEERING_ADMIN]: Object.values(StaffPermissions),
}
```

Every screen and mutation below is gated by `StaffPermissionGuard` +
`@RequireStaffPermissions()`, the same guard shape as the customer-facing
`@RequirePermissions()` — staff permissions are just as real as customer ones, they are
not "trusted because internal". Denials return `STAFF_PERMISSION_DENIED` and are audited.

---

## 3. Organization management

**Search** (`AdminRoutes.organizations.search`): by org name, billing email, Stripe customer
id, store id or user email. Viewing an organization is audited (`ORG_VIEWED_BY_STAFF`).

```
Admin → Organizations → [search]

┌─────────────────────────────────────────────────────────────────┐
│ Acme Store                                    GROWTH · $89/mo   │
│ acme@example.com · org_8f2a1c · 3 stores · 11 seats             │
│ Status: active · Renews Oct 3, 2026 · Access: full              │
│                                                                   │
│ [View as store]  [Edit overrides]  [Suspend]  [Billing history] │
└─────────────────────────────────────────────────────────────────┘
```

Detail view: current plan + **effective** limits and usage this period (reuses
`EffectivePlanLimitsService` and `UsageMeteringService.getCurrentPeriodUsage`,
`TDD_11` §1.1/§2), every store, every seat, channel connections and their health, payment
status and dunning step, support tier, DSR requests in manual review
(`COMPLIANCE_REVIEW`, `TDD_05` §10.2), and the org's full audit trail filtered to
`organizationId` (§9) — anyone who ever touched this account, staff or customer, and why.

### 3.1 Organization overrides

`PlanLimits` (`TDD_11` §1) is a static table shared by every org on a tier. Real
negotiated deals — an Enterprise contract, a goodwill comp, a grandfathered legacy price —
don't fit a shared constant. They need a per-org override that composes on top of the
plan, with an expiry, because negotiated terms are rarely permanent. The model is
`OrganizationOverride` (`TDD_01` §4); the merge is `EffectivePlanLimitsService.resolve`
(`TDD_11` §1.1), which **every** limit consumer already calls.

```typescript
// apps/api/src/modules/admin/organization-overrides.service.ts
export const createOverrideSchema = z.object({
  field: z.enum(OverridableLimitFields),
  value: z.number(),
  reason: z.string().min(10).max(500),
  expiresAt: z.iso.datetime().nullable(),
})

@Injectable()
export class OrganizationOverridesService {
  async create(organizationId: string, input: CreateOverrideInput, staff: Staff): Promise<OrganizationOverride> {
    if (input.expiresAt === null && !hasStaffPermission(staff, StaffPermissions.ORG_OVERRIDE_PERMANENT)) {
      throw new PlatformException(ErrorCodes.STAFF_PERMISSION_DENIED, 'Permanent overrides require Finance sign-off', 403)
    }

    const override = await this.prisma.client.organizationOverride.create({
      data: {
        organizationId,
        field: input.field,
        value: input.value,
        reason: input.reason,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdByStaffId: staff.id,
        approvedByStaffId: input.expiresAt === null ? staff.id : null,
      },
    })

    this.audit.log({
      actor: { staffId: staff.id }, action: AuditAction.ORG_OVERRIDE_CREATED, organizationId,
      resourceType: 'organization_override', resourceId: override.id,
      metadata: { field: input.field, value: input.value, reason: input.reason, expiresAt: input.expiresAt },
    })
    this.events.emit(Events.ORGANIZATION_OVERRIDE_CHANGED, { organizationId } satisfies PlanLimitsInvalidatedPayload)
    return override
  }

  async revoke(organizationId: string, overrideId: string, reason: string, staff: Staff): Promise<void> {
    await this.prisma.client.organizationOverride.update({ where: { id: overrideId, organizationId }, data: { revokedAt: new Date() } })
    this.audit.log({ actor: { staffId: staff.id }, action: AuditAction.ORG_OVERRIDE_REVOKED, organizationId, resourceType: 'organization_override', resourceId: overrideId, metadata: { reason } })
    this.events.emit(Events.ORGANIZATION_OVERRIDE_CHANGED, { organizationId })
  }
}
```

Expired overrides stop applying on their own (`resolve` filters by `expiresAt`); the cache
TTL bounds the lag to `CacheTTL.MEDIUM`.

**Actions available (permission-gated, all with `reason`, all audited):**

| Action | Route | Permission | Effect |
|---|---|---|---|
| Suspend / reinstate | `organizations.suspend` / `.reinstate` | `ORG_SUSPEND` | `Organization.accessLevel`, `ORGANIZATION_ACCESS_LEVEL_CHANGED` |
| Extend trial by N days | `organizations.extendTrial` | `ORG_TRIAL_EXTEND` | Stripe `subscriptions.update({ trial_end })`; the webhook syncs |
| Apply account credit or refund | `organizations.credit` | `BILLING_REFUND` | Stripe customer balance / refund — never a manual ledger entry outside Stripe |
| Force a plan change | `organizations.changePlan` | `ORG_PLAN_FORCE` | Stripe subscription item swap without Checkout (migrations, sales-assisted downgrades) |
| Adjust AI credits | `ai.adjustCredits` | `AI_CREDIT_ADJUST` | `AiCreditService.credit({ reason: STAFF_ADJUSTMENT })` (§6) |

---

## 4. Impersonation ("View as store")

The single most misusable feature in this console, so it gets the most guardrails:

- **Read-only by default, time-boxed to 15 minutes.** Extending means starting a new
  session (new reason, new audit entry), never a silent renewal.
- **Writes require elevation** (`ORG_IMPERSONATE_WRITE`): a second explicit confirmation
  in the console ("You are about to act as this organization — confirm"), which sets
  `mode = write` and `elevatedAt`. Every write made while elevated is additionally
  audited as `IMPERSONATION_WRITE` with the `impersonationSessionId`.
- **The customer always knows.** A persistent banner renders in their app for the
  duration — "Support is viewing your account (ticket #1234) — [End session]" — delivered
  by `RealtimeEvents.IMPERSONATION_STATUS` to the organization room and by
  `NotificationTypes.IMPERSONATION_STARTED` to admins. Any org admin can end it
  (`POST /organizations/current/impersonation/end`, `ORG_END_IMPERSONATION`).
- **Org-level opt-out.** Some Enterprise contracts contractually forbid impersonation;
  `Organization.impersonationBlocked = true` makes `ORG_IMPERSONATE` fail closed
  (`IMPERSONATION_BLOCKED`), no override possible from this console.

**How it works technically.** Starting a session mints a **customer-app access token**
(`AuthService.issueImpersonationToken`): a 15-minute JWT whose `sub` is the org's first
admin user, plus `imp: <sessionId>` and `aud: 'tenant'`. The token hash is stored on
`ImpersonationSession.tokenHash`. On every request:

1. `AuthGuard` sees `imp`, loads the session, and rejects with `IMPERSONATION_EXPIRED` if
   `endedAt` is set or `expiresAt` passed (the customer ending the session invalidates the
   token immediately).
2. `TenantGuard` sets `request.impersonation` and `request.accessLevel = READ_ONLY` unless
   `mode = write`.
3. `AccessLevelGuard` blocks mutations in read-only mode (`TENANT_READ_ONLY`).
4. `AuditInterceptor` stamps `impersonationSessionId` on everything.

The console opens `apps/web` in a new tab with the token passed through a one-time
exchange code (never in the URL for longer than the redirect); `apps/web` shows its own
"You are impersonating" bar to the staff member.

```typescript
// apps/api/src/modules/admin/impersonation.service.ts
@Injectable()
export class ImpersonationService {
  async start(staff: Staff, organizationId: string, reason: string): Promise<ImpersonationStartResult> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId } })
    if (org.impersonationBlocked) {
      throw new PlatformException(ErrorCodes.IMPERSONATION_BLOCKED, 'Not permitted for this org', 403)
    }

    const expiresAt = addMinutes(new Date(), ImpersonationConfig.SESSION_MINUTES)   // 15
    const { token, tokenHash, subjectUserId } = await this.auth.issueImpersonationToken(organizationId, expiresAt)

    const session = await this.prisma.client.impersonationSession.create({
      data: { staffId: staff.id, organizationId, reason, expiresAt, tokenHash, mode: ImpersonationMode.READ_ONLY },
    })

    this.audit.log({
      actor: { staffId: staff.id }, action: AuditAction.IMPERSONATION_STARTED,
      organizationId, impersonationSessionId: session.id, metadata: { reason, subjectUserId },
    })

    await this.notifications.sendToOrganization({
      organizationId, type: NotificationTypes.IMPERSONATION_STARTED,
      params: { reason }, actionPath: AppPaths.org.auditLog, requiredPermission: Permissions.ORG_END_IMPERSONATION,
    })
    this.realtime.notifyOrganization(organizationId, RealtimeEvents.IMPERSONATION_STATUS, {
      active: true, sessionId: session.id, reason, expiresAt: expiresAt.toISOString(),
    })

    return { sessionId: session.id, accessToken: token, expiresAt }
  }

  async end(sessionId: string, endedBy: ImpersonationEndedByType, actor?: { staffId?: string; userId?: string }): Promise<void> {
    const session = await this.prisma.client.impersonationSession.update({
      where: { id: sessionId, endedAt: null }, data: { endedAt: new Date(), endedBy },
    })
    this.audit.log({
      actor: actor?.staffId ? { staffId: actor.staffId } : actor?.userId ? { userId: actor.userId } : { staffId: session.staffId },
      action: AuditAction.IMPERSONATION_ENDED, organizationId: session.organizationId,
      impersonationSessionId: session.id, metadata: { endedBy },
    })
    this.realtime.notifyOrganization(session.organizationId, RealtimeEvents.IMPERSONATION_STATUS, { active: false, sessionId: null, reason: null, expiresAt: null })
  }
}

export const ImpersonationEndedBy = { STAFF: 'staff', CUSTOMER: 'customer', EXPIRED: 'expired' } as const
```

Expiry is enforced by `AuthGuard` on each request and swept by
`Schedules.EXPIRE_IMPERSONATION_SESSIONS` (`TDD_07` §4) so the banner disappears even when
no request arrives.

---

## 5. Plans & entitlements editor (Phase 2)

In Phase 1 plans are the `PlanLimits` constant plus per-org overrides (§3.1); changing a
tier's numbers is a code change with a PR, which is the right friction for a pricing change
at this stage. The DB-backed, versioned plan editor below is **Phase 2** and is recorded
here so the data model can grow toward it without rework.

```
Admin → Plans → Growth → Edit                                     (Phase 2)

┌────────────────────────────────────────────────────────────────┐
│ Editing: GROWTH                              currently v3       │
│                                                                  │
│ Included conversations   [5000    ]                             │
│ Overage per conversation [$0.02   ]                              │
│ AI credits (Chispas)     [3000    ]                              │
│ Channels included        [x] Web [x] Email [x] IG [x] Messenger  │
│                          [x] WhatsApp                            │
│                                                                  │
│ [AlertTriangle] Impact preview: 340 active Growth subscriptions. │
│   Existing subscribers keep v3 terms unless you also run a      │
│   migration — this edit only affects NEW signups by default.    │
│                                                                  │
│                                    [Save as draft]  [Publish v4] │
└────────────────────────────────────────────────────────────────┘
```

**When implemented:** a `PlanVersion` table and `Subscription.planVersionId` are added;
`EffectivePlanLimitsService` reads the pinned version instead of the constant; a plan
migration emits a new `PLAN_PUBLISHED` event (added to `Events` in that change) with the
affected `organizationId`s so cached limits are invalidated. No such event exists today.

---

## 6. AI operations

Runtime knobs live in `PlatformSetting` (`TDD_01` §4), edited here and read through
`PlatformSettingsService` (L1 + L2 cached, invalidated by `PLATFORM_SETTING_CHANGED`):

```typescript
// libs/core/admin/platform-setting-keys.ts
export const PlatformSettingKeys = {
  AI_ACTIVE_PROVIDER: 'ai.active_provider',            // AIProvider, default 'anthropic'
  AI_MODEL_REGISTRY: 'ai.model_registry',              // provider → tier → ModelSpec, default DefaultModelRegistry (TDD_12 §2)
  AI_AUTONOMOUS_KILL_SWITCH: 'ai.autonomous_kill_switch',   // boolean, default false
  MAINTENANCE_MODE: 'platform.maintenance_mode',       // boolean, default false
} as const
```

`PlatformSettingsService.get(key, schema, defaultValue)` validates the stored JSON with the
key's Zod schema and falls back to the default when the row is absent or invalid, so a bad
edit can never take the platform down.

```
Admin → AI Operations

┌─────────────────────────────────────────────────────────────────┐
│ Active provider: Anthropic          [Switch to OpenAI]           │
│   (OpenAI is unavailable until its models are configured below)  │
│                                                                    │
│ Model per tier (Anthropic)                        [Edit]          │
│   fast      claude-haiku-4-5    $1 / $5 per M tokens              │
│   balanced  claude-sonnet-5     $3 / $15                          │
│   premium   claude-sonnet-5     $3 / $15   (same as balanced)     │
│                                                                    │
│ Autonomous chatbot: Enabled platform-wide   [Kill switch]         │
│   Per-organization kill switch: Organizations → [org] → AI        │
│                                                                    │
│ Prompt versions in use (last 7 days)                              │
│   suggested-replies@3  98%   suggested-replies@2  2%             │
└─────────────────────────────────────────────────────────────────┘

Per-org Chispas
┌─────────────────────────────────────────────────────────────────┐
│ Acme Store          1,847 / 3,000        [Adjust balance]        │
│                                                                    │
│ Adjust: [+500] chispas   Reason: [goodwill comp — ticket #1234]  │
└─────────────────────────────────────────────────────────────────┘
```

- **Provider switch** (`AI_PROVIDER_SWITCH`) writes `AI_ACTIVE_PROVIDER`; `AIService` reads
  it per call, so no redeploy. Switching to a provider whose model registry entries are
  empty is rejected (`ModelRegistryService.resolve` throws). Automatic rollback: the `AICostSpike`/error-rate
  alerts page the on-call; rollback is a manual switch back (Phase 1 — an automatic
  rollback loop is not built until there are two live providers).
- **Model per tier** (`AI_PROVIDER_SWITCH`) writes `AI_MODEL_REGISTRY`: which concrete model
  (and its prices for the cost dashboard) backs `fast`, `balanced` and `premium` for each
  provider. Feature code only ever asks for a tier (`TDD_12` §2), so swapping the chatbot from
  Sonnet to Opus, or trying a new release on `fast` first, is a form edit here — audited as
  `AI_MODEL_REGISTRY_CHANGED`, effective within `CacheTTL.MEDIUM`.
- **Autonomous chatbot kill switch** (`AI_KILL_SWITCH`) — platform-wide here, or
  per-organization (`AISettings.autonomousKillSwitch` on every store of the org). Immediate:
  every queued turn hands off (`TDD_12` §13.1).
- **Chispa balance adjustment** (`AI_CREDIT_ADJUST`) — requires `reason`, writes an
  `AiCreditTransaction` with `reason: STAFF_ADJUSTMENT` and the `staffId`, visible to the org
  in their own usage screen so nothing looks like an unexplained number changed.
- **Prompt versions** are read-only telemetry from `AIUsageRecord.promptVersion`. Prompts
  are code (`TDD_12` §11); a canary rollout of prompts is Phase 2.

The AI health dashboard (`TDD_12` §9) lives on this page.

---

## 7. Plugin marketplace moderation (MATURE)

The marketplace is MATURE (`TDD_00` §5). In Phase 1 the only `Plugin` rows are the five
official channels, seeded with `isOfficial = true`, `status = APPROVED`,
`pricingModel = plan_gated`. The review queue below ships with the marketplace:

```
Admin → Plugin Submissions                                         (MATURE)

┌─────────────────────────────────────────────────────────────────┐
│ Telegram Integration  by Acme Inc         Submitted 2 days ago   │
│ Scopes: conversations:read/write, messages:read/write            │
│                                                                    │
│ [x] Manifest valid  [x] Scopes justified  [x] Webhook verified   │
│ [x] HTTPS  [x] Privacy policy  [ ] Rate limits declared          │
│                                                                    │
│      [Request changes]  [Reject]  [Approve & publish]            │
└─────────────────────────────────────────────────────────────────┘
```

- Review outcomes map to `PluginStatus` (`CHANGES_REQUESTED`, `REJECTED`, `APPROVED`) with
  `reviewNotes`, audited as `PLUGIN_SUBMISSION_REVIEWED`.
- **Suspend a published plugin** platform-wide (`PLUGIN_SUSPENDED`) if it turns out
  compromised or abusive — installs remain (a store's data isn't touched) but plugin API
  keys stop working and webhook delivery pauses immediately (`TDD_10` §6.5 filters on
  `plugin.status`).
- **Revenue share ledger** for `paid` plugins (`TDD_10` §8.1) is specified with the
  marketplace billing (Stripe Connect for developers); no model exists in Phase 1.

---

## 8. Feature flags

Independent of plan tier — a flag is **temporary** (beta-gating a feature
still being validated), a plan entitlement is **permanent**. A flag
gets deleted the day a feature goes GA; it never becomes a second,
shadow pricing mechanism.

```typescript
// libs/core/admin/feature-flag.service.ts
@Injectable()
export class FeatureFlagService {
  // Evaluation order: env kill switch → denylist → allowlist → rollout bucket
  async isEnabled(key: FeatureFlagKey, organizationId: string): Promise<boolean> {
    if (EnvKillSwitches[key] && !EnvKillSwitches[key]()) return false     // FEATURE_* env (TDD_02 §9)

    const flag = await this.cache.getOrSet(CacheKeys.platform.featureFlag(key), () => this.load(key), CacheTTL.MEDIUM)
    if (!flag) return false
    if (flag.orgDenylist.includes(organizationId)) return false
    if (flag.orgAllowlist.includes(organizationId)) return true
    return bucket(key, organizationId) < flag.rolloutPercent         // Stable hash 0-99 per (key, org)
  }
}

export const FeatureFlagKeys = {
  AI_SUGGESTED_REPLIES_V2: 'ai.suggested_replies_v2',
  INBOX_NEW_COMPOSER: 'inbox.new_composer',
} as const   // Keys are added and removed with the features they gate
```

Flags are edited at `AdminRoutes.featureFlags.*` (`FEATURE_FLAG_WRITE`), audited as
`FEATURE_FLAG_CHANGED`, and invalidated through `FEATURE_FLAG_CHANGED` events.
When a flagged feature reaches GA, it graduates into `PlanFeatures` (`TDD_11` §1) or becomes
unconditional, and the flag is deleted in the same change — never left around "just in case".

---

## 9. Audit log viewer

Every `AuditAction.*` across the whole platform — tenant-side actions and every staff
action in this console — lands in one searchable, append-only log (`TDD_05` §9).

```
Admin → Audit Log

Filter: [Organization ▾] [Staff member ▾] [Action type ▾] [Date range ▾]

2026-09-03 14:02  staff:jane@platform.com   org_override.created
                  Acme Store — aiCreditsIncluded → 5000 (was 3000)
                  Reason: "Enterprise pilot, 90-day trial credit"

2026-09-03 13:41  staff:jane@platform.com   impersonation.started
                  Acme Store — reason: "ticket #1234, debugging webhook"
```

**Immutable, append-only.** Not editable by any role, including `ENGINEERING_ADMIN` (the
database role has no `UPDATE`/`DELETE` on `audit_logs`). Retention follows `TDD_05` §9.3:
2 years hot, then exported to cold storage and purged — never deleted early, never patched.
Viewing here is audited (`AUDIT_LOG_VIEWED`) like everywhere else.

---

## 10. Cross-tenant analytics (MATURE)

Explicitly distinct from two things that already exist and are **not** duplicated here:

| | Where | Audience | Drill-down by org? |
|---|---|---|---|
| Per-store analytics | `TDD_11` §7 | Store admins, about their own store | N/A — already scoped to one org |
| Infra/ops dashboards | `TDD_04` §8 | Engineering on-call | No — aggregate only |
| **This section** | Admin → Analytics | Product, Sales, Finance | **Yes** |

This is staff-facing BI: MRR, churn, plan distribution, upgrade/downgrade funnel
(Free → Micro → Starter → Growth → Scale), Chispas consumption trends, cohort retention,
revenue per channel. It is backed by the warehouse in `TDD_11` §7.5 (OLTP Postgres
replicated out, queried via a BI tool) so a heavy exploratory query from Sales never touches
production latency — and that warehouse is MATURE (`TDD_00` §5). **Phase 1 ships a small
"Platform health" card on the console home instead:** organizations per tier, active
organizations (7d), MRR from `Subscription` rows, and open DSRs — four read-replica queries,
cached hourly.

```
Admin → Analytics                                                  (MATURE)

MRR: $184,320 (+4.2% MoM)          Churn: 2.1% (target < 3%)

Plan distribution
Free    ████████████████████████████████  1,240 orgs
Micro   ██████████                          310 orgs
Starter ████████                            240 orgs
Growth  ███                                  95 orgs
Scale   █                                    18 orgs

Upgrade funnel (last 90d): Free→Micro 4.1% · Micro→Starter 8.3% ·
Starter→Growth 11.2% · Growth→Scale 3.4%
```

---

## 11. What this console does not do

- It never bypasses `TenantGuard` silently — every cross-tenant read is a
  deliberate query in a service written for this console (`apps/api/src/modules/admin`),
  running under the `platform_worker` database role, not a flag that turns tenant scoping
  off in the shared services.
- It is not where customers go — there is no login path from the
  customer-facing app into this console, ever.
- It does not replace Stripe's own dashboard for raw payment operations
  (chargebacks, tax, PCI-scoped card data) — linked out to Stripe for those,
  same principle as `TDD_11` §4's "Stripe's hosted portal handles payment methods…
  building that UI ourselves would be wasted effort."
