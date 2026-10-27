export const RealtimeNamespaces = {
  AGENTS: '/realtime',
  WIDGET: '/widget' // Visitor sockets for the web-widget channel, TDD_10 §5.4
} as const

export const RoomNames = {
  store: (storeId: string) => `store:${storeId}`,
  user: (userId: string) => `user:${userId}`,
  // One user in one store: for what is theirs alone and belongs to a store (what they have read)
  storeUser: (storeId: string, userId: string) => `store:${storeId}:user:${userId}`,
  conversation: (conversationId: string) => `conv:${conversationId}`,
  widgetVisitor: (connectionId: string, visitorId: string) => `widget:${connectionId}:${visitorId}`
} as const
