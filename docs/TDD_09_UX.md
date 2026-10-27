# TDD 09 — UX Specifications

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: inbox, orders, customers, settings, shortcuts, i18n, mobile
> Scope: the customer-facing app (`apps/web`) only. The internal staff
> console (`apps/admin`) has its own UX notes in `TDD_15_InternalAdmin.md §1`
> — same shadcn primitives, deliberately plainer layout, no i18n requirement
> (staff-only, single locale). The visitor-facing web widget is specified in
> `TDD_10_Plugins.md §5.4`.

---

## 1. UX principles

1. **Operational shared inbox, not a group chat.** The core loop is triage and
   assignment, not conversation.
2. **Minimal context switching.** Customer info, orders and media are visible
   without navigating away from the thread.
3. **Speed over feature count.** Keyboard shortcuts, configurable confirmations,
   optimistic updates.
4. **Channel is metadata.** The agent thinks about the customer, not about
   "WhatsApp versus Instagram".
5. **Mobile-capable.** Warehouse and delivery staff work from phones.
6. **No emojis in the interface.** Lucide React SVG icons only, consistently sized.
   (The ASCII mockups in this document use box characters for layout only.)
7. **Every destructive action is reversible or confirmed.** Never both silent
   and permanent.
8. **Every visible string is an i18n key.** Copy in this document is illustrative
   English; the key namespaces are named per section.

---

## 2. Main inbox layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ [Logo]  Store: Principal ▼      Inbox | Customers | Orders | Analytics│
│                                              [Search] [Bell] [Avatar] │
├──────────────────┬─────────────────────────────┬──────────────────────┤
│                  │                             │                      │
│  CONVERSATIONS   │    ACTIVE CONVERSATION      │   CUSTOMER PANEL     │
│                  │                             │                      │
│  [Filters]       │  Juan Pérez                 │  Juan Pérez          │
│  All        267  │  WhatsApp · 2m ago    [⋯]   │  +503 7123-4567      │
│  Mine         8  │  ─────────────────────────  │  Customer since Jan  │
│  Unassigned   7  │                             │                      │
│  Open        35  │  [Message thread]           │  ORDERS (3)          │
│  Pending     12  │                             │  #1234  $45  Deliv.  │
│  Resolved   189  │                             │  #1189  $32  Shipped │
│                  │                             │  [+ Create order]    │
│  CHANNELS        │                             │                      │
│  WhatsApp   156  │                             │  TAGS                │
│  Instagram   89  │                             │  vip, zapatos        │
│  Messenger   22  │                             │                      │
│  Web widget   9  │  ─────────────────────────  │  MEDIA (12)          │
│  Email        4  │  [Composer]                 │  [View gallery]      │
│                  │                             │                      │
│  AGENTS          │                             │  NOTES (2)           │
│  María        8  │                             │  [+ Add note]        │
│  Carlos       5  │                             │                      │
│  Unassigned   7  │                             │                      │
└──────────────────┴─────────────────────────────┴──────────────────────┘
     280px                    flexible                      320px
```

**Column behaviour:**
- Left column: fixed width, virtualized list, always visible on desktop
- Center: flexible, minimum 480px
- Right: collapsible, remembered per user in `localStorage` (`StorageKeys.SIDEBAR_COLLAPSED`)

**Filters** map to query parameters of `GET /conversations`: `assigned=me|unassigned|<userId>`,
`status`, `channelType` (`Conversation.channelType`), `tagId`, `handler=ai`. Counts come from
`GET /conversations` with `countsOnly=true` (cached, `CacheKeys.conversation.counts`).

**List item view model** (`ConversationListItem`, returned by the list endpoint and used by
`ConversationItem` and its stories):

```typescript
export interface ConversationListItem {
  id: string
  status: ConversationStatus
  handler: ConversationHandler
  channelType: ChannelType
  assignedTo: string | null
  unreadCount: number
  lastMessageAt: string | null
  snoozedUntil: string | null
  customer: { id: string; name: string | null; displayIdentity: string }   // name, or phone/handle when unnamed
  lastMessage: { id: string; authorType: AuthorType; type: MessageType; contentPreview: string | null; createdAt: string } | null
  tags: Array<{ id: string; name: string; color: string }>
}
```

---

## 3. Conversation lifecycle

### 3.1 States

```
OPEN       Active conversation requiring attention
PENDING    Waiting for the customer to respond
RESOLVED   Issue closed
SNOOZED    Hidden until a chosen date and time
ARCHIVED   Auto-archived after StoreSettings.autoArchiveAfterDays resolved (default 30, Schedules.AUTO_ARCHIVE_RESOLVED)
SPAM       Marked as spam, excluded from all counts, billing window voided
```

Valid transitions are enforced by `ConversationStatusTransitions`
(`TDD_02_Conventions.md` §5) inside `ConversationsService.updateStatus`. An invalid
transition returns `CONVERSATION_INVALID_STATUS_TRANSITION`. Labels come from
`ConversationStatusI18nKeys`.

**Read state:** `Conversation.unreadCount` counts inbound messages since `lastReadAt`. Opening
the thread calls `POST /conversations/:id/read`; "Mark unread" from the bulk menu resets
`lastReadAt` to before the last inbound message.

### 3.2 Resolve flow (configurable)

Stored in `StoreSettings` (`resolveShowOptions`, `sendClosingMessage`, `closingSnippetId`,
`requestCsat`).

```
Settings → Store → Inbox behavior

When marking a conversation as resolved:
  (o) Show options    — closing message, reason, CSAT request
  ( ) Resolve immediately — toast with Undo (10 seconds)

If resolving immediately:
  [x] Send default closing message   [Snippet: /gracias ▼]
  [ ] Request CSAT rating
```

Resolution reason is stored in `Conversation.resolutionReason` (free text, optional). CSAT:
the closing message carries a 1-5 prompt; the customer's numeric reply within 24h is
parsed by the inbound pipeline into `csatScore`/`csatComment` and feeds
`AnalyticsMetrics.CSAT_SCORE`.

### 3.3 Reopen

- **Automatic:** customer replies within `StoreSettings.reopenWindowDays` (default 7).
  Status returns to OPEN (`ConversationStatusReasons.CUSTOMER_REPLIED`), the previous
  assignee keeps the conversation and is notified (`NotificationTypes.CONVERSATION_REOPENED`).
  After the window, a new conversation is created. A message to a SNOOZED conversation
  wakes it immediately.
- **Manual:** agent clicks Reopen, or simply starts typing a reply.

### 3.4 Snooze

```
[Snooze ▼]
  Later today (3 hours)
  Tomorrow morning (9:00)
  Next week (Monday 9:00)
  Custom date and time...
```

Presets are computed in the store timezone. The conversation leaves the inbox; the
scheduler (`Schedules.WAKE_SNOOZED`) returns it to OPEN and notifies the assignee.

### 3.5 Channel messaging windows

Channels with `ChannelCapability.MESSAGING_WINDOW` (WhatsApp 24h, Instagram/Messenger per
Meta policy) expose `GET /conversations/:id/messaging-window`, computed by the core from
`CustomerIdentity.lastInboundAt` and the plugin's declared window (`TDD_10` §5.1).

```
Window open   → normal composer
< 2h left     → amber banner: "Messaging window closes in 1h 47m"
Window closed → composer disabled, replaced by:
                "The 24-hour window has expired. Send an approved template
                 to reopen the conversation."
                [Choose template ▼]
```

Once the customer replies to a template, the window reopens and the normal
composer returns.

---

## 4. Composer

```
┌──────────────────────────────────────────────────────────────┐
│ [Reply] [Internal note]                                      │
├──────────────────────────────────────────────────────────────┤
│ Type a message...                                            │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ [Paperclip] [Snippet] [Product] [Order]      [Send]          │
└──────────────────────────────────────────────────────────────┘
```

**Internal notes** are visually distinct (amber left border, "Internal" label)
and never sent to the customer. Mentioning a teammate with `@` stores their id in
`Message.mentions` and triggers `NotificationTypes.CONVERSATION_MENTIONED`.

**Attachments** are uploaded first (`TDD_07` §6.1, `purpose: MESSAGE`) and sent as
`mediaIds` with the message; the thread shows the pending upload inline.

**Slash commands:**
```
/                    Open command menu
/snippet <shortcut>  Insert a saved reply
/product <query>     Search and insert a product card
/order               Open the create-order drawer
/assign <agent>      Assign the conversation
/snooze <duration>   Snooze
/resolve             Mark resolved
```

**AI suggestions** (when enabled) appear above the composer as three chips.
Clicking one populates the composer for editing. Nothing sends automatically.

**AI-handled conversations** (`handler = ai`, `TDD_12` §13) show a banner instead of the
composer: "AI is handling this conversation — N turns left [Take over]". Take over calls
`POST /conversations/:id/take-over`; sending a message while the bot owns the conversation
returns `CONVERSATION_HANDLED_BY_AI`.

---

## 5. Order management in the inbox

### 5.1 Create order

Opens as a **side drawer**, not a modal — the chat stays visible at
roughly 50% width so the agent can re-read what the customer asked for.

```
┌─────────────────────────┬────────────────────────────────────┐
│                         │  Create order                  [×] │
│   [Chat remains         │  ────────────────────────────────  │
│    visible and          │  Customer: Juan Pérez (pre-filled) │
│    scrollable]          │                                    │
│                         │  PRODUCTS                          │
│                         │  [Search products...]              │
│                         │  ┌──────────────────────────────┐  │
│                         │  │ Zapato Deportivo   $45.00    │  │
│                         │  │ Variant: [42 ▼]  Qty: [1] [×]│  │
│                         │  └──────────────────────────────┘  │
│                         │  [+ Add product]                   │
│                         │                                    │
│                         │  SHIPPING                          │
│                         │  (o) Saved: Col. Escalón, SS       │
│                         │  ( ) New address                   │
│                         │  Cost: [$3.00]                     │
│                         │                                    │
│                         │  PAYMENT                           │
│                         │  [Cash on delivery ▼]              │
│                         │                                    │
│                         │  Subtotal          $45.00          │
│                         │  Shipping           $3.00          │
│                         │  Discount           $0.00          │
│                         │  Total             $48.00          │
│                         │                                    │
│                         │  [x] Send confirmation message     │
│                         │  [Preview message ▼]               │
│                         │                                    │
│                         │  [Cancel]        [Create order]    │
└─────────────────────────┴────────────────────────────────────┘
```

The SHIPPING block also holds the recipient phones: a list of up to 3 numbers, pre-filled from
`Customer.phone` without its country code (the customer's national number is the first entry), with add and remove buttons. Only digits
are kept (spaces, `+` and dashes are stripped on blur), a repeated number is refused and at least
one is required (`recipientPhonesSchema`, `TDD_02` §13). The guide is generated later from the order and
never asks for them again (`TDD_17` §4.5).

Variants come from `ProductVariant` (`TDD_01` §4); a product without variants has no
selector. Prices are display-only: the server reads `Product`/`ProductVariant.priceCents`
at creation (`createOrderSchema` carries no prices, `TDD_02` §13) and returns the computed
totals in cents. Product search must respond in under 200ms (cached, `TDD_08` §5.4).

On creation: a system message (`MessageType.ORDER_SUMMARY`) appears in the thread, the
customer panel refreshes, and the confirmation message is sent if selected — through the
conversation's channel, so it respects the messaging window (a closed window disables the
checkbox with an explanation).

### 5.2 Edit order

Editable fields depend on status, driven by `OrderEditableFields`.

```
CONFIRMED  items, shipping, discount, address, recipient phones, payment method, notes
PREPARING  shipping, address, recipient phones, notes
SHIPPED    address, recipient phones, notes, tracking number
DELIVERED  notes
CANCELLED  nothing
RETURNED   notes
```

If an agent tries to modify a locked field, a dialog explains why (`ORDER_FIELD_NOT_EDITABLE`)
and offers to cancel the order and create a new one.

### 5.3 Change status

```
[Change status ▼]  — only shows valid transitions (OrderStatusTransitions)

Marking DELIVERED:
  Upload proof of delivery photo (optional)   → Media purpose ORDER → Order.proofOfDeliveryMediaId
  Delivery timestamp (defaults to now)
  [x] Notify customer

Marking CANCELLED:
  Reason (required): [dropdown + free text]   → Order.cancellationReason
  Confirmation: type the order number to proceed
  [x] Notify customer
```

The dropdown lists the store's own reasons, the preference `orders.cancellationReasons`
(`TDD_17 §4.14`), editable in Settings → Preferences without code. `OrderCancellationReasons`
(`libs/core/domain/order-constants.ts`, each an i18n key) is only its factory seed.

### 5.4 Print

```
[Print ▼]
  Packing slip   — for the warehouse
  Invoice        — for the customer
  Shipping label — for the courier
```

`GET /orders/:id/print/:doc` with `doc ∈ OrderPrintDocuments = { PACKING_SLIP, INVOICE, SHIPPING_LABEL }`,
rendered server-side with `@react-pdf/renderer` in the store locale.

---

## 6. Customer profile

Opens as a drawer covering roughly 65% of the screen, above the inbox.

```
┌──────────────────────────┬────────────────────────────────────────┐
│ IDENTITY                 │ ACTIVITY TIMELINE                      │
│                          │ [All] [Conversations] [Orders] [Notes] │
│ Juan Pérez               │                                        │
│ VIP                      │ ── Today ───────────────────────────   │
│                          │ Conversation started (WhatsApp)        │
│ IDENTITIES               │   "Quiero el zapato deportivo..."      │
│ WhatsApp                 │   [Open conversation]                  │
│   +503 7123-4567         │                                        │
│ Instagram                │ Order #1234 created · $48.00           │
│   @juanperez_sv          │   [View order]                         │
│ [+ Link identity]        │                                        │
│                          │ ── Aug 10 ──────────────────────────   │
│ STATS                    │ Note by María:                         │
│ Orders            3      │   "VIP customer, apply discount"       │
│ Total spent    $105      │                                        │
│ Avg order       $35      │ Order #1189 delivered                  │
│ First seen   Jan 2026    │                                        │
│                          │                                        │
│ ADDRESSES (2)            │                                        │
│ TAGS  vip, zapatos       │                                        │
│                          │                                        │
│ [⋯ More actions]         │                                        │
└──────────────────────────┴────────────────────────────────────────┘
```

- Timeline: `GET /customers/:id/timeline` (conversations, orders, notes, merges).
- Tags on customers use the same `Tag` entities as conversations (`Customer.tags`,
  `POST/DELETE /customers/:id/tags`).
- **Link identity** (`POST /customers/:id/identities`): pick a channel and a handle; the
  handle must not already belong to another customer in the store (`RESOURCE_CONFLICT`
  offers "Merge instead").

### 6.1 Merge customers

The same person often writes from WhatsApp and Instagram and appears twice.

```
[⋯] → Merge with another customer

1. Search for the duplicate
2. Preview the merged result:
     Conversations: 4 + 2 = 6
     Orders:        3 + 1 = 4
     Identities:    WhatsApp + Instagram
3. Resolve field conflicts (which name, which email to keep)
4. Confirm by typing MERGE
5. Result is reversible via Unmerge from the timeline for 30 days
```

`POST /customers/:id/merge { absorbedId, fieldChoices }` writes a `CustomerMerge` snapshot
(`TDD_01` §4) and re-parents identities, conversations, orders, addresses, notes and tags;
the absorbed row stays with `mergedIntoId` set until `unmergeUntil`.
`POST /customers/:id/unmerge { mergeId }` reverses it from the snapshot;
after 30 days the platform cleanup hard-deletes the absorbed row
(`CUSTOMER_UNMERGE_WINDOW_EXPIRED`).

---

## 7. Media gallery

```
┌─────────────────────────────────────────────────────────────────┐
│ Media — Juan Pérez                                          [×] │
│ [All 12] [Images 8] [Videos 2] [Documents 2]                    │
│ [Search files...]                            [Download all ▼]   │
├─────────────────────────────────────────────────────────────────┤
│ ┌───────────┬───────────┬───────────┬───────────┐               │
│ │ [thumb]   │ [thumb]   │ [thumb]   │ [PDF]     │               │
│ │ zapato.jpg│ talla.jpg │ demo.mp4  │ recibo.pdf│               │
│ │ Aug 10    │ Aug 10    │ Aug 13    │ Aug 13    │               │
│ │ WhatsApp  │ WhatsApp  │ WhatsApp  │ WhatsApp  │               │
│ │ [↓] [eye] │ [↓] [eye] │ [↓] [eye] │ [↓] [eye] │               │
│ └───────────┴───────────┴───────────┴───────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

`GET /customers/:id/media` (via `Media.customerId`). Eye icon opens a lightbox with
arrow-key navigation. Download all creates an `Export { type: MEDIA_ZIP }` through the
exports queue (`TDD_07` §6.6) and requires `MEDIA_DOWNLOAD_ALL`.

---

## 8. Sidebar widgets

Right sidebar is composed of reorderable widgets (drag and drop). Order and visibility are
stored per user in `localStorage` (`StorageKeys.SIDEBAR_WIDGETS`).

```
MY PERFORMANCE
  Today: 12 resolved · 5 open · avg 3m 45s

QUICK ACTIONS
  [Create order] [Find customer] [View analytics]

TEAM STATUS
  María    online   3 open
  Carlos   online   8 open   (above threshold)     ← StoreSettings.agentLoadThreshold
  Ana      away     0 open

UNASSIGNED QUEUE (7)
  Juan Pérez     2m ago   [Take it]
  María G.       5m ago   [Take it]

RECENT ACTIVITY
  María replied to Juan            2m ago
  You resolved #1234               5m ago

[+ Add widget]
```

Team status uses `PresenceService.getStorePresence` (`TDD_06` §5). Plugins can register
widgets, rendered in a sandboxed iframe (see `TDD_10_Plugins.md` §7).

---

## 9. Keyboard shortcuts

**List view:**
```
/        Focus search
j or ↓   Next conversation
k or ↑   Previous conversation
Enter    Open conversation
x        Select / deselect
* a      Select all visible
a        Assign to me
e        Mark resolved
?        Show shortcut help
```

**Conversation view:**
```
Esc        Close conversation
r          Focus reply box
Shift+N    Internal note
a          Assign to me
Shift+A    Assign to someone else
t          Add tag
p          Mark pending
e          Mark resolved
s          Snooze
Shift+O    Create order
Shift+C    Open customer profile
```

**Global:**
```
Cmd/Ctrl+K       Command palette
Cmd/Ctrl+Enter   Send message
g then i         Go to Inbox
g then o         Go to Orders
g then c         Go to Customers
```

Shortcuts are disabled while a text input has focus, except `Cmd+Enter` and `Esc`.
Bindings live in `libs/core/domain/shortcuts.ts` so the help sheet and the handlers share
one table.

---

## 10. Bulk actions

```
Selection:
  Hover a row → checkbox appears
  Click, or press x
  * a selects all loaded rows
  Banner offers "Select all 43 matching this filter"

┌──────────────────────────────────────────────────────────────┐
│ 8 selected   [Assign ▼] [Status ▼] [Tag ▼] [More ▼]     [×]  │
└──────────────────────────────────────────────────────────────┘

[Assign ▼]   Assign to me · Assign to agent... · Round-robin to team · Unassign
[Status ▼]   Open · Pending · Resolved
[Tag ▼]      Add tag... · Remove tag...
[More ▼]     Send template · Mark read/unread · Archive · Export CSV
```

`POST /conversations/bulk { action: BulkActions.*, conversationIds | filter, params }`.
"Select all matching this filter" sends the filter, not ids, and the server caps it at
`BulkLimits.MAX_ITEMS` (500). Bulk actions are audited (`BULK_ACTION_EXECUTED`).

**Confirmation rules:**
```
< 10 items and reversible   → no dialog, toast with Undo
>= 10 items, or costly      → dialog with a preview of what will change
Destructive (bulk archive)  → dialog requiring typed confirmation
```

---

## 11. Destructive action confirmations

### 11.1 Risk tiers

```
CRITICAL — always requires typing a confirmation phrase
  Delete organization
  Delete store
  Revoke all plugin access
  Revoke an API key

HIGH — configurable per store, default on
  Delete customer
  Cancel order with an existing shipment
  Disconnect a channel
  Remove a team member
  Delete a routing rule

MODERATE — configurable per user
  Archive conversation
  Reassign a conversation already assigned to someone else
  Edit customer identity fields

LOW — Undo toast, no dialog
  Add or remove a tag
  Send a message
  Create an order
  Change conversation status
```

The tier per action is `DestructiveActionTiers` in `libs/core/domain/safety-constants.ts`.

### 11.2 Settings

Stored in `StoreSettings.safety` (validated by `safetySettingsSchema`).

```
Settings → Store → Safety & confirmations

High-risk actions
  [x] Confirm before deleting a customer
  [x] Confirm before disconnecting a channel
  [x] Confirm before removing a team member
  Apply to roles: [x] Agent  [x] Supervisor  [ ] Admin

Moderate-risk actions
  (o) Show confirmation dialog
  ( ) Toast with Undo
  ( ) No confirmation
```

---

## 12. Multi-store switching and URL structure

```
[Logo]  Store: Principal ▼

┌──────────────────────────────────────┐
│ Switch store                         │
├──────────────────────────────────────┤
│ Current                              │
│ • Principal              Admin       │
│   12 open conversations              │
├──────────────────────────────────────┤
│ Organization: Mi Empresa             │
│ ○ Tienda Escalón         Agent       │
│   5 open conversations               │
│ ○ Tienda Santa Ana       Agent       │
│   2 open conversations               │
├──────────────────────────────────────┤
│ [Manage stores]                      │
└──────────────────────────────────────┘
```

**URL structure.** Everything tenant-scoped lives under the store **id** (slugs are only
unique per organization, ids are global, and a shared link must open the right store for a
user who belongs to several organizations):

```typescript
// libs/api-client/src/app-paths.ts — the only place frontend paths are built.
// Notification.actionPath, search hits and the PWA manifest all use these.
export const AppPaths = {
  login: '/login',
  onboarding: '/onboarding',
  store: {
    inbox: (storeId: string) => `/s/${storeId}/inbox`,
    conversation: (storeId: string, conversationId: string) => `/s/${storeId}/inbox/${conversationId}`,
    customers: (storeId: string) => `/s/${storeId}/customers`,
    customer: (storeId: string, customerId: string) => `/s/${storeId}/customers/${customerId}`,
    orders: (storeId: string) => `/s/${storeId}/orders`,
    order: (storeId: string, orderId: string) => `/s/${storeId}/orders/${orderId}`,
    newOrder: (storeId: string) => `/s/${storeId}/orders/new`,
    products: (storeId: string) => `/s/${storeId}/products`,
    analytics: (storeId: string) => `/s/${storeId}/analytics`,
    settings: (storeId: string, section: StoreSettingsSection = 'general') => `/s/${storeId}/settings/${section}`,
    exportDownload: (storeId: string, exportId: string) => `/s/${storeId}/exports/${exportId}`,
  },
  org: {
    billing: '/org/billing',
    usage: '/org/usage',
    stores: '/org/stores',
    auditLog: '/org/audit-log',
    referrals: '/org/referrals',
    compliance: '/org/compliance',
  },
  account: {
    profile: '/account/profile',
    preferences: '/account/preferences',
    notifications: '/account/notifications',
    security: '/account/security',
  },
} as const
```

- The `s/[storeId]/layout.tsx` validates membership server-side and sets the
  `X-Store-Id` header on the `apiClient` for every request under it (`TDD_01` §3.2).
- The last store is remembered in `localStorage` (`StorageKeys.LAST_STORE_ID`); `/` redirects
  to it, or to the first membership, or to onboarding when there is none.
- Permissions are per-membership: the same user can be Admin in one store
  and Agent in another. The UI hides what the current role cannot access.
- Cross-store notifications are opt-in per user (`UserNotificationSettings`).

---

## 13. Settings structure

```
MY ACCOUNT (user scope, /account/*)
├─ Profile (name, avatar, locale)
├─ Preferences (timezone, density)
├─ Notifications (TDD_06 §9)
└─ Security (password, active sessions with revoke, connected Google account)

STORE (store scope, /s/:storeId/settings/*)
├─ General (name, timezone, currency, locale)
├─ Channels (connections: connect / test / disconnect — TDD_10 §10)
├─ Plugins (integrations and marketplace, TDD_10 §6)
├─ Team
│  ├─ Members
│  ├─ Roles (custom roles, PlanFeatures.CUSTOM_ROLES)
│  └─ Invitations (pending, resend, revoke)
├─ Routing (RoutingRule list, drag to reorder priority)
├─ Business hours (+ away message snippet)
├─ Tags
├─ Snippets (with "approved for AI" toggle, TDD_12 §13)
├─ Inbox behavior (StoreSettings: resolve flow, reopen window, auto-archive, load threshold)
├─ Safety & confirmations
├─ AI features (TDD_12 §10)
├─ Data retention
├─ Webhooks (+ delivery log)
└─ API keys

ORGANIZATION (org scope, /org/*)
├─ Billing (TDD_11 §6)
├─ Usage (conversations, seats, stores, channels, Chispas)
├─ Stores (create, rename, delete — ORG_MANAGE_STORES)
├─ Audit log
├─ Compliance (DSR requests, manual review queue — ORG_MANAGE_COMPLIANCE)
└─ Referrals
```

2FA for platform users is a Phase 2 item; Google sign-in is the recommended path for
accounts that need a second factor today.

---

## 14. Onboarding

```
Signup (creates User + Organization on the Free tier)
  → email verification (mandatory)
  → wizard

Step 1  Store name, timezone, currency, locale          → POST /organizations/current/stores
Step 2  Connect first channel                            → Settings → Channels flow (TDD_10 §10)
        Free tier: the web widget (embed snippet shown right here)
        Growth+:   WhatsApp / Instagram / Messenger
Step 3  Invite team (bulk emails, one role for all)      → POST /settings/team/members ×N
Step 4  Confirmation

        Store created
        Web widget connected — paste the snippet into your site
        2 invitations sent

        Next steps:
        • Send a test message
        • Add your products
        • Configure routing

        [Go to inbox]
```

**Email verification is mandatory.** Login before verification returns
`AUTH_EMAIL_NOT_VERIFIED` and redirects to a "check your email" page with a
rate-limited resend option.

**Invitations require acceptance.** No `Membership` exists until the invitee accepts
(`TDD_07` §5.3). Nobody is added to a store without consent.

---

## 15. Internationalization

### 15.1 Scope

```
Phase 1 locales: es (default), en
Phase 2:         pt-BR
RTL:             not required

Three layers:
  1. Product UI (agents)                → fully translated (next-intl)
  2. Customer-facing system copy        → translated per Customer.locale ?? Store.defaultLocale
     (order confirmations, CSAT prompt, AI-labelled replies, widget UI)
  3. Customer content                   → never translated, stored as written
```

### 15.2 Constants

```typescript
// libs/core/i18n/locales.ts
export const Locales = {
  ES: 'es',
  EN: 'en',
  PT_BR: 'pt-BR',
} as const

export type Locale = typeof Locales[keyof typeof Locales]

export const DEFAULT_LOCALE: Locale = Locales.ES
export const SUPPORTED_LOCALES: readonly Locale[] = [Locales.ES, Locales.EN]
export const SOURCE_LOCALE: Locale = Locales.EN          // Message files are authored in English

export const LocaleLabels: Record<Locale, string> = {
  [Locales.ES]: 'Español',
  [Locales.EN]: 'English',
  [Locales.PT_BR]: 'Português (Brasil)',
}
```

`SOURCE_LOCALE` (English) is what developers write; `DEFAULT_LOCALE` (Spanish) is what
users see when they have no preference. Both are complete at all times (CI check §15.6).

### 15.3 Message structure

Namespaced to mirror feature modules. Enum-derived keys (`conversations.status.*`,
`orders.status.*`, `errors.*`, `notifications.*`) are generated from the constants by
`scripts/generate-i18n-keys.ts` so a new enum value without a translation fails CI.

```json
{
  "common": {
    "save": "Guardar",
    "cancel": "Cancelar",
    "delete": "Eliminar",
    "confirm": "Confirmar",
    "loading": "Cargando...",
    "noResults": "Sin resultados"
  },
  "inbox": {
    "title": "Bandeja de entrada",
    "filters": {
      "all": "Todas",
      "mine": "Mías",
      "unassigned": "Sin asignar"
    },
    "conversationCount": "{count, plural, =0 {Sin conversaciones} one {# conversación} other {# conversaciones}}",
    "composer": {
      "placeholder": "Escribe un mensaje...",
      "windowExpired": "La ventana de 24 horas expiró. Envía una plantilla aprobada.",
      "aiHandling": "La IA está atendiendo esta conversación — {turnsLeft} turnos restantes"
    }
  },
  "conversations": {
    "status": { "OPEN": "Abierta", "PENDING": "Pendiente", "RESOLVED": "Resuelta", "ARCHIVED": "Archivada", "SNOOZED": "Pospuesta", "SPAM": "Spam" }
  },
  "orders": {
    "status": {
      "CONFIRMED": "Confirmado",
      "PREPARING": "Preparando",
      "SHIPPED": "Enviado",
      "DELIVERED": "Entregado",
      "CANCELLED": "Cancelado",
      "RETURNED": "Devuelto"
    },
    "total": "Total: {amount}"
  },
  "notifications": {
    "conversation": {
      "assigned": { "title": "Conversación asignada", "body": "{customerName} · {channel}" },
      "mentioned": { "title": "{authorName} te mencionó en una nota", "body": "{preview}" }
    },
    "export": { "ready": { "title": "Exportación lista", "body": "{filename}" } }
  },
  "errors": {
    "AUTH_INVALID_CREDENTIALS": "Correo o contraseña incorrectos",
    "TENANT_ACCESS_DENIED": "No tienes acceso a esta tienda",
    "CHANNEL_WINDOW_EXPIRED": "La ventana de mensajería expiró",
    "QUOTA_SEATS_EXCEEDED": "Alcanzaste el límite de usuarios de tu plan"
  }
}
```

Amounts are formatted with `formatCurrency` (§15.5) **before** interpolation, so message
files never hardcode a currency.

### 15.4 Error translation

The backend returns codes; the frontend translates them. The error message key
is exactly the `ErrorCode`.

```typescript
export function useErrorMessage() {
  const t = useTranslations('errors')

  return (error: ApiError): string =>
    t.has(error.code) ? t(error.code, error.metadata) : t(ErrorCodes.INTERNAL_ERROR)
}
```

### 15.5 Formatting

```typescript
// Currency is a store property; locale is a user property
export function formatCurrency(amountCents: number, currency: CurrencyCode, locale: Locale): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountCents / 100)
}

// Timestamps stored in UTC, displayed in the store timezone
// unless the user overrides it in their preferences
export function formatDateTime(
  date: Date,
  store: { timezone: string },
  user: { timezone?: string },
  locale: Locale
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: user.timezone ?? store.timezone
  }).format(date)
}
```

### 15.6 Translation workflow

```
1. Developer adds the key to apps/web/messages/en.json (SOURCE_LOCALE)
2. CI fails if any supported locale is missing a key present in en.json,
   or if en.json is missing a generated enum key
3. Keys sync to the translation platform
4. Translators complete
5. Automated PR back to the repo
```

```typescript
// scripts/validate-translations.ts — runs in CI (pnpm validate:translations) and lint-staged
import { readFile } from 'node:fs/promises'
import { Locales, SUPPORTED_LOCALES, SOURCE_LOCALE } from '@platform/core-domain/i18n'
import { generatedI18nKeys } from './generate-i18n-keys'

const MESSAGES_DIR = new URL('../apps/web/messages/', import.meta.url)

async function loadKeys(locale: string): Promise<Set<string>> {
  const raw = await readFile(new URL(`${locale}.json`, MESSAGES_DIR), 'utf8')
  return new Set(flattenKeys(JSON.parse(raw) as Record<string, unknown>))
}

const sourceKeys = await loadKeys(SOURCE_LOCALE)
const missingGenerated = generatedI18nKeys().filter(k => !sourceKeys.has(k))
if (missingGenerated.length) {
  console.error(`[${SOURCE_LOCALE}] missing ${missingGenerated.length} enum-derived keys:\n  ${missingGenerated.join('\n  ')}`)
  process.exitCode = 1
}

for (const locale of SUPPORTED_LOCALES) {
  if (locale === Locales.EN) continue
  const localeKeys = await loadKeys(locale)
  const missing = [...sourceKeys].filter(k => !localeKeys.has(k))
  if (missing.length) {
    console.error(`[${locale}] missing ${missing.length} keys:\n  ${missing.join('\n  ')}`)
    process.exitCode = 1
  }
}
```

(`console.*` is allowed in `scripts/**`, `TDD_14` §6.)

---

## 16. Mobile and PWA

### 16.1 Decision: PWA in Phase 1

**Why:** the responsive web app already exists, Web Push is already implemented,
no app store review cycle, instant deploys. Warehouse and delivery staff use
the app occasionally rather than all day.

**Accepted limitations:**
- iOS Web Push requires iOS 16.4+ and "Add to Home Screen"
- Camera access through file input rather than a native picker
- No access to device contacts

**Migrate to React Native when:** more than 30% of usage is mobile, or agents
need the app open all day with reliable background delivery.

### 16.2 Manifest

Store-scoped paths cannot be hardcoded in the manifest; `/` resolves to the last store
(§12), which is what `start_url` and the shortcuts rely on.

```json
{
  "name": "Platform — Omnichannel Inbox",
  "short_name": "Platform",
  "start_url": "/?source=pwa",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#ffffff",
  "theme_color": "#0f172a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Inbox", "url": "/?go=inbox" },
    { "name": "Orders", "url": "/?go=orders" },
    { "name": "Create order", "url": "/?go=new-order" }
  ]
}
```

### 16.3 Service worker caching

One service worker, built by Serwist from `apps/web/sw.ts` (push handlers in `TDD_06` §7.2
live in the same file).

```typescript
// apps/web/sw.ts (caching section)
import { Serwist, NetworkFirst, CacheFirst, StaleWhileRevalidate, ExpirationPlugin } from 'serwist'
import { webEnv } from './lib/env'

const apiOrigin = new URL(webEnv.NEXT_PUBLIC_API_URL).origin

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  runtimeCaching: [
    // App shell: network first with a 3s timeout, fall back to cache
    { matcher: ({ request }) => request.mode === 'navigate',
      handler: new NetworkFirst({ cacheName: 'pages', networkTimeoutSeconds: 3 }) },

    // Static assets: cache first (content-hashed, immutable)
    { matcher: ({ request }) => ['style', 'script', 'font'].includes(request.destination),
      handler: new CacheFirst({ cacheName: 'static', plugins: [new ExpirationPlugin({ maxAgeSeconds: 31_536_000 })] }) },

    // Public images only (icons, product thumbnails served from the app origin)
    { matcher: ({ request, url }) => request.destination === 'image' && url.origin === self.location.origin,
      handler: new StaleWhileRevalidate({ cacheName: 'images', plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 2_592_000 })] }) },

    // API (cross-origin): never cached. Signed S3 URLs: never cached (they expire).
    { matcher: ({ url }) => url.origin === apiOrigin, handler: new NetworkOnly() },
  ],
})
serwist.addEventListeners()
```

Offline message composition is handled by the offline queue (`TDD_06` §4), not by the
service worker.

### 16.4 Responsive layout

```
Desktop  >= 1024px   Three columns simultaneously
Tablet   768-1023px  Two columns, customer panel in a drawer
Mobile   < 768px     Single column, stack navigation

Mobile navigation:
  [List] → tap → [Conversation] → tap → [Customer]
            ← back              ← back
```

```tsx
type MobileView = 'list' | 'conversation' | 'customer'

export function InboxLayout() {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [view, setView] = useState<MobileView>('list')

  if (!isMobile) return <ThreeColumnLayout />

  return (
    <MobileStack view={view} onNavigate={setView}>
      {view === 'list' && <ConversationList onSelect={() => setView('conversation')} />}
      {view === 'conversation' && (
        <ActiveConversation
          onBack={() => setView('list')}
          onOpenCustomer={() => setView('customer')}
        />
      )}
      {view === 'customer' && <CustomerPanel onBack={() => setView('conversation')} />}
    </MobileStack>
  )
}
```

### 16.5 Mobile composer

```tsx
<div className="sticky bottom-0 border-t bg-background p-2 pb-[env(safe-area-inset-bottom)]">
  <div className="flex items-end gap-2">
    <Button variant="ghost" size="icon" onClick={openAttachmentSheet} aria-label={t('inbox.composer.attach')}>
      <Paperclip className="h-5 w-5" />
    </Button>
    <TextareaAutosize
      maxRows={5}
      enterKeyHint="send"
      className="flex-1 resize-none rounded-2xl border px-4 py-2"
      placeholder={t('inbox.composer.placeholder')}
    />
    <Button size="icon" className="rounded-full" onClick={handleSend} aria-label={t('inbox.composer.send')}>
      <Send className="h-5 w-5" />
    </Button>
  </div>
</div>
```

`pb-[env(safe-area-inset-bottom)]` handles the iPhone home indicator; `bg-background` is the
theme token, never a literal color.

**Camera capture:**
```tsx
<input type="file" accept="image/*" capture="environment" className="hidden" ref={cameraRef} />
<Button onClick={() => cameraRef.current?.click()}>
  <Camera className="h-5 w-5" />
  {t('inbox.composer.takePhoto')}
</Button>
```

### 16.6 React Native path (Phase 2)

```
apps/mobile/          React Native with Expo

Shared with web (this is what makes it viable):
  libs/core-domain/*  Types, constants, validation schemas
  libs/api-client/    Same HTTP client surface, AppPaths, QueryKeys
```

Native push providers (Expo/FCM/APNs) are added to `PushService` and `PushSubscription`
when this phase starts — not before (`TDD_06` §7.1).

---

## 17. Accessibility

- All interactive elements reachable by keyboard
- Visible focus indicators, never `outline: none` without a replacement
- ARIA labels on all icon-only buttons
- Colour is never the only signal — status badges include text
- Minimum contrast ratio 4.5:1 for body text
- Radix primitives provide correct roles and focus management out of the box
- `@storybook/addon-a11y` (`TDD_01` §2.4) runs against every component story
- Screen reader announcements for realtime events (new message, assignment)

---

## 18. Empty and error states

Every list and panel has a designed empty state, never a blank area. Keys live under
`emptyStates.*`.

```
No conversations                      (emptyStates.inbox)
  Icon: Inbox
  "No conversations yet"
  "Messages from your connected channels will appear here."
  [Connect a channel]  (if none connected)

No search results                     (emptyStates.search)
  Icon: SearchX
  "No results for '{query}'"
  "Try a different search term."

Connection lost                       (emptyStates.connectionLost)
  Red banner at the top
  "Connection lost. Retrying..."
  Messages composed while offline are queued and sent on reconnect.

Permission denied                     (emptyStates.permissionDenied)
  Icon: Lock
  "You do not have access to this"
  "Ask an administrator to grant the required permission."

Quota reached                         (emptyStates.quotaReached)
  Icon: AlertTriangle
  "Conversation limit reached"
  "New conversations are paused until your next billing period. Upgrade your plan to continue."
  [View plans]
```
