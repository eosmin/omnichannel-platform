import {
  type OrderMessageKindType,
  OrderMessageVariables,
  type OrderMessageVariable,
  type OrderMessageWarning,
  OrderMessageWarnings
} from '@platform/core/domain'
import { isOrderMessageVariable, variablesNeededBy } from '@platform/core/shipping'

import type { ChannelTemplateLink } from './order-templates.schemas'

// What the editor tells the owner about a template without refusing it (TDD_17 §4.7): an automatic template that uses
// `scheduledDeliveryDate` leaves every order without a date unsent, so the owner is told before it happens.
export function templateWarnings(template: {
  body: string
  autoSend: boolean
  channelTemplate: ChannelTemplateLink | null
}): OrderMessageWarning[] {
  const needed = variablesNeededBy(template.body, template.channelTemplate?.variables ?? [])
  return template.autoSend && needed.includes(OrderMessageVariables.SCHEDULED_DELIVERY_DATE)
    ? [OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE]
    : []
}

// What is read back from the JSON column: a value this service wrote, parsed again, never trusted as typed
export function readChannelTemplate(value: unknown): ChannelTemplateLink | null {
  if (typeof value !== 'object' || value === null) return null
  const link = value as Partial<ChannelTemplateLink>
  if (
    typeof link.pluginId !== 'string' ||
    typeof link.name !== 'string' ||
    typeof link.language !== 'string' ||
    !Array.isArray(link.variables)
  ) {
    return null
  }
  // The variables are positional ({{1}}, {{2}}...): one that is not in the allowlist (an edit by hand in the database, a
  // variable removed in a later release) cannot be dropped without moving the rest into the wrong places, so the whole link
  // is read as no link and the message goes by its other ways
  const variables = link.variables as unknown[]
  if (
    !variables.every(
      (name): name is OrderMessageVariable =>
        typeof name === 'string' && isOrderMessageVariable(name)
    )
  ) {
    return null
  }
  return { pluginId: link.pluginId, name: link.name, language: link.language, variables }
}

export interface OrderTemplateView {
  id: string
  kind: OrderMessageKindType
  locale: string
  body: string
  autoSend: boolean
  attachSummary: boolean
  channelTemplate: ChannelTemplateLink | null
  // The variables the template needs a value for, so the editor lists them
  variables: OrderMessageVariable[]
  warnings: OrderMessageWarning[]
  updatedAt: Date
}
