import { z } from 'zod'

import { ApiRoutes } from '@platform/core/api'
import type {
  GuidePolicyBody,
  RecordGuideAdjustmentBody,
  RecordGuidePurchaseBody,
  VoidGuidePurchaseBody
} from '@platform/core/domain'

import type { ApiClient } from './api-client'

// The balance of prepaid guides and the refund benefit of a carrier connection (TDD_17 §4.18). Reading asks for
// carriers:view_guide_balance; purchases, adjustments, voids and the policy, for carriers:manage_guide_balance. Money is whole
// cents of USD and rates are basis points.

const enc = encodeURIComponent

const balanceSchema = z.object({
  tracked: z.boolean(),
  balance: z.number().int(),
  receivedGuides: z.number().int(),
  paidCents: z.number().int(),
  averageCostCents: z.number().int().nullable(),
  lowBalanceThreshold: z.number().int().nullable(),
  warnOnEmptyBalance: z.boolean(),
  low: z.boolean(),
  empty: z.boolean()
})
export type GuideBalanceView = z.output<typeof balanceSchema>

const movementSchema = z.object({
  id: z.string(),
  kind: z.string(),
  guidesDelta: z.number().int(),
  costCentsDelta: z.number().int(),
  paidQuantity: z.number().int().nullable(),
  giftQuantity: z.number().int().nullable(),
  unitCostCents: z.number().int().nullable(),
  shipmentId: z.string().nullable(),
  voidsMovementId: z.string().nullable(),
  voided: z.boolean(),
  note: z.string().nullable(),
  createdBy: z.string(),
  occurredAt: z.string(),
  createdAt: z.string()
})
export type GuideMovementView = z.output<typeof movementSchema>

const movementPageSchema = z.object({
  data: z.array(movementSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean()
})
export type GuideMovementPage = z.output<typeof movementPageSchema>

const policySchema = z.object({
  stored: z.boolean(),
  balanceEnabled: z.boolean(),
  benefitEnabled: z.boolean(),
  warnOnEmptyBalance: z.boolean(),
  lowBalanceThreshold: z.number().int().nullable(),
  periodKind: z.string(),
  periodDays: z.number().int(),
  periodAnchor: z.string(),
  thresholdBps: z.number().int(),
  warnAtBps: z.number().int(),
  base: z.string(),
  returnStatuses: z.array(z.string()),
  refundRule: z.string(),
  lossRule: z.string(),
  toConfirm: z.array(z.string())
})
export type GuidePolicyView = z.output<typeof policySchema>

const benefitSchema = z.object({
  enabled: z.boolean(),
  state: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  baseCount: z.number().int(),
  returnCount: z.number().int(),
  rateBps: z.number().int(),
  thresholdBps: z.number().int().nullable(),
  warnAtBps: z.number().int().nullable(),
  crossedAt: z.string().nullable()
})
export type BenefitView = z.output<typeof benefitSchema>

const periodSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  baseCount: z.number().int(),
  returnCount: z.number().int(),
  rateBps: z.number().int(),
  state: z.string(),
  refundedCount: z.number().int(),
  closedAt: z.string()
})
export type BenefitPeriodView = z.output<typeof periodSchema>

export function fetchGuideBalance(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<GuideBalanceView> {
  return client.request(ApiRoutes.carriers.guideBalance(enc(id)), {
    schema: balanceSchema,
    storeId,
    signal
  })
}

export function fetchGuideMovements(
  client: ApiClient,
  storeId: string,
  id: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<GuideMovementPage> {
  const params = new URLSearchParams()
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const text = params.toString()
  return client.request(
    `${ApiRoutes.carriers.guideMovements(enc(id))}${text === '' ? '' : `?${text}`}`,
    { schema: movementPageSchema, storeId, signal }
  )
}

export function recordGuidePurchase(
  client: ApiClient,
  storeId: string,
  id: string,
  body: RecordGuidePurchaseBody
): Promise<GuideMovementView> {
  return client.request(ApiRoutes.carriers.guidePurchases(enc(id)), {
    method: 'POST',
    body,
    schema: movementSchema,
    storeId
  })
}

export function voidGuidePurchase(
  client: ApiClient,
  storeId: string,
  id: string,
  movementId: string,
  body: VoidGuidePurchaseBody
): Promise<GuideMovementView> {
  return client.request(ApiRoutes.carriers.guidePurchaseVoid(enc(id), enc(movementId)), {
    method: 'POST',
    body,
    schema: movementSchema,
    storeId
  })
}

export function recordGuideAdjustment(
  client: ApiClient,
  storeId: string,
  id: string,
  body: RecordGuideAdjustmentBody
): Promise<GuideMovementView> {
  return client.request(ApiRoutes.carriers.guideAdjustments(enc(id)), {
    method: 'POST',
    body,
    schema: movementSchema,
    storeId
  })
}

export function fetchGuidePolicy(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<GuidePolicyView> {
  return client.request(ApiRoutes.carriers.guidePolicy(enc(id)), {
    schema: policySchema,
    storeId,
    signal
  })
}

export function putGuidePolicy(
  client: ApiClient,
  storeId: string,
  id: string,
  body: GuidePolicyBody
): Promise<GuidePolicyView> {
  return client.request(ApiRoutes.carriers.guidePolicy(enc(id)), {
    method: 'PUT',
    body,
    schema: policySchema,
    storeId
  })
}

export function fetchBenefit(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<BenefitView> {
  return client.request(ApiRoutes.carriers.benefit(enc(id)), {
    schema: benefitSchema,
    storeId,
    signal
  })
}

export function fetchBenefitPeriods(
  client: ApiClient,
  storeId: string,
  id: string,
  signal?: AbortSignal
): Promise<BenefitPeriodView[]> {
  return client.request(ApiRoutes.carriers.benefitPeriods(enc(id)), {
    schema: z.array(periodSchema),
    storeId,
    signal
  })
}
