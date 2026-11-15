import { Permissions, type Permission } from '@platform/core/auth'
import { PluginBridgeOperations, type PluginBridgeOperation } from '@platform/core/domain'

export const PluginScopes = {
  CONVERSATIONS_READ: 'conversations:read',
  CONVERSATIONS_WRITE: 'conversations:write',
  MESSAGES_READ: 'messages:read',
  MESSAGES_WRITE: 'messages:write',
  // The text of a message the customer deleted, while it is kept: its own scope, because no other grants MESSAGES_VIEW_DELETED
  MESSAGES_READ_DELETED: 'messages:read-deleted',
  // Deleting a message the plugin wrote (and throwing away a reply of its own that failed): its own scope, because deleting cannot be
  // taken back and no other scope grants MESSAGES_DELETE. It never reaches a message the plugin did not write (the service refuses it).
  MESSAGES_DELETE: 'messages:delete',
  CUSTOMERS_READ: 'customers:read',
  CUSTOMERS_WRITE: 'customers:write',
  // Deleting a customer and flagging it with a caution each have a permission that `customers:write` does not hold (a person who
  // edits a customer neither deletes nor flags it by that), so a plugin asks for each by its own scope (Step 5.6 PR E2)
  CUSTOMERS_DELETE: 'customers:delete',
  CUSTOMERS_FLAG_CAUTION: 'customers:flag-caution',
  ORDERS_READ: 'orders:read',
  // Creating an order and changing its status (ORDERS_CREATE, ORDERS_CHANGE_STATUS). Confirming, cancelling, editing and deciding a price
  // each have a permission that this does not hold (a person who creates an order does not cancel one by that), so each is a scope of its
  // own (Step 5.6 PR E3b): a status route reached with `orders:write` alone is refused for CONFIRMED and CANCELLED, as for a person
  ORDERS_WRITE: 'orders:write',
  ORDERS_EDIT: 'orders:edit',
  ORDERS_CONFIRM: 'orders:confirm',
  ORDERS_CANCEL: 'orders:cancel',
  ORDERS_APPROVE_PRICE: 'orders:approve-price',
  PRODUCTS_READ: 'products:read',
  // Creating and changing a product or a variant (Step 5.6 PR E4a); deleting one is a scope of its own, as a person who edits
  // the catalog does not delete from it by that. The cost and the tax of a product have permissions that no scope grants.
  PRODUCTS_WRITE: 'products:write',
  PRODUCTS_DELETE: 'products:delete',
  // The warehouses of the organization of the store of the key (Step 5.6 PR E4a); reading is INVENTORY_VIEW, as for a person.
  // Writing one (`warehouses:write`, ORG_MANAGE_WAREHOUSES, organization-wide) waits for PR E4a-2 to decide its reach.
  WAREHOUSES_READ: 'warehouses:read',
  // The transfers between warehouses and the physical counts of the store of the key, read only (Step 5.6 PR E4b). The scope grants
  // the permissions a person needs to read them (any of manage or receive, manage or apply: a person with inventory:view alone does
  // not read them, so neither does a plugin), and only routes that read declare it, so the write permissions it holds are never
  // exercised; the writes get scopes of their own (PR E4b-2). A plugin sees only the lines of its own store.
  TRANSFERS_READ: 'transfers:read',
  COUNTS_READ: 'counts:read',
  WEBHOOKS_WRITE: 'webhooks:write',
  ANALYTICS_READ: 'analytics:read',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',
  SHIPMENTS_READ: 'shipments:read',
  SHIPMENTS_WRITE: 'shipments:write',
  // The directory of the channel accounts and their templates (Step 5.6 PR E1); the connection of an account stays human
  CHANNELS_READ: 'channels:read',
  // What the store says to the customer about an order (the history of messages and the templates, Step 5.6 PR E3a); sending
  // one is a scope of its own, with the routes that need a person's id
  ORDER_MESSAGES_READ: 'order-messages:read',
  // Sending the message of a kind about an order (ORDERS_SEND_MESSAGES) and writing, deleting and previewing a template
  // (SETTINGS_MANAGE_ORDER_TEMPLATES), each its own scope because no other grants them (Step 5.6 PR E3b)
  ORDER_MESSAGES_WRITE: 'order-messages:write',
  ORDER_TEMPLATES_WRITE: 'order-templates:write',
  // The preferences of the store (the factory defaults it overrode, the rules of returns): reading only, SETTINGS_EDIT and the
  // security settings stay human
  SETTINGS_READ: 'settings:read',
  // Of a channel plugin (TDD_10 §6.7): the routes arrive with Step 5.6 PR C3. They grant no human permission.
  CHANNEL_CONNECTIONS: 'channel:connections',
  CHANNEL_EVENTS: 'channel:events'
} as const

export type PluginScope = (typeof PluginScopes)[keyof typeof PluginScopes]

// Each scope grants a fixed subset of the human Permissions: a plugin can never exceed what a
// human could do.
export const PluginScopePermissions: Record<PluginScope, readonly Permission[]> = {
  [PluginScopes.CONVERSATIONS_READ]: [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.CONVERSATIONS_VIEW_ALL
  ],
  [PluginScopes.CONVERSATIONS_WRITE]: [
    Permissions.CONVERSATIONS_CREATE,
    Permissions.CONVERSATIONS_ASSIGN,
    Permissions.CONVERSATIONS_RESOLVE,
    Permissions.CONVERSATIONS_SNOOZE
  ],
  [PluginScopes.MESSAGES_READ]: [Permissions.MESSAGES_VIEW],
  [PluginScopes.MESSAGES_WRITE]: [Permissions.MESSAGES_SEND, Permissions.MESSAGES_INTERNAL_NOTE],
  [PluginScopes.MESSAGES_READ_DELETED]: [Permissions.MESSAGES_VIEW_DELETED],
  [PluginScopes.MESSAGES_DELETE]: [Permissions.MESSAGES_DELETE],
  [PluginScopes.CUSTOMERS_READ]: [Permissions.CUSTOMERS_VIEW],
  [PluginScopes.CUSTOMERS_WRITE]: [Permissions.CUSTOMERS_CREATE, Permissions.CUSTOMERS_EDIT],
  [PluginScopes.CUSTOMERS_DELETE]: [Permissions.CUSTOMERS_DELETE],
  [PluginScopes.CUSTOMERS_FLAG_CAUTION]: [Permissions.CUSTOMERS_FLAG_CAUTION],
  [PluginScopes.ORDERS_READ]: [Permissions.ORDERS_VIEW],
  [PluginScopes.ORDERS_WRITE]: [Permissions.ORDERS_CREATE, Permissions.ORDERS_CHANGE_STATUS],
  [PluginScopes.ORDERS_EDIT]: [Permissions.ORDERS_EDIT],
  [PluginScopes.ORDERS_CONFIRM]: [Permissions.ORDERS_CONFIRM],
  [PluginScopes.ORDERS_CANCEL]: [Permissions.ORDERS_CANCEL],
  // Deciding the price of an order, never the override of a price (ORDERS_OVERRIDE_PRICE has no scope): a plugin does not set a
  // price outside the catalog, and approving a request needs somebody other than who made it (a plugin included)
  [PluginScopes.ORDERS_APPROVE_PRICE]: [Permissions.ORDERS_APPROVE_PRICE],
  [PluginScopes.ORDER_MESSAGES_WRITE]: [Permissions.ORDERS_SEND_MESSAGES],
  [PluginScopes.ORDER_TEMPLATES_WRITE]: [Permissions.SETTINGS_MANAGE_ORDER_TEMPLATES],
  [PluginScopes.PRODUCTS_READ]: [Permissions.PRODUCTS_VIEW],
  [PluginScopes.PRODUCTS_WRITE]: [Permissions.PRODUCTS_CREATE, Permissions.PRODUCTS_EDIT],
  [PluginScopes.PRODUCTS_DELETE]: [Permissions.PRODUCTS_DELETE],
  [PluginScopes.WAREHOUSES_READ]: [Permissions.INVENTORY_VIEW],
  [PluginScopes.TRANSFERS_READ]: [
    Permissions.INVENTORY_MANAGE_TRANSFERS,
    Permissions.INVENTORY_RECEIVE_TRANSFERS
  ],
  [PluginScopes.COUNTS_READ]: [
    Permissions.INVENTORY_MANAGE_COUNTS,
    Permissions.INVENTORY_APPLY_COUNTS
  ],
  [PluginScopes.WEBHOOKS_WRITE]: [],
  [PluginScopes.ANALYTICS_READ]: [Permissions.ANALYTICS_VIEW],
  [PluginScopes.INVENTORY_READ]: [Permissions.INVENTORY_VIEW],
  [PluginScopes.INVENTORY_WRITE]: [Permissions.INVENTORY_ADJUST],
  [PluginScopes.SHIPMENTS_READ]: [Permissions.SHIPPING_VIEW],
  [PluginScopes.SHIPMENTS_WRITE]: [Permissions.SHIPPING_MANAGE],
  // The directory is read by whoever sees conversations, and the templates of an account by who may send them, as for a person.
  // The scope only lets a plugin LIST templates: the routes that send, resend or render one must name `messages:write` and take
  // the viewer of their own scopes (`@CurrentPluginViewer`), never the union of what the key holds.
  [PluginScopes.CHANNELS_READ]: [
    Permissions.CONVERSATIONS_VIEW,
    Permissions.MESSAGES_SEND_TEMPLATE
  ],
  // The history of what was sent about an order and the templates are read by whoever reads orders, as for a person
  [PluginScopes.ORDER_MESSAGES_READ]: [Permissions.ORDERS_VIEW],
  [PluginScopes.SETTINGS_READ]: [Permissions.SETTINGS_VIEW],
  [PluginScopes.CHANNEL_CONNECTIONS]: [],
  [PluginScopes.CHANNEL_EVENTS]: []
}

// What a widget may ask through its port, and the scope the installation must hold for each (TDD_10 §7):
// checked on the server for every request, whatever the page forwarded
export const PluginBridgeOperationScopes: Record<PluginBridgeOperation, PluginScope> = {
  [PluginBridgeOperations.CONVERSATION_GET]: PluginScopes.CONVERSATIONS_READ,
  [PluginBridgeOperations.CUSTOMER_GET]: PluginScopes.CUSTOMERS_READ
}
