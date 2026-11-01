// Namespaced by entity. Always functions, never template literals at call sites. Every key that
// holds tenant data carries the storeId (or organizationId) in the key.
export const CacheKeys = {
  store: {
    settings: (storeId: string) => `store:${storeId}:settings`,
    agents: (storeId: string) => `store:${storeId}:agents`,
    products: (storeId: string) => `store:${storeId}:products`,
    tags: (storeId: string) => `store:${storeId}:tags`,
    snippets: (storeId: string) => `store:${storeId}:snippets`,
    routing: (storeId: string) => `store:${storeId}:routing`,
    organizationId: (storeId: string) => `store:${storeId}:org_id`
  },

  conversation: {
    byId: (storeId: string, convId: string) => `store:${storeId}:conv:${convId}`,
    counts: (storeId: string) => `store:${storeId}:conv:counts`
  },

  customer: {
    profile: (storeId: string, customerId: string) => `store:${storeId}:customer:${customerId}`,
    byIdentity: (storeId: string, channelType: string, identity: string) =>
      `store:${storeId}:customer:identity:${channelType}:${identity}`,
    orders: (storeId: string, customerId: string) =>
      `store:${storeId}:customer:${customerId}:orders`
  },

  agent: {
    convCount: (storeId: string, agentId: string) => `store:${storeId}:agent:${agentId}:conv:count`,
    permissions: (userId: string, storeId: string) => `perms:${userId}:${storeId}`
  },

  // How many refusals of one user were written to the audit log this minute (the budget that keeps a
  // prober from filling the table)
  audit: {
    denialBudget: (userId: string, action: string) => `audit:denials:${userId}:${action}`
  },

  realtime: {
    // How many handshakes of one user were tried this minute (the budget that keeps a loop from
    // costing a database read each)
    handshakes: (userId: string) => `realtime:handshakes:${userId}`,
    // The same, for one address, counted before the token is looked at
    addressHandshakes: (address: string) => `realtime:handshakes:address:${address}`
  },

  // Signed upload urls asked for in the current hour (`bucket` is the hour), and who asked for each
  upload: {
    storeQuota: (storeId: string, bucket: number) => `store:${storeId}:upload-urls:${bucket}`,
    userQuota: (storeId: string, userId: string, bucket: number) =>
      `store:${storeId}:user:${userId}:upload-urls:${bucket}`,
    requester: (storeId: string, mediaId: string) => `store:${storeId}:upload:${mediaId}:requester`
  },

  // Where the cleanup of stray media stopped listing the bucket, for the next run
  mediaCleanup: {
    cursor: () => 'media-cleanup:cursor'
  },

  eventsBridge: {
    // Set by the one api instance that takes an event of the bridge (every instance hears it)
    taken: (eventId: string) => `events-bridge:taken:${eventId}`
  },

  presence: {
    store: (storeId: string) => `presence:store:${storeId}`, // SET of userIds
    sockets: (storeId: string, userId: string) =>
      `presence:store:${storeId}:user:${userId}:sockets`, // ZSET of socket ids, scored by their last heartbeat (ms)
    lastActivity: (storeId: string, userId: string) =>
      `presence:store:${storeId}:user:${userId}:last_activity`
  },

  product: {
    byId: (storeId: string, productId: string) => `store:${storeId}:product:${productId}`,
    search: (storeId: string, queryHash: string) => `store:${storeId}:products:search:${queryHash}`,
    // The sum of available stock across the store's warehouses (TDD_16 §5)
    inventory: (storeId: string, productId: string) =>
      `store:${storeId}:product:${productId}:inventory`
  },

  channel: {
    connection: (pluginId: string, connectionId: string) =>
      `channel:${pluginId}:conn:${connectionId}`, // -> storeId + connection row
    capabilities: (pluginId: string) => `channel:${pluginId}:capabilities`
  },

  plugin: {
    manifest: (pluginId: string) => `plugin:${pluginId}:manifest`,
    installation: (storeId: string, pluginId: string) => `store:${storeId}:plugin:${pluginId}`
  },

  rateLimit: (subject: string, endpoint: string) => `rl:${subject}:${endpoint}`,
  lock: (name: string) => `lock:${name}`,

  // Patterns for bulk invalidation: use with delPattern()
  patterns: {
    storeAll: (storeId: string) => `store:${storeId}:*`,
    conversationAll: (storeId: string) => `store:${storeId}:conv:*`,
    productSearchAll: (storeId: string) => `store:${storeId}:products:search:*`
  }
} as const

// Search queries are hashed (sha1(query.toLowerCase().trim())) before becoming part of a key:
// raw user input never lands in a Redis key.

export const CacheTTL = {
  VERY_SHORT: 30, // Permissions, counts
  SHORT: 60, // Search results
  MEDIUM: 300, // Store settings
  LONG: 3600, // Plugin manifests
  VERY_LONG: 86400 // Rarely-changing reference data
} as const
