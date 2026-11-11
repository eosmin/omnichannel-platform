import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import { OrderMessageKind } from '@platform/core/domain'
import { Locales } from '@platform/core/i18n'

export interface OrderMessageTemplateInput {
  storeId: string
  kind?: string
  locale?: string
  body?: string
  autoSend?: boolean
}

// A template of Settings → Order messages, written straight to the table (the routes are what the suites test)
export async function createOrderMessageTemplate(
  owner: OwnerClient,
  input: OrderMessageTemplateInput
): Promise<{ id: string; kind: string; locale: string }> {
  return owner.orderMessageTemplate.create({
    data: {
      storeId: input.storeId,
      kind: input.kind ?? OrderMessageKind.ORDER_SHIPPED,
      locale: input.locale ?? Locales.ES,
      body: input.body ?? `Hello {{customerName}} ${randomUUID().slice(0, 8)}`,
      autoSend: input.autoSend ?? false
    },
    select: { id: true, kind: true, locale: true }
  })
}
