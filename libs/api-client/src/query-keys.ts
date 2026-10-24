import type { ConversationStatus } from '@platform/core/domain'

// Fields grow with the conversation list endpoint (TDD_08 §2.4); the cursor is not part of a key.
export interface ConversationFilters {
  status?: ConversationStatus
}

// TanStack Query keys are constants, built the same way as CacheKeys. Realtime invalidation
// (TDD_06 §3) and mutations import them; nobody writes ['conversations', storeId] inline.
// Store-scoped keys carry the storeId; organization-scoped ones (warehouses, transfers, counts)
// carry the organizationId.
export const QueryKeys = {
  conversations: {
    all: (storeId: string) => ['conversations', storeId] as const,
    list: (storeId: string, filters: ConversationFilters) =>
      ['conversations', storeId, 'list', filters] as const,
    byId: (storeId: string, id: string) => ['conversations', storeId, id] as const,
    counts: (storeId: string) => ['conversations', storeId, 'counts'] as const
  },
  messages: {
    thread: (storeId: string, conversationId: string) =>
      ['messages', storeId, conversationId] as const
  },
  customers: {
    all: (storeId: string) => ['customers', storeId] as const,
    byId: (storeId: string, id: string) => ['customers', storeId, id] as const
  },
  orders: {
    all: (storeId: string) => ['orders', storeId] as const,
    byId: (storeId: string, id: string) => ['orders', storeId, id] as const
  },
  products: {
    search: (storeId: string, q: string) => ['products', storeId, 'search', q] as const
  },
  search: {
    global: (storeId: string, q: string) => ['search', storeId, q] as const
  },
  notifications: {
    list: (storeId: string) => ['notifications', storeId] as const,
    unread: (storeId: string) => ['notifications', storeId, 'unread'] as const
  },

  // Inventory (TDD_16 §3)
  inventory: {
    levels: (storeId: string) => ['inventory', storeId, 'levels'] as const,
    movements: (storeId: string) => ['inventory', storeId, 'movements'] as const
  },
  warehouses: {
    all: (organizationId: string) => ['warehouses', organizationId] as const
  },
  transfers: {
    all: (organizationId: string) => ['transfers', organizationId] as const
  },
  counts: {
    all: (organizationId: string) => ['counts', organizationId] as const
  },

  // Shipping (TDD_17 §3)
  shipments: {
    all: (storeId: string) => ['shipments', storeId] as const,
    byOrder: (storeId: string, orderId: string) => ['shipments', storeId, 'order', orderId] as const
  },
  carriers: {
    all: (storeId: string) => ['carriers', storeId] as const,
    statusMappings: (storeId: string, connectionId: string) =>
      ['carriers', storeId, connectionId, 'status-mappings'] as const,
    unmappedStatuses: (storeId: string, connectionId: string) =>
      ['carriers', storeId, connectionId, 'unmapped-statuses'] as const
  },
  pickups: {
    all: (storeId: string) => ['pickups', storeId] as const
  },
  returns: {
    all: (storeId: string) => ['returns', storeId] as const
  },
  orderTemplates: {
    all: (storeId: string) => ['order-templates', storeId] as const
  },
  remittances: {
    all: (storeId: string) => ['remittances', storeId] as const
  },
  returnReception: {
    batch: (storeId: string, batchId: string) => ['return-reception', storeId, batchId] as const
  },
  preferences: {
    store: (storeId: string) => ['preferences', storeId] as const
  },

  session: ['session'] as const
} as const
