import type { OrderMessageHistoryItem } from './order-message-history.service'
import type { OrderTemplateView } from './order-templates.support'
import { pluginHistoryView, pluginTemplateView } from './plugin-order-messages.views'

const item = (): OrderMessageHistoryItem => ({
  id: 'dispatch-1',
  kind: 'order_shipped',
  trigger: 'manual',
  route: 'email',
  status: 'sent',
  reason: null,
  locale: 'es',
  shipmentId: 'shipment-1',
  deliveryStatus: 'sent',
  deliveryError: 'provider said no to 10.0.0.1',
  requestedBy: { id: 'user-1', name: 'Ana Agent' },
  createdAt: '2026-11-15T12:00:00.000Z'
})

describe('what a plugin reads of the messages about an order', () => {
  it('answers the allowlist of the history and not who pressed send, the package or the raw error', () => {
    const page = pluginHistoryView({
      data: [{ ...item(), name: 'a field a newer service adds' } as OrderMessageHistoryItem],
      nextCursor: null,
      hasMore: false
    })

    expect(Object.keys(page.data[0] ?? {}).sort()).toEqual([
      'createdAt',
      'deliveryStatus',
      'id',
      'kind',
      'route',
      'status',
      'trigger'
    ])
    const text = JSON.stringify(page)
    for (const secret of ['Ana Agent', 'user-1', 'shipment-1', 'provider said', 'newer service']) {
      expect(text).not.toContain(secret)
    }
  })

  it('keeps the cursor of the page', () => {
    const page = pluginHistoryView({ data: [], nextCursor: 'next', hasMore: true })

    expect(page).toEqual({ data: [], nextCursor: 'next', hasMore: true })
  })

  it('answers a template without its link to a template of a channel account', () => {
    const template: OrderTemplateView = {
      id: 'template-1',
      kind: 'order_shipped',
      locale: 'es',
      body: 'Hola {{customerName}}',
      autoSend: false,
      attachSummary: false,
      channelTemplate: { pluginId: 'a-channel', name: 'shipped_v2', language: 'es', variables: [] },
      variables: [],
      warnings: [],
      updatedAt: new Date('2026-11-15T12:00:00.000Z')
    }

    const view = pluginTemplateView(template)

    expect(view).not.toHaveProperty('channelTemplate')
    expect(JSON.stringify(view)).not.toContain('a-channel')
    expect(view.body).toBe('Hola {{customerName}}')
  })
})
