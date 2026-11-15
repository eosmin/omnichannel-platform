import type { CursorPage } from '@platform/core/domain'

import type { OrderMessageHistoryItem } from './order-message-history.service'
import type { OrderTemplateView } from './order-templates.support'

// What a plugin reads of what the store said about an order, field by field (an allowlist: a field the views gain tomorrow stays out
// until somebody decides which scope opens it). Left out on purpose: who pressed send (the team directory has no scope), the
// package a message was about (`shipments:read`), the raw error text of a channel, why a message was not sent and the language it went in (both say what the customer can be reached by), and the link of a template to a template of a
// channel account (`channels:read`).
export interface PluginOrderMessageView {
  id: string
  kind: string
  trigger: string
  route: string
  status: OrderMessageHistoryItem['status']
  deliveryStatus: string | null
  createdAt: string
}

export type PluginOrderTemplateView = Pick<
  OrderTemplateView,
  | 'id'
  | 'kind'
  | 'locale'
  | 'body'
  | 'autoSend'
  | 'attachSummary'
  | 'variables'
  | 'warnings'
  | 'updatedAt'
>

export function pluginHistoryView(
  page: CursorPage<OrderMessageHistoryItem>
): CursorPage<PluginOrderMessageView> {
  return {
    ...page,
    data: page.data.map(item => ({
      id: item.id,
      kind: item.kind,
      trigger: item.trigger,
      route: item.route,
      status: item.status,
      deliveryStatus: item.deliveryStatus,
      createdAt: item.createdAt
    }))
  }
}

export function pluginTemplateView(template: OrderTemplateView): PluginOrderTemplateView {
  return {
    id: template.id,
    kind: template.kind,
    locale: template.locale,
    body: template.body,
    autoSend: template.autoSend,
    attachSummary: template.attachSummary,
    variables: template.variables,
    warnings: template.warnings,
    updatedAt: template.updatedAt
  }
}
