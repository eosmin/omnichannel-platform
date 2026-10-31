import { TenantHeaders, ThrottlerNames } from './auth'
import { BulkActions, BulkLimits, ConversationStatusReasons } from './conversation-constants'
import { DEFAULT_LOCALE, Locales, SOURCE_LOCALE, SUPPORTED_LOCALES } from './i18n'
import { OrderCancellationReasons, OrderPrintDocuments } from './order-constants'
import { PresenceStatus } from './realtime'
import { DestructiveActionTierLevels, DestructiveActionTiers } from './safety-constants'
import { Shortcuts } from './shortcuts'
import {
  AllAllowedContentTypes,
  AllowedContentTypes,
  ImageVariants,
  StorageKeys,
  UploadLimits
} from './storage'
import { ResendEventTypes, WebhookHeaders, WebhookLimits } from './webhook-constants'

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length

describe('tenant and throttler names', () => {
  it('reads the store from a lowercase header and names three throttlers', () => {
    expect(TenantHeaders.STORE_ID).toBe('x-store-id')
    expect(Object.values(ThrottlerNames)).toEqual(['default', 'auth', 'public'])
  })
})

describe('locales', () => {
  it('writes the messages in English and serves Spanish by default', () => {
    expect(SOURCE_LOCALE).toBe(Locales.EN)
    expect(DEFAULT_LOCALE).toBe(Locales.ES)
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE)
  })
})

describe('presence', () => {
  it('has three states', () => {
    expect(Object.values(PresenceStatus)).toEqual(['online', 'away', 'offline'])
  })
})

describe('uploads and storage keys', () => {
  it('caps video above the general file size and expires the upload link quickly', () => {
    expect(UploadLimits.MAX_VIDEO_SIZE_BYTES).toBeGreaterThan(UploadLimits.MAX_FILE_SIZE_BYTES)
    expect(UploadLimits.PRESIGNED_URL_TTL_SECONDS).toBeLessThan(
      UploadLimits.DOWNLOAD_URL_TTL_SECONDS
    )
  })

  it('flattens every allowed content type into one set', () => {
    for (const types of Object.values(AllowedContentTypes)) {
      for (const type of types) expect(AllAllowedContentTypes.has(type)).toBe(true)
    }
    expect(AllAllowedContentTypes.has('application/pdf')).toBe(true)
    expect(AllAllowedContentTypes.has('application/x-msdownload')).toBe(false)
  })

  it('builds every tenant S3 key under the store prefix, so a store can be wiped by prefix', () => {
    const prefix = StorageKeys.storePrefix('s1')
    for (const key of [
      StorageKeys.message('s1', 'm1', 'a.png'),
      StorageKeys.messageVariant('s1', 'm1', ImageVariants.THUMB),
      StorageKeys.product('s1', 'p1', 'm1', 'a.png'),
      StorageKeys.order('s1', 'o1', 'm1', 'a.pdf'),
      StorageKeys.export('s1', 'e1', 'a.csv')
    ]) {
      expect(key.startsWith(prefix)).toBe(true)
    }
    expect(StorageKeys.auditArchive(2026, 3)).toBe('audit/2026/03/audit-logs.jsonl.gz')
  })
})

describe('webhooks', () => {
  it('uses lowercase header names, and the documented signature header', () => {
    for (const header of Object.values(WebhookHeaders)) expect(header).toBe(header.toLowerCase())
    expect(WebhookHeaders.SIGNATURE).toBe('x-platform-signature')
    expect(WebhookLimits.MAX_CONSECUTIVE_FAILURES).toBe(20)
  })

  it('names the Resend events the way Resend does', () => {
    expect(Object.values(ResendEventTypes)).toEqual([
      'email.opened',
      'email.clicked',
      'email.bounced',
      'email.failed',
      'email.complained'
    ])
  })
})

describe('conversation constants', () => {
  it('has a reason for each automatic status change and no spam-detected reason', () => {
    expect(Object.keys(ConversationStatusReasons)).toEqual([
      'SNOOZE_EXPIRED',
      'AUTO_ARCHIVED',
      'CUSTOMER_REPLIED'
    ])
  })

  it('has unique bulk actions and the documented cap', () => {
    expect(unique(Object.values(BulkActions))).toBe(true)
    expect(BulkLimits.MAX_ITEMS).toBe(500)
    expect(BulkLimits.CONFIRM_FROM).toBe(10)
  })
})

describe('order print documents', () => {
  it('has the three documents of TDD_09 and the summary of TDD_17', () => {
    expect(Object.values(OrderPrintDocuments)).toEqual([
      'packing_slip',
      'invoice',
      'shipping_label',
      'order_summary'
    ])
  })
})

describe('DestructiveActionTiers', () => {
  const tierOf = DestructiveActionTiers as Record<string, string>

  it('only uses known tiers, and never deletes an organization', () => {
    const levels: readonly string[] = Object.values(DestructiveActionTierLevels)
    for (const tier of Object.values(DestructiveActionTiers)) expect(levels).toContain(tier)
    expect(Object.keys(DestructiveActionTiers)).not.toContain('DELETE_ORGANIZATION')
  })

  it('treats irreversible inventory, shipping and money actions as high', () => {
    for (const action of [
      'CANCEL_IN_TRANSIT_TRANSFER',
      'APPLY_STOCK_COUNT',
      'CANCEL_ORDER_WITH_SHIPMENT',
      'DISCONNECT_CARRIER_WITH_OPEN_SHIPMENTS',
      'MARK_GUIDE_VOIDED_BY_HAND',
      'VOID_CONFIRMED_REMITTANCE'
    ]) {
      expect(tierOf[action]).toBe(DestructiveActionTierLevels.HIGH)
    }
    expect(tierOf['REQUEST_PICKUP_AFTER_CUTOFF']).toBe(DestructiveActionTierLevels.MODERATE)
  })
})

describe('Shortcuts', () => {
  it('never binds the same key twice inside one scope', () => {
    for (const scope of Object.values(Shortcuts)) {
      expect(unique(Object.values(scope))).toBe(true)
    }
  })
})

describe('order cancellation reasons', () => {
  it('are unique i18n keys under one namespace', () => {
    const keys = Object.values(OrderCancellationReasons)
    expect(unique(keys)).toBe(true)
    expect(keys.every(key => key.startsWith('orders.cancellationReason.'))).toBe(true)
  })
})
