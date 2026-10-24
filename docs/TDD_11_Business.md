# TDD 11 — Business Layer

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: billing, subscriptions, quotas, referrals, analytics, SaaS support

---

## 1. Pricing model

```typescript
// libs/core/billing/billing-constants.ts
export const PlanTiers = {
  FREE: 'free',
  MICRO: 'micro',
  STARTER: 'starter',
  GROWTH: 'growth',
  SCALE: 'scale',
  ENTERPRISE: 'enterprise',
} as const

export type PlanTier = typeof PlanTiers[keyof typeof PlanTiers]

export const BillingIntervals = { MONTHLY: 'monthly', YEARLY: 'yearly' } as const
export type BillingInterval = typeof BillingIntervals[keyof typeof BillingIntervals]

export const PlanFeatures = {
  INBOX: 'inbox',
  ORDERS: 'orders',
  ANALYTICS: 'analytics',
  ROUTING: 'routing',
  WEBHOOKS: 'webhooks',
  TAGS: 'tags',
  SNIPPETS: 'snippets',
  BUSINESS_HOURS: 'business_hours',
  SCHEDULED_REPORTS: 'scheduled_reports',
  CUSTOM_ROLES: 'custom_roles',
  API_KEYS: 'api_keys',
  THIRD_PARTY_PLUGINS: 'third_party_plugins',
  AI_ASSIST: 'ai_assist',                            // Suggested replies, summaries, tagging, sentiment, spam
  AI_AUTONOMOUS_CHATBOT: 'ai_autonomous_chatbot',    // Scale+ only, see TDD_12 §1/§13
  SSO: 'sso',
  AUDIT_LOG_EXPORT: 'audit_log_export',
  SLA_RULES: 'sla_rules',
} as const

export type PlanFeature = typeof PlanFeatures[keyof typeof PlanFeatures]

export const SupportTiers = {
  COMMUNITY: 'community',
  STANDARD: 'standard',
  PRIORITY: 'priority',
  DEDICATED: 'dedicated',
} as const
export type SupportTier = typeof SupportTiers[keyof typeof SupportTiers]

// Which official channel plugins a tier unlocks. Enforced by ChannelGuard (§6.5) at
// connect time. Channel ids ARE ChannelType values — one identifier set (TDD_02 §5).
// Third-party marketplace channels are separate: gated by maxChannels count and, if
// plan_gated, by their own manifest.pricing.allowedTiers.
export const AvailableChannels: Record<PlanTier, {
  included: readonly ChannelType[]
  // Starter can activate exactly one of these — not both. Upgrading to
  // Growth is what removes the choice and unlocks every social channel.
  chooseOneOf?: readonly ChannelType[]
}> = {
  [PlanTiers.FREE]:    { included: [ChannelType.WEB_WIDGET] },
  [PlanTiers.MICRO]:   { included: [ChannelType.WEB_WIDGET, ChannelType.EMAIL] },
  [PlanTiers.STARTER]: {
    included: [ChannelType.WEB_WIDGET, ChannelType.EMAIL],
    chooseOneOf: [ChannelType.INSTAGRAM, ChannelType.MESSENGER],
  },
  [PlanTiers.GROWTH]:     { included: Object.values(ChannelType) },
  [PlanTiers.SCALE]:      { included: Object.values(ChannelType) },
  [PlanTiers.ENTERPRISE]: { included: Object.values(ChannelType) },
}

export interface PlanLimitsShape {
  monthlyPriceCents: number
  yearlyPriceCents: number
  includedConversations: number
  overagePerConversationCents: number     // Tenths of a cent are avoided: 3.5¢ is expressed via Stripe's per-unit price; here it is informational
  maxStores: number
  maxSeats: number
  maxChannels: number
  historyRetentionDays: number
  apiRateLimitPerMinute: number
  supportTier: SupportTier
  features: readonly PlanFeature[]
  // AI credits ("Chispas") included per month. Null = AI not available on
  // this tier at all (no consent screen shown). See TDD_12 §9.5.
  aiCreditsIncluded: number | null
}

const BASE_FEATURES: readonly PlanFeature[] = [PlanFeatures.INBOX, PlanFeatures.ORDERS, PlanFeatures.ANALYTICS]
const STARTER_FEATURES: readonly PlanFeature[] = [
  ...BASE_FEATURES, PlanFeatures.ROUTING, PlanFeatures.WEBHOOKS, PlanFeatures.TAGS, PlanFeatures.SNIPPETS, PlanFeatures.API_KEYS,
]
const GROWTH_FEATURES: readonly PlanFeature[] = [
  ...STARTER_FEATURES, PlanFeatures.BUSINESS_HOURS, PlanFeatures.SCHEDULED_REPORTS, PlanFeatures.CUSTOM_ROLES,
  PlanFeatures.THIRD_PARTY_PLUGINS, PlanFeatures.AI_ASSIST,
]
const SCALE_FEATURES: readonly PlanFeature[] = [
  ...GROWTH_FEATURES, PlanFeatures.AI_AUTONOMOUS_CHATBOT, PlanFeatures.SSO, PlanFeatures.AUDIT_LOG_EXPORT, PlanFeatures.SLA_RULES,
]

// -1 means unlimited throughout
export const UNLIMITED = -1
export function isUnlimited(limit: number): boolean { return limit === UNLIMITED }

export const PlanLimits: Record<PlanTier, PlanLimitsShape> = {
  [PlanTiers.FREE]: {
    monthlyPriceCents: 0, yearlyPriceCents: 0,
    includedConversations: 100,
    overagePerConversationCents: 0,          // Hard cap, no overage
    maxStores: 1, maxSeats: 2, maxChannels: 1,
    historyRetentionDays: 30,
    apiRateLimitPerMinute: 60,
    supportTier: SupportTiers.COMMUNITY,
    features: BASE_FEATURES,
    aiCreditsIncluded: null,
  },
  [PlanTiers.MICRO]: {
    monthlyPriceCents: 1200, yearlyPriceCents: 12000,   // 2 months free
    includedConversations: 400,
    overagePerConversationCents: 4,          // Deliberately above Starter's rate — nudges fast growth to upgrade
    maxStores: 1, maxSeats: 3, maxChannels: 2,
    historyRetentionDays: 180,
    apiRateLimitPerMinute: 120,
    supportTier: SupportTiers.COMMUNITY,
    // Same feature set as Free — Micro buys volume/retention/seats, not features.
    features: BASE_FEATURES,
    aiCreditsIncluded: null,
  },
  [PlanTiers.STARTER]: {
    monthlyPriceCents: 2900, yearlyPriceCents: 29000,
    includedConversations: 1000,
    overagePerConversationCents: 3,
    maxStores: 1, maxSeats: 5, maxChannels: 3,
    historyRetentionDays: 365,
    apiRateLimitPerMinute: 300,
    supportTier: SupportTiers.STANDARD,
    features: STARTER_FEATURES,
    aiCreditsIncluded: null,
  },
  [PlanTiers.GROWTH]: {
    monthlyPriceCents: 8900, yearlyPriceCents: 89000,
    includedConversations: 5000,
    overagePerConversationCents: 2,
    maxStores: 3, maxSeats: 15, maxChannels: 10,
    historyRetentionDays: 730,
    apiRateLimitPerMinute: 1000,
    supportTier: SupportTiers.PRIORITY,
    features: GROWTH_FEATURES,
    aiCreditsIncluded: 3000,                 // ~15% of $89 at ≈$0.004 real cost/credit
  },
  [PlanTiers.SCALE]: {
    monthlyPriceCents: 24900, yearlyPriceCents: 249000,
    includedConversations: 20000,
    overagePerConversationCents: 2,          // Stripe price carries 1.5¢; see note above
    maxStores: 10, maxSeats: 50, maxChannels: 25,
    historyRetentionDays: 1095,
    apiRateLimitPerMinute: 3000,
    supportTier: SupportTiers.PRIORITY,
    features: SCALE_FEATURES,
    aiCreditsIncluded: 9000,
  },
  [PlanTiers.ENTERPRISE]: {
    monthlyPriceCents: UNLIMITED, yearlyPriceCents: UNLIMITED,   // Custom, negotiated
    includedConversations: UNLIMITED,
    overagePerConversationCents: 0,
    maxStores: UNLIMITED, maxSeats: UNLIMITED, maxChannels: UNLIMITED,
    historyRetentionDays: UNLIMITED,
    apiRateLimitPerMinute: 10000,
    supportTier: SupportTiers.DEDICATED,
    features: Object.values(PlanFeatures),
    aiCreditsIncluded: UNLIMITED,            // Negotiated per contract
  },
}

// Fields a staff override may replace (TDD_15 §3.1). Closed list, validated by Zod.
export const OverridableLimitFields = [
  'includedConversations', 'maxSeats', 'maxStores', 'maxChannels', 'aiCreditsIncluded',
  'overagePerConversationCents', 'historyRetentionDays', 'apiRateLimitPerMinute',
] as const satisfies ReadonlyArray<keyof PlanLimitsShape>
export type OverridableLimitField = typeof OverridableLimitFields[number]

// The unit we charge for — this definition must never drift
export const BillingUnits = {
  // A conversation is billable once per 24h window. A window opens with the first inbound
  // customer message that is not inside an open window, and closes 24h later. Internal
  // notes, agent-only activity and system messages never open a window. A conversation
  // marked SPAM inside the window is voided (§2).
  CONVERSATION_WINDOW_HOURS: 24,
} as const

export const SubscriptionStatus = {
  TRIALING: 'trialing',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  UNPAID: 'unpaid',
  PAUSED: 'paused',
} as const
export type SubscriptionStatusType = typeof SubscriptionStatus[keyof typeof SubscriptionStatus]

// Stripe invoice.billing_reason values we branch on
export const StripeBillingReasons = {
  SUBSCRIPTION_CREATE: 'subscription_create',
  SUBSCRIPTION_CYCLE: 'subscription_cycle',
  SUBSCRIPTION_UPDATE: 'subscription_update',
  MANUAL: 'manual',
} as const
export type StripeBillingReason = typeof StripeBillingReasons[keyof typeof StripeBillingReasons] | string

export const TRIAL_DAYS = 14
export const TRIAL_ENDING_NOTICE_DAYS = 3
```

**Why conversations, not seats:** the value the platform delivers scales with
customer volume, not with how many people log in. Charging per seat would
punish stores for adding a part-time weekend agent.

### 1.1 Effective plan limits — the single source of truth

`PlanLimits[tier]` is the base; `OrganizationOverride` rows (`TDD_01` §4, written by the
staff console, `TDD_15` §3.1) compose on top. **Every consumer of limits — guards,
metering, credits, retention, throttling, the billing UI — calls
`EffectivePlanLimitsService.resolve()`; nothing reads `PlanLimits[tier]` directly.**
`Subscription` holds no limit columns.

```typescript
// libs/core/billing/effective-plan-limits.service.ts
@Injectable()
export class EffectivePlanLimitsService {
  constructor(private readonly prisma: PrismaService, private readonly cache: RedisCacheService) {}

  // Cached per TDD_08 §1.3 — invalidated by ORGANIZATION_OVERRIDE_CHANGED and SUBSCRIPTION_*.
  async resolve(organizationId: string): Promise<PlanLimitsShape & { tier: PlanTier }> {
    return this.cache.getOrSet(
      CacheKeys.billing.effectivePlanLimits(organizationId),
      async () => {
        const [subscription, overrides] = await Promise.all([
          this.prisma.client.subscription.findUniqueOrThrow({ where: { organizationId }, select: { tier: true } }),
          this.prisma.client.organizationOverride.findMany({
            where: { organizationId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          }),
        ])

        const tier = planTierSchema.parse(subscription.tier)
        const base: PlanLimitsShape & { tier: PlanTier } = { ...PlanLimits[tier], tier }
        for (const o of overrides) {
          const field = overridableLimitFieldSchema.parse(o.field)
          base[field] = o.value as never   // Every OverridableLimitField is a number | null; validated on write
        }
        return base
      },
      CacheTTL.MEDIUM
    )
  }

  hasFeature(limits: PlanLimitsShape, feature: PlanFeature): boolean {
    return limits.features.includes(feature)
  }
}
```

---

## 2. Usage metering

Called **directly** by the inbound pipeline (`TDD_10` §4 step 6) — not from an event
listener — so the window is recorded in the same unit of work as the message.

```typescript
// libs/core/billing/usage-metering.service.ts
@Injectable()
export class UsageMeteringService {
  async recordBillableConversation(params: {
    organizationId: string
    storeId: string
    conversationId: string
    receivedAt: Date
  }): Promise<{ opened: boolean }> {
    const windowMs = BillingUnits.CONVERSATION_WINDOW_HOURS * 3600 * 1000

    // Serialize per conversation so two near-simultaneous messages cannot open two windows
    return this.prisma.client.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${params.conversationId}))`

      const open = await tx.billableConversation.findFirst({
        where: { conversationId: params.conversationId, windowEnd: { gt: params.receivedAt }, voidedAt: null },
        orderBy: { windowStart: 'desc' },
      })
      if (open) return { opened: false }        // Inside an open window: nothing to bill

      await tx.billableConversation.create({
        data: {
          organizationId: params.organizationId,
          storeId: params.storeId,
          conversationId: params.conversationId,
          windowStart: params.receivedAt,
          windowEnd: new Date(params.receivedAt.getTime() + windowMs),
        },
      })
      this.billable.inc({ store_id: params.storeId })   // MetricNames.BILLABLE_CONVERSATIONS
      return { opened: true }
    })
  }

  // Spam detected inside the window (TDD_12 §8): the store is not charged for it
  async voidWindow(conversationId: string): Promise<void> {
    await this.prisma.client.billableConversation.updateMany({
      where: { conversationId, windowEnd: { gt: new Date() }, voidedAt: null },
      data: { voidedAt: new Date() },
    })
  }

  async getCurrentPeriodUsage(organizationId: string): Promise<UsageSummary> {
    return this.cache.getOrSet(
      CacheKeys.billing.usage(organizationId),
      async () => {
        const subscription = await this.prisma.client.subscription.findUnique({ where: { organizationId } })
        if (!subscription) throw new PlatformException(ErrorCodes.SUBSCRIPTION_NOT_FOUND, 'No subscription', 404)

        const limits = await this.planLimits.resolve(organizationId)
        const storeIds = (await this.prisma.client.store.findMany({ where: { organizationId }, select: { id: true } })).map(s => s.id)

        const [conversations, activeSeats, pendingInvitations, channels] = await Promise.all([
          this.prisma.client.billableConversation.count({
            where: {
              organizationId,
              voidedAt: null,
              windowStart: { gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd },
            },
          }),
          // A seat is an ACTIVE membership (glossary): the same user in two stores uses two seats
          this.prisma.client.membership.count({ where: { organizationId, status: MembershipStatus.ACTIVE } }),
          this.prisma.client.invitation.count({ where: { organizationId, status: InvitationStatus.PENDING } }),
          // Connected channels across every store in the org — one org-wide count against maxChannels
          this.prisma.client.channelConnection.count({
            where: { storeId: { in: storeIds }, status: { not: ChannelConnectionStatus.DISCONNECTED } },
          }),
        ])

        const overage = isUnlimited(limits.includedConversations) ? 0 : Math.max(0, conversations - limits.includedConversations)

        return {
          tier: limits.tier,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          conversations: {
            used: conversations,
            included: limits.includedConversations,
            overage,
            overageCostCents: overage * limits.overagePerConversationCents,
            percentUsed: isUnlimited(limits.includedConversations) ? 0 : (conversations / limits.includedConversations) * 100,
          },
          seats: { used: activeSeats + pendingInvitations, included: limits.maxSeats },
          stores: { used: storeIds.length, included: limits.maxStores },
          channels: { used: channels, included: limits.maxChannels },
        }
      },
      CacheTTL.MEDIUM
    )
  }
}
```

The usage cache is invalidated by membership, invitation, store, channel and subscription
events (`TDD_08` §1.3); quota checks therefore see at most a few seconds of staleness, and
the free-tier hard cap is additionally enforced at write time (§3).

---

## 3. Quota enforcement

```typescript
export const QuotaTypes = {
  CONVERSATIONS: 'conversations',
  SEATS: 'seats',
  STORES: 'stores',
  CHANNELS: 'channels',
} as const
export type QuotaType = typeof QuotaTypes[keyof typeof QuotaTypes]

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly usage: UsageMeteringService,
    private readonly planLimits: EffectivePlanLimitsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const quotaType = this.reflector.get<QuotaType | undefined>(QUOTA_KEY, context.getHandler())
    if (!quotaType) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const organizationId = request.organization.id          // Set by TenantGuard (includes subscription)
    const [limits, usage] = await Promise.all([this.planLimits.resolve(organizationId), this.usage.getCurrentPeriodUsage(organizationId)])

    switch (quotaType) {
      case QuotaTypes.SEATS:
        if (!isUnlimited(limits.maxSeats) && usage.seats.used >= limits.maxSeats) {
          throw new PlatformException(ErrorCodes.QUOTA_SEATS_EXCEEDED, 'Seat limit reached', 402,
            { used: usage.seats.used, limit: limits.maxSeats, tier: limits.tier })
        }
        break

      case QuotaTypes.STORES:
        if (!isUnlimited(limits.maxStores) && usage.stores.used >= limits.maxStores) {
          throw new PlatformException(ErrorCodes.QUOTA_STORES_EXCEEDED, 'Store limit reached', 402,
            { used: usage.stores.used, limit: limits.maxStores, tier: limits.tier })
        }
        break

      // Count gate ("how many channels total"), distinct from ChannelGuard's identity gate
      // ("which channel", §6.5). Both guards apply on every connect attempt.
      case QuotaTypes.CHANNELS:
        if (!isUnlimited(limits.maxChannels) && usage.channels.used >= limits.maxChannels) {
          throw new PlatformException(ErrorCodes.QUOTA_CHANNELS_EXCEEDED, 'Channel limit reached', 402,
            { used: usage.channels.used, limit: limits.maxChannels })
        }
        break

      // Free tier hard cap. Applied to OUTBOUND replies (POST /messages) on conversations whose
      // current window is not yet billed: inbound messages are always stored (never lose
      // customer data), but the store cannot start/answer new conversations past the cap.
      // Paid tiers allow overage and bill for it.
      case QuotaTypes.CONVERSATIONS:
        if (limits.tier === PlanTiers.FREE && usage.conversations.used >= limits.includedConversations) {
          const conversationId = request.body?.conversationId
          if (!(await this.usage.hasOpenWindow(conversationId))) {
            throw new PlatformException(ErrorCodes.QUOTA_CONVERSATIONS_EXCEEDED, 'Conversation limit reached', 402,
              { used: usage.conversations.used, limit: limits.includedConversations })
          }
        }
        break
    }

    return true
  }
}
```

`AccessLevelGuard` (`TDD_01` §3.2) runs before `QuotaGuard` on every mutating route and
enforces `READ_ONLY` / `SUSPENDED` from dunning (§5) and read-only impersonation.

**Feature gating:**
```typescript
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly planLimits: EffectivePlanLimitsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.get<PlanFeature | undefined>(FEATURE_KEY, context.getHandler())
    if (!feature) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const limits = await this.planLimits.resolve(request.organization.id)

    if (!this.planLimits.hasFeature(limits, feature)) {
      throw new PlatformException(ErrorCodes.FEATURE_NOT_IN_PLAN, 'Feature not available on this plan', 402,
        { feature, currentTier: limits.tier })
    }
    return true
  }
}

// Usage
@Post(ApiRoutes.analytics.reports)
@RequireFeature(PlanFeatures.SCHEDULED_REPORTS)
async createScheduledReport() { }
```

**Proactive warnings** (`Schedules.CHECK_QUOTA_LIMITS`, worker):
```typescript
@Cron(Schedules.CHECK_QUOTA_LIMITS)
async warnApproachingLimits(): Promise<void> {
  await this.locks.withLock(LockNames.CHECK_QUOTA_LIMITS, 3600, async () => {
    const subscriptions = await this.prisma.client.subscription.findMany({
      where: { status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] } },
      select: { id: true, organizationId: true, currentPeriodStart: true },
    })

    for (const sub of subscriptions) {
      const usage = await this.usage.getCurrentPeriodUsage(sub.organizationId)
      if (isUnlimited(usage.conversations.included)) continue

      for (const threshold of QuotaWarningThresholds) {           // [80, 90, 100]
        const key = CacheKeys.billing.quotaWarned(sub.id, sub.currentPeriodStart.toISOString(), threshold)
        if (usage.conversations.percentUsed < threshold || (await this.cache.get<boolean>(key))) continue

        await this.notifications.sendToOrganization({
          organizationId: sub.organizationId,
          type: NotificationTypes.QUOTA_WARNING,
          params: { threshold, used: usage.conversations.used, included: usage.conversations.included },
          actionPath: AppPaths.org.billing,
          requiredPermission: Permissions.ORG_VIEW_BILLING,
        })
        await this.cache.set(key, true, CacheTTL.VERY_LONG * 35)   // Outlives the period
      }
    }
  })
}
```

---

## 4. Stripe integration

Stripe API version is whatever `stripe@22.6.1` pins by default — never overridden. The
account's webhook endpoint is created with the same version. Price ids are configuration
(`STRIPE_PRICE_IDS_JSON`, parsed once by `StripePriceConfig`), never literals.

### 4.1 Checkout

```typescript
@Injectable()
export class StripeService {
  private readonly stripe: Stripe

  constructor(private readonly prisma: PrismaService, private readonly prices: StripePriceConfig) {
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required when FEATURE_BILLING_ENABLED')
    this.stripe = new Stripe(env.STRIPE_SECRET_KEY)
  }

  // Creates the Stripe customer lazily and PERSISTS it before anything else, so a retry
  // never creates a second customer.
  async ensureCustomer(organizationId: string): Promise<string> {
    const org = await this.prisma.client.organization.findUniqueOrThrow({ where: { id: organizationId } })
    if (org.stripeCustomerId) return org.stripeCustomerId

    const customer = await this.stripe.customers.create(
      { name: org.name, email: org.billingEmail ?? undefined, metadata: { organizationId: org.id } },
      { idempotencyKey: `customer:${org.id}` }
    )
    await this.prisma.client.organization.update({ where: { id: org.id }, data: { stripeCustomerId: customer.id } })
    return customer.id
  }

  async createCheckoutSession(params: {
    organizationId: string
    tier: Exclude<PlanTier, 'free' | 'enterprise'>
    interval: BillingInterval
    successUrl: string
    cancelUrl: string
  }): Promise<{ url: string }> {
    const customerId = await this.ensureCustomer(params.organizationId)
    const subscription = await this.prisma.client.subscription.findUniqueOrThrow({ where: { organizationId: params.organizationId } })
    const price = this.prices.for(params.tier, params.interval)          // { recurring, overageMeterPrice }

    const session = await this.stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        { price: price.recurring, quantity: 1 },
        { price: price.overageMeterPrice },                              // Metered (Billing Meter) item, no quantity
      ],
      subscription_data: {
        trial_period_days: subscription.stripeSubscriptionId ? undefined : TRIAL_DAYS,
        metadata: { organizationId: params.organizationId, tier: params.tier },
      },
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
    })

    if (!session.url) throw new PlatformException(ErrorCodes.EXTERNAL_SERVICE_ERROR, 'Stripe returned no checkout URL', 502)
    return { url: session.url }
  }

  // Stripe's hosted portal handles payment methods, invoices, plan changes
  // and cancellation. Building that UI ourselves would be wasted effort.
  async createPortalSession(organizationId: string, returnUrl: string): Promise<{ url: string }> {
    const customerId = await this.ensureCustomer(organizationId)
    const session = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })
    return { url: session.url }
  }
}
```

### 4.2 Webhook handling

```typescript
@Controller()
export class StripeWebhookController {
  @Post(ApiRoutes.webhooks.stripe)
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    if (!req.rawBody || !env.STRIPE_WEBHOOK_SECRET) {
      throw new PlatformException(ErrorCodes.AUTH_UNAUTHORIZED, 'Webhook not configured', 401)
    }

    let event: Stripe.Event
    try {
      event = this.stripe.webhooks.constructEvent(req.rawBody, signature, env.STRIPE_WEBHOOK_SECRET)
    } catch {
      throw new PlatformException(ErrorCodes.AUTH_UNAUTHORIZED, 'Invalid signature', 400)
    }

    // Idempotency — Stripe retries. The marker is committed together with the handler's
    // writes; a thrown handler rolls it back so the retry is processed (TDD_07 §5.4).
    await this.processedEvents.runOnce(WebhookSources.STRIPE, event.id, event.type, async tx => {
      switch (event.type) {
        case StripeEventTypes.SUBSCRIPTION_CREATED:
        case StripeEventTypes.SUBSCRIPTION_UPDATED:
          await this.subscriptions.syncFromStripe(tx, event.data.object)
          break

        case StripeEventTypes.SUBSCRIPTION_DELETED:
          await this.subscriptions.handleCancellation(tx, event.data.object)
          break

        case StripeEventTypes.INVOICE_PAID: {
          const invoice = event.data.object
          const record = await this.invoices.record(tx, invoice)             // Our Invoice row + the Subscription it belongs to
          this.deferredEvents.push(Events.INVOICE_PAID, {
            organizationId: record.subscription.organizationId,
            tier: planTierSchema.parse(record.subscription.tier),
            invoiceId: record.invoice.id,
            stripeInvoiceId: invoice.id,
            amountPaidCents: invoice.amount_paid,
            billingReason: invoice.billing_reason ?? StripeBillingReasons.MANUAL,
            periodStart: record.invoice.periodStart.toISOString(),
            periodEnd: record.invoice.periodEnd.toISOString(),
          } satisfies InvoicePaidPayload)
          break
        }

        case StripeEventTypes.INVOICE_PAYMENT_FAILED:
          await this.dunning.handlePaymentFailure(tx, event.data.object)     // status PAST_DUE, pastDueSince
          break

        case StripeEventTypes.SUBSCRIPTION_TRIAL_WILL_END:
          await this.subscriptions.notifyTrialEnding(tx, event.data.object)
          break
      }
    })
    this.deferredEvents.flush()      // Emitted after the transaction committed (TDD_01 §6)

    return { received: true }
  }
}
```

`StripeEventTypes` (`libs/core/billing/stripe-constants.ts`) holds the event-type strings.
Invoice line/period access follows the Basil invoice shape (`invoice.parent.subscription_details`,
`lines.data[].period`) — verified against the SDK types at implementation time.

**Sync on subscription change:** `syncFromStripe` copies `tier`, `interval`, `status`,
`currentPeriodStart/End`, `trialEndsAt`, `cancelAtPeriodEnd`, `stripeSubscriptionId` and
the metered item id onto `Subscription`, emits `SUBSCRIPTION_UPDATED` (which invalidates
effective limits and usage caches) and, on a tier change, resets AI credits (`TDD_12` §9.5).

### 4.3 Usage reporting (Billing Meters)

Stripe removed usage records in API version 2025-03-31; overage is reported as **meter
events**. Meter events are additive, so the daily job reports the **delta** since the last
report, keyed by an idempotent identifier.

```typescript
@Cron(Schedules.REPORT_STRIPE_USAGE)
async reportUsageToStripe(): Promise<void> {
  await this.locks.withLock(LockNames.REPORT_STRIPE_USAGE, 3600, async () => {
    const subscriptions = await this.prisma.client.subscription.findMany({
      where: {
        status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE] },   // Not TRIALING: no overage during trial
        tier: { notIn: [PlanTiers.FREE, PlanTiers.ENTERPRISE] },
        stripeSubscriptionId: { not: null },
      },
    })

    for (const sub of subscriptions) {
      const usage = await this.usage.getCurrentPeriodUsage(sub.organizationId)
      const reported = await this.usageRecords.reportedOverage(sub.id, sub.currentPeriodStart)   // Sum of UsageRecord.quantity this period
      const delta = usage.conversations.overage - reported
      if (delta <= 0) continue

      const customerId = await this.stripeService.ensureCustomer(sub.organizationId)
      const identifier = `${sub.id}:${sub.currentPeriodStart.toISOString()}:${reported + delta}`
      await this.stripe.billing.meterEvents.create({
        event_name: StripeMeters.CONVERSATION_OVERAGE,
        identifier,                                              // Stripe dedupes on this
        payload: { stripe_customer_id: customerId, value: String(delta) },
        timestamp: Math.floor(Date.now() / 1000),
      })

      await this.usageRecords.record({
        subscriptionId: sub.id, organizationId: sub.organizationId,
        metric: UsageMetrics.CONVERSATION_OVERAGE, quantity: delta,
        periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, reportedToStripe: true,
      })
      await this.prisma.client.subscription.update({ where: { id: sub.id }, data: { lastUsageReportedAt: new Date() } })
    }
  })
}
```

---

## 5. Dunning

`AccessLevel` is the enum in `TDD_02` §5; `Organization.accessLevel` holds it and
`AccessLevelGuard` enforces it on every mutating request.

```typescript
export const DunningActions = { EMAIL: 'email', EMAIL_BANNER: 'email_banner', RESTRICT: 'restrict_access', SUSPEND: 'suspend', CANCEL: 'cancel' } as const

export const DunningSchedule = [
  { dayOffset: 0,  action: DunningActions.EMAIL,        template: EmailTemplates.PAYMENT_FAILED_1 },
  { dayOffset: 3,  action: DunningActions.EMAIL,        template: EmailTemplates.PAYMENT_FAILED_2 },
  { dayOffset: 7,  action: DunningActions.EMAIL_BANNER, template: EmailTemplates.PAYMENT_FAILED_3 },
  { dayOffset: 10, action: DunningActions.RESTRICT,     template: EmailTemplates.ACCOUNT_RESTRICTED },
  { dayOffset: 14, action: DunningActions.SUSPEND,      template: EmailTemplates.ACCOUNT_SUSPENDED },
  { dayOffset: 30, action: DunningActions.CANCEL,       template: EmailTemplates.ACCOUNT_SUSPENDED },
] as const
```

```typescript
@Cron(Schedules.PROCESS_DUNNING)
async processDunning(): Promise<void> {
  await this.locks.withLock(LockNames.PROCESS_DUNNING, 3600, async () => {
    const pastDue = await this.prisma.client.subscription.findMany({
      where: { status: SubscriptionStatus.PAST_DUE, pastDueSince: { not: null } },
      include: { organization: true },
    })

    for (const sub of pastDue) {
      if (!sub.pastDueSince) continue
      const days = differenceInDays(new Date(), sub.pastDueSince)

      // Every step whose day has passed and that has not run yet — a missed cron day never
      // skips a step, it catches up.
      const due = DunningSchedule.filter(s => s.dayOffset <= days && !sub.dunningStepsCompleted.includes(s.dayOffset))

      for (const step of due) {
        switch (step.action) {
          case DunningActions.RESTRICT:
            // Read-only: agents can view history but cannot send messages or create orders.
            await this.organizations.setAccessLevel(sub.organizationId, AccessLevel.READ_ONLY, DunningActions.RESTRICT)
            break
          case DunningActions.SUSPEND:
            await this.organizations.setAccessLevel(sub.organizationId, AccessLevel.SUSPENDED, DunningActions.SUSPEND)
            break
          case DunningActions.CANCEL:
            if (sub.stripeSubscriptionId) await this.stripe.subscriptions.cancel(sub.stripeSubscriptionId)
            await this.compliance.scheduleOrganizationPurge(sub.organizationId, ComplianceConfig.ERASURE_GRACE_PERIOD_DAYS)
            break
          default:
            break   // EMAIL / EMAIL_BANNER: the email below and the past-due banner (§6)
        }

        await this.billingEmails.sendToBillingContacts(sub.organizationId, {
          template: step.template,
          data: { organizationName: sub.organization.name, daysPastDue: days, updatePaymentUrl: await this.portalUrl(sub.organizationId) },
        })

        await this.prisma.client.subscription.update({
          where: { id: sub.id },
          data: { dunningStepsCompleted: { push: step.dayOffset } },
        })
      }
    }
  })
}
```

`sendToBillingContacts` emails every member with `ORG_MANAGE_BILLING` in their own locale,
plus `Organization.billingEmail` when set. A successful payment (`INVOICE_PAID` with
`PAST_DUE` status) resets `pastDueSince`, `dunningStepsCompleted` and the access level to
`FULL`.

**Principle:** never delete data during dunning. Restrict, then suspend, then
cancel — with a 30-day grace period before any purge. A customer who returns
after a billing problem finds their history intact.

---

## 6. Billing UI

```
Organization → Billing   (/org/billing)

┌────────────────────────────────────────────────────────────────────┐
│ Current plan                                                       │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ GROWTH                                          $89 / month    │ │
│ │ Renews Sep 14, 2026                                            │ │
│ │                          [Change plan]  [Cancel subscription]  │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ Usage this period (Aug 14 – Sep 14)                                │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ Conversations                                                  │ │
│ │ ████████████████████████░░░░░░░░  3,847 / 5,000  (77%)        │ │
│ │ Overage rate after limit: $0.02 per conversation               │ │
│ │                                                                │ │
│ │ Team seats                                                     │ │
│ │ ██████████░░░░░░░░░░░░░░░░░░░░░░  6 / 15  (40%)               │ │
│ │                                                                │ │
│ │ Stores                                                         │ │
│ │ ██████████████████████░░░░░░░░░░  2 / 3  (67%)                │ │
│ │                                                                │ │
│ │ Channels                                                       │ │
│ │ ████████████░░░░░░░░░░░░░░░░░░░░  4 / 10  (40%)               │ │
│ │                                                                │ │
│ │ AI credits (Chispas)                                           │ │
│ │ ████████████████████░░░░░░░░░░░░  1,847 / 3,000               │ │
│ │                                                                │ │
│ │ Estimated next invoice: $89.00                                 │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│ Payment method                                                     │
│ Visa ending 4242 · Expires 12/2027          [Manage in Stripe]     │
│                                                                    │
│ Invoices                                                           │
│ Aug 14, 2026   INV-0042   $89.00   Paid    [PDF] [View]            │
│ Jul 14, 2026   INV-0038   $94.60   Paid    [PDF] [View]            │
└────────────────────────────────────────────────────────────────────┘
```

All numbers come from `GET /billing/usage` (which returns the **effective** limits) —
never from `PlanLimits` in the client. The **past due banner** appears at the top of
every page while `status = past_due`; the **read-only banner** while `accessLevel = read_only`.

---

## 6.5 Plan comparison

Every plan-gated screen (billing, upgrade prompts, onboarding) renders the same comparison,
sourced from `GET /billing/plans` (which serializes `PlanLimits` and `AvailableChannels`) —
**never hand-write a second copy of these numbers in a marketing page or a component.**

| | Free | Micro | Starter | Growth | Scale |
|---|---|---|---|---|---|
| Price/mo | $0 | $12 | $29 | $89 | $249 |
| Conversations incl. | 100 | 400 | 1,000 | 5,000 | 20,000 |
| Overage/conversation | — (hard cap) | $0.04 | $0.03 | $0.02 | $0.015 |
| Stores | 1 | 1 | 1 | 3 | 10 |
| Seats | 2 | 3 | 5 | 15 | 50 |
| Channels | Web widget | + Email | + Instagram **or** Messenger | + both, + WhatsApp | + all, + marketplace |
| History retention | 30d | 180d | 365d | 730d | 1095d |
| Routing / webhooks / tags / snippets / API keys | — | — | ✓ | ✓ | ✓ |
| Business hours, scheduled reports, custom roles | — | — | — | ✓ | ✓ |
| Third-party plugins | — | — | — | ✓ | ✓ |
| AI assist — suggested replies, tagging, sentiment, summary, spam | — | — | — | ✓ (3,000 Chispas/mo) | ✓ (9,000 Chispas/mo) |
| AI — autonomous chatbot | — | — | — | — | ✓ |
| SSO, audit log export, SLA rules | — | — | — | — | ✓ |
| Support | Community | Community | Standard | Priority | Priority |

**Compare plans screen:**
```
Organization → Billing → [Compare all plans]

┌────────┬────────┬──────────┬──────────┬──────────┐
│  FREE  │ MICRO  │ STARTER  │  GROWTH  │  SCALE   │
│   $0   │  $12   │   $29    │   $89    │   $249   │
├────────┼────────┼──────────┼──────────┼──────────┤
│ 100    │ 400    │ 1,000    │ 5,000    │ 20,000   │
│ conv.  │ conv.  │ conv.    │ conv.    │ conv.    │
├────────┼────────┼──────────┼──────────┼──────────┤
│ Web    │ +Email │ +IG or   │ +IG      │ +all     │
│ widget │        │ Messenger│ +Messenger│ channels │
│        │        │          │ +WhatsApp│ +marketplace│
├────────┼────────┼──────────┼──────────┼──────────┤
│   —    │   —    │    —     │ AI assist│ AI assist│
│        │        │          │ 3,000    │ + chatbot│
│        │        │          │ chispas  │ 9,000    │
├────────┴────────┴──────────┴──────────┴──────────┤
│         [Current: Growth]      [Upgrade to Scale] │
└────────────────────────────────────────────────────┘
```

(The AI column uses the `Sparkles` Lucide icon in the real UI, never an emoji.)

Your current plan is highlighted. Every other column shows [Upgrade] or [Downgrade] —
downgrade requires confirming which data will be dropped: conversations older than the
target tier's `historyRetentionDays` are deleted by the next retention run (`TDD_05` §10.4),
excess channels must be disconnected first, and excess seats revoked.

**Channel gating enforcement** mirrors `FeatureGuard` (§3). The channel is the `:pluginId`
route parameter, so the guard reads it from the request rather than from a static decorator:

```typescript
@Injectable()
export class ChannelGuard implements CanActivate {
  constructor(private readonly planLimits: EffectivePlanLimitsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const channelId = channelTypeSchema.parse(request.params['pluginId'])
    const limits = await this.planLimits.resolve(request.organization.id)
    const allowed = AvailableChannels[limits.tier]

    const unlocked = allowed.included.includes(channelId) ||
      (allowed.chooseOneOf?.includes(channelId) === true && request.store.activeSocialChannel === channelId)

    if (!unlocked) {
      throw new PlatformException(ErrorCodes.CHANNEL_NOT_IN_PLAN, 'Channel not available on this plan', 402,
        { channelId, currentTier: limits.tier })
    }
    return true
  }
}

// Usage — connect-time check, not per-message (once connected, a channel keeps working
// through its billing period even if the org later downgrades mid-cycle; enforcement
// re-applies on the next renewal). Both guards run: ChannelGuard checks WHICH channel
// (identity), RequireQuota(CHANNELS) checks HOW MANY are already connected org-wide.
@Post(ApiRoutes.channels.connect(':pluginId'))
@UseGuards(AuthGuard, TenantGuard, AccessLevelGuard, PermissionGuard, ChannelGuard, QuotaGuard)
@RequirePermissions(Permissions.SETTINGS_MANAGE_PLUGINS)
@RequireQuota(QuotaTypes.CHANNELS)
async connectChannel() { }
```

`Store.activeSocialChannel` is set when a Starter store picks Instagram or Messenger during
onboarding, and can be changed (not doubled) from Settings → Channels without an upgrade
(changing it disconnects the other one first).

---

## 7. Analytics & reporting

### 7.1 Constants

```typescript
// libs/core/analytics/analytics-constants.ts
export const AnalyticsMetrics = {
  // Volume
  CONVERSATIONS_CREATED: 'conversations.created',
  CONVERSATIONS_RESOLVED: 'conversations.resolved',
  MESSAGES_RECEIVED: 'messages.received',
  MESSAGES_SENT: 'messages.sent',

  // Performance
  FIRST_RESPONSE_TIME: 'response.first_time',
  AVERAGE_RESPONSE_TIME: 'response.average_time',
  RESOLUTION_TIME: 'resolution.time',
  CONVERSATIONS_PER_AGENT: 'agent.conversations',

  // Commerce
  ORDERS_CREATED: 'orders.created',
  ORDERS_REVENUE: 'orders.revenue',
  ORDERS_AVERAGE_VALUE: 'orders.average_value',
  CONVERSION_RATE: 'orders.conversion_rate',

  // Quality
  CSAT_SCORE: 'quality.csat',
  REOPEN_RATE: 'quality.reopen_rate',
  SLA_COMPLIANCE: 'quality.sla_compliance',

  // Channels
  CHANNEL_VOLUME: 'channel.volume',
  CHANNEL_RESPONSE_TIME: 'channel.response_time',

  // AI
  AI_SUGGESTION_ACCEPTANCE: 'ai.suggestion_acceptance',
  AI_HANDOFF_RATE: 'ai.handoff_rate',
} as const
export type AnalyticsMetric = typeof AnalyticsMetrics[keyof typeof AnalyticsMetrics]

// Raw events written to analytics_events by TRACK_EVENT jobs
export const AnalyticsEventNames = {
  SEARCH_PERFORMED: 'search.performed',
  EMAIL_ENGAGEMENT: 'email.engagement',
  ORDER_CREATED: 'order.created',
  AI_SUGGESTION_SHOWN: 'ai.suggestion_shown',
  AI_SUGGESTION_ACCEPTED: 'ai.suggestion_accepted',
} as const
export type AnalyticsEventName = typeof AnalyticsEventNames[keyof typeof AnalyticsEventNames]

export const MetricDimensions = { NONE: '', CHANNEL: 'channel', AGENT: 'agent' } as const

export const TimeGranularity = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month' } as const
export type TimeGranularityType = typeof TimeGranularity[keyof typeof TimeGranularity]

export const DateRangePresets = {
  TODAY: 'today', YESTERDAY: 'yesterday',
  LAST_7_DAYS: 'last_7_days', LAST_30_DAYS: 'last_30_days',
  LAST_90_DAYS: 'last_90_days',
  THIS_MONTH: 'this_month', LAST_MONTH: 'last_month',
  CUSTOM: 'custom'
} as const
```

### 7.2 Rollup pipeline

Analytics never queries raw tables at read time. See `TDD_08_Performance.md` §6. Each
hourly run recomputes the previous **two** hours so late webhooks are absorbed; the daily
run recomputes the previous two days.

```typescript
@Cron(Schedules.ROLLUP_HOURLY)
async scheduleHourlyRollups(): Promise<void> {
  await this.locks.withLock(LockNames.ROLLUP_HOURLY, 300, async () => {
    const stores = await this.prisma.client.store.findMany({ select: { id: true } })
    const hours = [subHours(startOfHour(new Date()), 1), subHours(startOfHour(new Date()), 2)]

    await this.analyticsQueue.addBulk(stores.flatMap(store => hours.map(hourStart => ({
      name: JobNames.ROLLUP_HOURLY,
      data: { storeId: store.id, periodStart: hourStart.toISOString(), periodEnd: endOfHour(hourStart).toISOString() } satisfies RollupJob,
      opts: { jobId: `rollup-hourly:${store.id}:${hourStart.toISOString()}` },
    }))))
  })
}
```

```typescript
// Worker: computes every metric for one store, one hour
async processHourlyRollup(job: Job<RollupJob>): Promise<void> {
  const { storeId, periodStart, periodEnd } = job.data
  const hour = new Date(periodStart)

  const [created, resolved, firstResponse, byChannel, orders] = await Promise.all([
    this.queries.countConversationsCreated(storeId, periodStart, periodEnd),
    this.queries.countConversationsResolved(storeId, periodStart, periodEnd),
    this.queries.medianFirstResponseSeconds(storeId, periodStart, periodEnd),
    this.queries.volumeByChannel(storeId, periodStart, periodEnd),
    this.queries.orderTotals(storeId, periodStart, periodEnd),
  ])

  await this.prisma.client.$transaction([
    this.upsertHourly(storeId, hour, AnalyticsMetrics.CONVERSATIONS_CREATED, created),
    this.upsertHourly(storeId, hour, AnalyticsMetrics.CONVERSATIONS_RESOLVED, resolved),
    this.upsertHourly(storeId, hour, AnalyticsMetrics.FIRST_RESPONSE_TIME, firstResponse.median, firstResponse.count),
    this.upsertHourly(storeId, hour, AnalyticsMetrics.ORDERS_CREATED, orders.count),
    this.upsertHourly(storeId, hour, AnalyticsMetrics.ORDERS_REVENUE, orders.totalCents / 100),
    ...byChannel.map(c =>
      this.upsertHourly(storeId, hour, AnalyticsMetrics.CHANNEL_VOLUME, c.count, c.count, MetricDimensions.CHANNEL, c.channelType)
    ),
  ])
}

// dimension/dimensionId default to '' so the unique constraint works with upsert (TDD_01 §4)
private upsertHourly(storeId: string, hour: Date, metric: AnalyticsMetric, value: number, count = 1, dimension = MetricDimensions.NONE, dimensionId = '') {
  return this.prisma.client.metricHourly.upsert({
    where: { storeId_hour_metric_dimension_dimensionId: { storeId, hour, metric, dimension, dimensionId } },
    create: { storeId, hour, metric, dimension, dimensionId, value, count },
    update: { value, count },
  })
}
```

**Median first response time query** (mapped names, `TDD_01` §4):
```sql
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (c.first_response_at - c.created_at))) AS median_seconds,
       COUNT(*)::int AS count
FROM conversations c
WHERE c.store_id = $1
  AND c.first_response_at IS NOT NULL
  AND c.created_at >= $2 AND c.created_at < $3
```

`Conversation.firstResponseAt` is set by the messages service on the first agent or AI
reply, so the rollup never scans `messages`.

### 7.3 Dashboard

```
┌──────────────────────────────────────────────────────────────────────┐
│ Analytics        [Last 30 days ▼]  [All channels ▼]  [Export ▼]      │
├──────────────────────────────────────────────────────────────────────┤
│ ┌──────────────┬──────────────┬──────────────┬──────────────┐        │
│ │ Conversations│ Avg response │ Resolution   │ Revenue      │        │
│ │    1,247     │   3m 42s     │   2h 18m     │  $12,450     │        │
│ │  +12.3%      │  -18.5%      │  -5.2%       │  +24.1%      │        │
│ └──────────────┴──────────────┴──────────────┴──────────────┘        │
│                                                                      │
│ Conversation volume by channel                                       │
│ [stacked area chart, daily granularity]                              │
│                                                                      │
│ ┌──────────────────────────┬─────────────────────────────────┐       │
│ │ Agent performance        │ Channel breakdown               │       │
│ │ Agent    Resolved  Avg   │ WhatsApp   62%                  │       │
│ │ María      342    2m 15s │ Instagram  28%                  │       │
│ │ Carlos     298    3m 48s │ Messenger  10%                  │       │
│ └──────────────────────────┴─────────────────────────────────┘       │
│                                                                      │
│ Peak hours heatmap  (drives staffing decisions)                      │
│ [7x24 grid, intensity by conversation volume]                        │
└──────────────────────────────────────────────────────────────────────┘
```

Export requires `ANALYTICS_EXPORT` and goes through `Export { type: ANALYTICS }`.

### 7.4 Scheduled reports

```typescript
export const ReportFrequency = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' } as const
export const ReportFormats = { PDF: 'pdf', CSV: 'csv', EXCEL: 'excel' } as const
```

```typescript
@Cron(Schedules.DISPATCH_REPORTS)      // Hourly
async dispatchScheduledReports(): Promise<void> {
  await this.locks.withLock(LockNames.DISPATCH_REPORTS, 3000, async () => {
    const reports = await this.prisma.client.scheduledReport.findMany({ where: { enabled: true } })

    for (const report of reports) {
      const localNow = toZonedTime(new Date(), report.timezone)      // date-fns-tz v3

      if (localNow.getHours() !== report.sendAtHour) continue
      if (!isDueToday(report, localNow)) continue
      if (alreadySentToday(report, localNow)) continue

      await this.exportsQueue.add(JobNames.GENERATE_SCHEDULED_REPORT, { reportId: report.id },
        { jobId: `report:${report.id}:${formatDate(localNow, 'yyyy-MM-dd')}` })
    }
  })
}
```

Reports are generated from rollup tables, rendered to PDF (`@react-pdf/renderer`) or
CSV/Excel, stored as an `Export`, and emailed (`EmailTemplates.SCHEDULED_REPORT`) with an
inline summary and a download link.

### 7.5 Data warehouse path (MATURE)

```
PostgreSQL (OLTP)
  ↓ CDC or nightly batch export
BigQuery / ClickHouse (OLAP)
  ↓ dbt transformations
Metabase (internal analysis only)
```

Customer-facing dashboards continue reading Postgres rollups for low latency.
The warehouse serves internal analysis and long-horizon reporting only (`TDD_15` §10).

---

## 8. Referral & affiliate program

### 8.1 Design

```typescript
// libs/core/referrals/referral-constants.ts
export const ReferralProgramTypes = {
  CUSTOMER_REFERRAL: 'customer_referral',   // Existing customer refers another
  AFFILIATE: 'affiliate',                   // Creator or agency partner
  AGENCY_PARTNER: 'agency_partner',
} as const

export const ReferralStatus = {
  PENDING: 'pending',       // Signed up, not yet paid
  QUALIFIED: 'qualified',   // Converted, in holding period
  APPROVED: 'approved',     // Holding period passed, reward earned
  PAID: 'paid',
  REJECTED: 'rejected',     // Fraud, self-referral or churn during holding
  EXPIRED: 'expired',
} as const

export const PartnerStatus = { PENDING: 'pending', ACTIVE: 'active', SUSPENDED: 'suspended' } as const
export const CommissionStatus = { PENDING: 'pending', PAID: 'paid', VOIDED: 'voided' } as const
export const PayoutStatus = { PENDING: 'pending', PROCESSING: 'processing', PAID: 'paid', FAILED: 'failed' } as const

export const ReferralConfig = {
  COOKIE_ATTRIBUTION_DAYS: 90,
  ATTRIBUTION_MODEL: 'last_touch',
  FRAUD_AUTO_REJECT_SCORE: 70,
  REFERRAL_COOKIE: 'platform_ref',
  VISITOR_COOKIE: 'platform_vid',
} as const
```

Reward amounts, commission percentages, holding periods and minimum payouts are **rows in
`ReferralProgram`** (`TDD_01` §4), not constants — a new program or a changed rate never
needs a deploy.

### 8.2 Attribution

```typescript
// apps/web/proxy.ts — capture on landing (Next 16 proxy convention; runs on the Node runtime)
import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server'
import { ReferralConfig } from '@platform/core-domain/referrals'
import { ApiRoutes } from '@platform/core-domain/api'
import { webEnv } from './lib/env'

export function proxy(request: NextRequest, event: NextFetchEvent): NextResponse {
  const code = request.nextUrl.searchParams.get('ref')
  if (!code) return NextResponse.next()

  const response = NextResponse.next()
  const secure = request.nextUrl.protocol === 'https:'   // false on localhost

  let visitorId = request.cookies.get(ReferralConfig.VISITOR_COOKIE)?.value
  if (!visitorId) {
    visitorId = crypto.randomUUID()
    response.cookies.set(ReferralConfig.VISITOR_COOKIE, visitorId, { maxAge: 60 * 60 * 24 * 365, httpOnly: true, sameSite: 'lax', secure })
  }

  response.cookies.set(ReferralConfig.REFERRAL_COOKIE, code, {
    maxAge: 60 * 60 * 24 * ReferralConfig.COOKIE_ATTRIBUTION_DAYS, httpOnly: true, sameSite: 'lax', secure,
  })

  // Fire and forget, but kept alive until it completes
  event.waitUntil(
    fetch(`${webEnv.NEXT_PUBLIC_API_URL}${ApiRoutes.referrals.trackClick}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code, visitorId,
        referrerUrl: request.headers.get('referer'),
        landingPath: request.nextUrl.pathname,
        utmSource: request.nextUrl.searchParams.get('utm_source'),
        utmMedium: request.nextUrl.searchParams.get('utm_medium'),
        utmCampaign: request.nextUrl.searchParams.get('utm_campaign'),
      }),
    }).catch(() => undefined)
  )

  return response
}

export const config = { matcher: ['/((?!_next|api|icons|sw.js).*)'] }
```

`POST /referrals/track-click` is public, rate-limited by IP, hashes the IP and stores a
`ReferralClick`. **At signup**, the signup handler reads the `platform_ref` / `platform_vid`
cookies, and if the code resolves to an active partner creates the `Referral { status: PENDING }`
with `attributedVisitorId`, `attributedClickId` (last click for that visitor) and
`signupIpHash`, then runs `ReferralFraudService.score` (§8.4). A score above
`FRAUD_AUTO_REJECT_SCORE` sets `REJECTED` with the signals recorded; staff can override
in the console.

### 8.3 Commission lifecycle

```typescript
@OnEvent(Events.INVOICE_PAID)
async calculateCommission(payload: InvoicePaidPayload): Promise<void> {
  if (payload.amountPaidCents <= 0) return             // $0 trial/proration invoices never qualify

  const referral = await this.prisma.client.referral.findUnique({
    where: { referredOrgId: payload.organizationId },
    include: { partner: { include: { program: true } } },
  })
  if (!referral || referral.status === ReferralStatus.REJECTED || referral.status === ReferralStatus.EXPIRED) return

  const program = referral.partner.program

  // First real payment qualifies the referral and starts the holding period
  if (referral.status === ReferralStatus.PENDING) {
    await this.prisma.client.referral.update({
      where: { id: referral.id },
      data: {
        status: ReferralStatus.QUALIFIED,
        convertedAt: new Date(),
        holdingEndsAt: addDays(new Date(), program.holdingPeriodDays),
        commissionPercent: program.commissionPercent,
        commissionMonthsRemaining: program.commissionMonths,
      },
    })
  }

  // Affiliates earn a recurring share for a fixed number of months
  if (program.type === ReferralProgramTypes.AFFILIATE && (referral.commissionMonthsRemaining ?? 0) > 0 && referral.commissionPercent) {
    // Unique on (referralId, invoiceId) — safe against webhook retries
    await this.prisma.client.$transaction([
      this.prisma.client.commission.create({
        data: {
          referralId: referral.id,
          partnerId: referral.partnerId,
          invoiceId: payload.invoiceId,
          amountCents: Math.round(payload.amountPaidCents * (Number(referral.commissionPercent) / 100)),
          periodStart: new Date(payload.periodStart),
          periodEnd: new Date(payload.periodEnd),
        },
      }),
      this.prisma.client.referral.update({ where: { id: referral.id }, data: { commissionMonthsRemaining: { decrement: 1 } } }),
    ])
  }
}
```

```typescript
@Cron(Schedules.APPROVE_REFERRALS)
async approveQualified(): Promise<void> {
  await this.locks.withLock(LockNames.APPROVE_REFERRALS, 3600, async () => {
    const ready = await this.prisma.client.referral.findMany({
      where: { status: ReferralStatus.QUALIFIED, holdingEndsAt: { lte: new Date() } },
      include: { partner: { include: { program: true } } },
    })

    for (const referral of ready) {
      // Re-verify: still subscribed, no chargeback
      if (!(await this.stillActive(referral.referredOrgId))) {
        await this.reject(referral.id, ReferralRejectionReasons.CANCELED_DURING_HOLDING)
        continue
      }

      await this.prisma.client.referral.update({ where: { id: referral.id }, data: { status: ReferralStatus.APPROVED, approvedAt: new Date() } })

      const program = referral.partner.program
      // Two-sided credit for customer referrals — Stripe customer balance credits
      if (program.type === ReferralProgramTypes.CUSTOMER_REFERRAL && referral.partner.organizationId) {
        await Promise.all([
          this.stripeService.applyCustomerBalanceCredit(referral.partner.organizationId, program.referrerCreditCents, `referral:${referral.id}:referrer`),
          this.stripeService.applyCustomerBalanceCredit(referral.referredOrgId, program.refereeCreditCents, `referral:${referral.id}:referee`),
        ])
      }

      if (referral.partner.userId) {
        await this.notifications.sendToOrganization({
          organizationId: referral.partner.organizationId ?? referral.referredOrgId,
          type: NotificationTypes.REFERRAL_REWARD_EARNED,
          params: { referredOrgName: await this.orgs.nameOf(referral.referredOrgId) },
          actionPath: AppPaths.org.referrals,
          requiredPermission: Permissions.ORG_VIEW_BILLING,
        })
      }
    }
  })
}
```

`applyCustomerBalanceCredit` uses `stripe.customers.createBalanceTransaction` with the
idempotency key shown, so an approval retried after a crash never double-credits.

### 8.4 Fraud scoring

```typescript
@Injectable()
export class ReferralFraudService {
  async score(params: { partnerId: string; organizationId: string; visitorId: string | null; signupIpHash: string }): Promise<{ score: number; signals: string[] }> {
    let score = 0
    const signals: string[] = []

    const [partner, org] = await Promise.all([
      this.prisma.client.partner.findUniqueOrThrow({ where: { id: params.partnerId } }),
      this.prisma.client.organization.findUniqueOrThrow({
        where: { id: params.organizationId },
        include: { memberships: { include: { user: { select: { email: true } } } } },
      }),
    ])

    // Self-referral
    if (partner.organizationId === params.organizationId) {
      return { score: 100, signals: [FraudSignals.SELF_REFERRAL] }
    }

    // Same email domain (public providers excluded)
    const partnerDomain = partner.email.split('@')[1]
    if (partnerDomain && !PUBLIC_EMAIL_DOMAINS.has(partnerDomain) &&
        org.memberships.some(m => m.user.email.endsWith(`@${partnerDomain}`))) {
      score += 40; signals.push(FraudSignals.SAME_EMAIL_DOMAIN)
    }

    // Same IP as a partner click within 24h
    if (await this.sharedIpWithPartner(params.partnerId, params.signupIpHash)) {
      score += 35; signals.push(FraudSignals.SAME_IP)
    }

    // Velocity
    const recent = await this.prisma.client.referral.count({
      where: { partnerId: params.partnerId, signedUpAt: { gte: subHours(new Date(), 24) } },
    })
    if (recent > 10) { score += 30; signals.push(FraudSignals.HIGH_VELOCITY) }

    // Disposable email
    if (org.billingEmail && (await this.isDisposableEmail(org.billingEmail))) {
      score += 25; signals.push(FraudSignals.DISPOSABLE_EMAIL)
    }

    // No click recorded — could be legitimate word of mouth, but flag it
    if (!params.visitorId) { score += 10; signals.push(FraudSignals.NO_CLICK_ATTRIBUTION) }

    if (score > 0) this.logger.warn({ partnerId: params.partnerId, organizationId: params.organizationId, score, signals }, 'referral fraud signals')

    return { score: Math.min(score, 100), signals }
  }
}
```

Score above `FRAUD_AUTO_REJECT_SCORE` (70) rejects the referral automatically; the
rejection and its signals are visible to staff, who can reinstate it after review.

### 8.5 Payouts

```typescript
@Cron(Schedules.PROCESS_PAYOUTS)      // 1st of each month
async processMonthlyPayouts(): Promise<void> {
  await this.locks.withLock(LockNames.PROCESS_PAYOUTS, 3600, async () => {
    const partners = await this.prisma.client.partner.findMany({
      where: { status: PartnerStatus.ACTIVE, taxFormSubmitted: true, stripeConnectAccountId: { not: null } },
      include: { program: true },
    })

    for (const partner of partners) {
      const pending = await this.prisma.client.commission.findMany({
        where: { partnerId: partner.id, status: CommissionStatus.PENDING, referral: { status: ReferralStatus.APPROVED } },
      })
      const total = pending.reduce((sum, c) => sum + c.amountCents, 0)

      // Below the minimum rolls over to next month
      if (total < partner.program.minPayoutCents) continue

      // The Payout row (with its idempotency key) is created BEFORE the job, so a crash
      // between the two can never produce a second transfer.
      const period = { periodStart: startOfMonth(subMonths(new Date(), 1)), periodEnd: endOfMonth(subMonths(new Date(), 1)) }
      const payout = await this.prisma.client.$transaction(async tx => {
        const created = await tx.payout.create({
          data: {
            partnerId: partner.id, amountCents: total, method: PayoutMethods.STRIPE_CONNECT,
            idempotencyKey: `payout:${partner.id}:${formatDate(period.periodStart, 'yyyy-MM')}`, ...period,
          },
        })
        await tx.commission.updateMany({ where: { id: { in: pending.map(c => c.id) } }, data: { payoutId: created.id } })
        return created
      })

      await this.exportsQueue.add(JobNames.PROCESS_PARTNER_PAYOUT, { payoutId: payout.id }, { jobId: payout.idempotencyKey })
    }
  })
}
```

The payout processor executes a Stripe Connect transfer with `idempotencyKey`, marks the
payout `PAID` and its commissions `PAID` in one transaction, and emails
`EmailTemplates.PAYOUT_CONFIRMATION`.

**Tax compliance:** no payout is processed without a submitted tax form
(W-9 for US, W-8BEN otherwise) and a connected Stripe account.

### 8.6 Partner dashboard

```
┌───────────────────────────────────────────────────────────────────┐
│ Your referral link                                                │
│ https://platform.com/?ref=MARIA20                        [Copy]   │
│ [Download assets]  [UTM builder]  [Program terms]                 │
├───────────────────────────────────────────────────────────────────┤
│ Last 30 days                                                      │
│ Clicks 1,247  ·  Signups 84 (6.7%)  ·  Conversions 19 (22.6%)     │
│ Earnings $487.20     Pending $142.80                              │
├───────────────────────────────────────────────────────────────────┤
│ Available balance $487.20    Minimum payout $100                  │
│ Next automatic payout Oct 1              [Request payout]         │
├───────────────────────────────────────────────────────────────────┤
│ Referrals                                                         │
│ Acme Store      Aug 12   Qualified    $17.80/mo (11 remaining)    │
│ Boutique Luna   Aug 08   Approved     $17.80/mo (11 remaining)    │
│ Shop Verde      Jul 15   Rejected     — canceled                  │
└───────────────────────────────────────────────────────────────────┘
```

---

## 9. Customer support for the SaaS

### 9.1 Support tiers

```typescript
export const SupportChannels = {
  HELP_CENTER: 'help_center', EMAIL: 'email', IN_APP_CHAT: 'in_app_chat', PHONE: 'phone', SLACK_CONNECT: 'slack_connect', DEDICATED_CSM: 'dedicated_csm',
} as const

// hoursKey is an i18n key (support.hours.*); never a literal shown to users
export const SupportSLA: Record<SupportTier, { firstResponseHours: number; resolutionHours: number; channels: readonly string[]; hoursKey: string }> = {
  [SupportTiers.COMMUNITY]: { firstResponseHours: 72, resolutionHours: 168, channels: [SupportChannels.HELP_CENTER], hoursKey: 'support.hours.bestEffort' },
  [SupportTiers.STANDARD]:  { firstResponseHours: 24, resolutionHours: 72, channels: [SupportChannels.HELP_CENTER, SupportChannels.EMAIL, SupportChannels.IN_APP_CHAT], hoursKey: 'support.hours.business' },
  [SupportTiers.PRIORITY]:  { firstResponseHours: 4, resolutionHours: 24, channels: [SupportChannels.HELP_CENTER, SupportChannels.EMAIL, SupportChannels.IN_APP_CHAT, SupportChannels.PHONE], hoursKey: 'support.hours.extended' },
  [SupportTiers.DEDICATED]: { firstResponseHours: 1, resolutionHours: 8, channels: Object.values(SupportChannels), hoursKey: 'support.hours.always' },
}
```

### 9.2 Dogfooding

**We use our own platform to run support.**

```
Organization: "Platform Internal"
  └─ Store: "Customer Support"
       ├─ WhatsApp Business    (support by WhatsApp)
       ├─ Email channel        (support@platform.com — the email plugin, TDD_10 §5.5)
       └─ Web widget           (the in-app support chat is our own widget embedded in apps/web, TDD_10 §5.4)
```

**Benefits:** bugs surface internally first, the team develops deep product
intuition, and we save the cost of an external tool.

**Accepted risk:** if the platform is down, support is down.
**Mitigations:** status page on separate infrastructure, plus a fallback
email address monitored outside the platform.

### 9.3 In-app support widget

Self-service first — contextual help articles deflect roughly 60% of tickets. Articles
are matched by `AppPaths` route pattern (store id stripped), served by
`GET /support/articles?path=…`:

```typescript
const ContextualArticles: Record<string, readonly string[]> = {
  '/s/:storeId/settings/channels': ['connecting-whatsapp-business', 'instagram-permissions-explained', 'troubleshooting-channel-disconnection', 'embedding-the-web-widget'],
  '/s/:storeId/inbox': ['inbox-keyboard-shortcuts', 'understanding-conversation-states', 'whatsapp-24h-window-explained'],
  '/s/:storeId/orders': ['creating-orders-from-chat', 'order-status-workflow'],
  '/s/:storeId/settings/team': ['inviting-team-members', 'roles-and-permissions-guide'],
  '/org/billing': ['understanding-billable-conversations', 'changing-plans', 'ai-credits-explained'],
}
```

The widget shows: contextual articles, then search, then chat (with the SLA
for the current plan displayed), then system status.

### 9.4 Help center

```
Stack: Docusaurus, hosted separately from the main application
URL:   help.platform.com
Search: Algolia DocSearch

Structure:
├─ Getting started
├─ Channels (WhatsApp, Instagram, Messenger, Web widget, Email)
├─ Inbox
├─ Orders
├─ Customers
├─ Analytics
├─ Settings & administration
├─ Billing & AI credits
├─ Developers (API reference, webhooks, plugin SDK)
└─ Troubleshooting
```

Every article carries frontmatter linking it to route patterns and error codes, which
is what powers contextual help in the widget.

### 9.5 Status page

```
Stack: hosted status page provider
URL:   status.platform.com
CRITICAL: must live outside the main infrastructure

Monitored components:
├─ API                    (GET /health/ready)
├─ Web application
├─ WhatsApp integration   (synthetic message send)
├─ Instagram integration
├─ Messenger integration
├─ Web widget             (bootstrap call)
├─ Email channel          (synthetic inbound)
├─ Realtime (WebSocket)   (connect + echo)
├─ Background jobs        (queue depth threshold)
└─ File uploads           (presigned URL generation)

Severity: Operational · Degraded · Partial outage · Major outage
All organization admins are auto-subscribed to incident emails.
```

### 9.6 Support metrics

```typescript
export const SupportMetrics = {
  TICKETS_CREATED: 'support.tickets.created',
  TICKETS_RESOLVED: 'support.tickets.resolved',
  FIRST_RESPONSE_TIME: 'support.first_response_time',
  RESOLUTION_TIME: 'support.resolution_time',
  SLA_COMPLIANCE: 'support.sla_compliance',
  CSAT: 'support.csat',
  DEFLECTION_RATE: 'support.deflection_rate',
  ESCALATION_RATE: 'support.escalation_rate',
} as const
```

**Key signal:** a rising ticket category is a product defect, not a support
problem. "How-to questions" trending up means the UI is unclear.
"Channel connection issues" trending up usually means a provider API changed.
