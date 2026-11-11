import type { ChannelId, ConversationStatus, CustomerTimelineType } from '@platform/core/domain'
import type { GalleryType } from '@platform/core/storage'

// What narrows the list (the filters of TDD_09 §2); the cursor is not part of a key. `assigned` is
// `me`, `unassigned` or the id of a member (ConversationAssignedFilters).
export interface ConversationFilters {
  assigned?: string
  status?: ConversationStatus
  channelType?: ChannelId
  tagId?: string
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
    all: (storeId: string) => ['messages', storeId] as const,
    thread: (storeId: string, conversationId: string) =>
      ['messages', storeId, conversationId] as const,
    // Under the thread key: whatever makes the thread stale makes its origins stale too
    origins: (storeId: string, conversationId: string) =>
      ['messages', storeId, conversationId, 'origins'] as const,
    // Also under the thread key: a message of the customer opens the window again
    // Read on demand by a dialog, not part of the thread: the kept text is audited on each read
    deletedContent: (storeId: string, messageId: string) =>
      ['messages', storeId, 'deleted-content', messageId] as const,
    revisions: (storeId: string, messageId: string) =>
      ['messages', storeId, 'revisions', messageId] as const,
    window: (storeId: string, conversationId: string) =>
      ['messages', storeId, conversationId, 'window'] as const
  },
  tags: {
    all: (storeId: string) => ['tags', storeId] as const
  },
  customers: {
    all: (storeId: string) => ['customers', storeId] as const,
    byId: (storeId: string, id: string) => ['customers', storeId, id] as const,
    // The page of the customers page, by search text
    list: (storeId: string, q: string) => ['customers', storeId, 'list', q] as const,
    // Under the customer: whatever makes the customer stale makes its activity stale too
    timeline: (storeId: string, id: string, type: CustomerTimelineType | 'all') =>
      ['customers', storeId, id, 'timeline', type] as const,
    conversations: (storeId: string, id: string) =>
      ['customers', storeId, id, 'conversations'] as const,
    // The gallery under a tab and a search: a merge moves the files, so it goes stale with the customer
    media: (storeId: string, id: string, type: GalleryType, q: string) =>
      ['customers', storeId, id, 'media', type, q] as const,
    // Outside the root of the customers on purpose: the merge makes every customer stale, and the
    // preview of a merge that just ran must not be read again (the absorbed customer is gone)
    mergePreview: (storeId: string, id: string, absorbedId: string) =>
      ['customer-merge-preview', storeId, id, absorbedId] as const
  },
  orders: {
    all: (storeId: string) => ['orders', storeId] as const,
    byId: (storeId: string, id: string) => ['orders', storeId, id] as const
  },
  products: {
    all: (storeId: string) => ['products', storeId] as const,
    // The page of the catalog, by the active filter ('all' | 'active' | 'archived')
    list: (storeId: string, filter: string) => ['products', storeId, 'list', filter] as const,
    // Under the product: whatever makes the product stale makes its variants and its pictures stale too
    byId: (storeId: string, id: string) => ['products', storeId, id] as const,
    images: (storeId: string, id: string) => ['products', storeId, id, 'images'] as const,
    // The autocomplete: by text, and by whether archived products may answer (a filter of the page)
    search: (storeId: string, q: string, includeArchived: boolean) =>
      ['products', storeId, 'search', q, includeArchived] as const
  },
  search: {
    global: (storeId: string, q: string) => ['search', storeId, q] as const
  },
  notifications: {
    list: (storeId: string) => ['notifications', storeId] as const,
    // One tab of the center; under `list`, so the event that refreshes `list` refreshes every tab
    filtered: (storeId: string, filter: string) =>
      ['notifications', storeId, 'list', filter] as const,
    unread: (storeId: string) => ['notifications', storeId, 'unread'] as const,
    // The person's own choices for this store; not under `list`, a new notification does not change them
    preferences: (storeId: string) => ['notifications', storeId, 'preferences'] as const
  },

  // Inventory (TDD_16 §3)
  inventory: {
    root: ['inventory'] as const,
    all: (storeId: string) => ['inventory', storeId] as const,
    levels: (storeId: string) => ['inventory', storeId, 'levels'] as const,
    movements: (storeId: string) => ['inventory', storeId, 'movements'] as const,
    // The stock column of the catalog: the products of a page, by their ids
    summary: (storeId: string, productIds: readonly string[]) =>
      ['inventory', storeId, 'summary', [...productIds].sort().join(',')] as const,
    // The levels of one product, one row per item and warehouse
    product: (storeId: string, productId: string) =>
      ['inventory', storeId, 'product', productId] as const,
    // The kardex of one item in one warehouse
    kardex: (storeId: string, productId: string, variantId: string | null, warehouseId: string) =>
      ['inventory', storeId, 'kardex', productId, variantId, warehouseId] as const,
    warehouses: (storeId: string) => ['inventory', storeId, 'warehouses'] as const
  },
  warehouses: {
    all: (organizationId: string) => ['warehouses', organizationId] as const
  },
  transfers: {
    all: (organizationId: string) => ['transfers', organizationId] as const
  },
  // Keyed by the store the request goes through (the api reads the organization from X-Store-Id)
  counts: {
    // Every store's cache: a count belongs to the organization, so a change makes the list of every store stale
    root: ['counts'] as const,
    all: (storeId: string) => ['counts', storeId] as const,
    list: (storeId: string, status: string | null) => ['counts', storeId, 'list', status] as const,
    // The whole sheet of one count: its header, its totals and every line
    detail: (storeId: string, countId: string) => ['counts', storeId, 'detail', countId] as const,
    warehouses: (storeId: string) => ['counts', storeId, 'warehouses'] as const
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
  exports: {
    all: (storeId: string) => ['exports', storeId] as const,
    list: (storeId: string, type: string | null, status: string | null) =>
      ['exports', storeId, type, status] as const
  },
  media: {
    // Every signed link of the store: a file processed (its variants now exist) makes them all stale
    all: (storeId: string) => ['media', storeId] as const,
    // The signed links of one clean file; they expire, so the query has a short life
    urls: (storeId: string, mediaId: string) => ['media', storeId, mediaId, 'urls'] as const
  },
  preferences: {
    store: (storeId: string) => ['preferences', storeId] as const
  },
  members: {
    directory: (storeId: string) => ['members', storeId, 'directory'] as const
  },
  channels: {
    directory: (storeId: string) => ['channels', storeId, 'directory'] as const,
    templates: (storeId: string, pluginId: string, connectionId: string) =>
      ['channels', storeId, 'templates', pluginId, connectionId] as const
  },
  snippets: {
    all: (storeId: string) => ['snippets', storeId] as const
  },
  inboxBehavior: {
    store: (storeId: string) => ['inbox-behavior', storeId] as const
  },
  // The inventory switches of the store (Settings → Inventory)
  inventorySettings: {
    store: (storeId: string) => ['inventory-settings', storeId] as const
  },
  presence: {
    team: (storeId: string) => ['presence', storeId] as const
  },

  // The page of an invitation, read before the person has a session
  invitations: {
    byToken: (token: string) => ['invitations', token] as const
  },
  // The stores of the organization of the store in storeId (the api reads it from X-Store-Id)
  organizations: {
    // Everything read through the store: a create, rename or delete refreshes all of it
    all: (storeId: string) => ['organizations', storeId] as const,
    stores: (storeId: string) => ['organizations', storeId, 'stores'] as const,
    current: (storeId: string) => ['organizations', storeId, 'current'] as const,
    // The one store of the General page; under `stores`, so a create, rename or delete refreshes it
    store: (storeId: string, id: string) => ['organizations', storeId, 'stores', id] as const
  },
  // The person's own account: no store in the key, because it belongs to the person
  account: {
    profile: ['account', 'profile'] as const,
    preferences: ['account', 'preferences'] as const,
    sessions: ['account', 'sessions'] as const
  },

  session: ['session'] as const
} as const
