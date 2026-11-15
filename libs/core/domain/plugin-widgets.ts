import { z } from 'zod'

// Plugin widgets (TDD_10 §7): a third-party plugin draws a panel in the agent sidebar, in an iframe of
// its own origin. The page and the iframe talk over one MessageChannel port; these are the words they
// use and the shapes the api checks. Nothing here is a secret: the session token travels only over the
// port, and the plugin's API key never leaves the api.

// What the page and the frame say to each other. The frame never uses window.parent.postMessage for data.
export const PluginBridgeMessages = {
  // Page to frame, once, with the port attached
  INIT: 'platform.widget.init',
  // Page to frame, over the port: the session token, its lifetime and the context of the open conversation
  SESSION: 'platform.widget.session',
  // Frame to page, over the port, once, when the frame has taken the port: the page waits for it and shows a notice
  // when it does not come (`PluginWidgetTimings.INIT_TIMEOUT_MS`)
  READY: 'platform.widget.ready',
  // Frame to page, over the port
  REQUEST: 'platform.widget.request',
  // Page to frame, over the port
  RESPONSE: 'platform.widget.response'
} as const
export type PluginBridgeMessage = (typeof PluginBridgeMessages)[keyof typeof PluginBridgeMessages]

// The closed set of things a widget can ask the platform through the port. Each one reads from the
// conversation the widget was opened on and from nothing else; the scope each one needs is declared next
// to the plugin scopes (`PluginBridgeOperationScopes`, libs/plugins/sdk).
export const PluginBridgeOperations = {
  CONVERSATION_GET: 'conversation.get',
  CUSTOMER_GET: 'customer.get'
} as const
export type PluginBridgeOperation =
  (typeof PluginBridgeOperations)[keyof typeof PluginBridgeOperations]

// Why a request through the port was not answered with data; the widget reads the code
export const PluginBridgeFailures = {
  SCOPE_DENIED: 'scope_denied',
  SESSION_INVALID: 'session_invalid',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'not_found',
  FAILED: 'failed'
} as const
export type PluginBridgeFailure = (typeof PluginBridgeFailures)[keyof typeof PluginBridgeFailures]

export const PluginWidgetLimits = {
  // The session token lives five minutes; the page opens a new one before it ends (TDD_10 §7)
  SESSION_TTL_SECONDS: 300,
  // 256 bits of randomness, base64url
  TOKEN_BYTES: 32,
  TOKEN_MAX_LENGTH: 64,
  // What one session may ask through the port in a minute, whatever the plugin's own rate limit
  BRIDGE_REQUESTS_PER_MINUTE: 120,
  BRIDGE_WINDOW_SECONDS: 60,
  // Sessions one person may open for one installation in that window (the page renews every five minutes)
  SESSIONS_PER_MINUTE: 30,
  REQUEST_ID_MAX_LENGTH: 64,
  WIDGET_ID_MAX_LENGTH: 64,
  WIDGET_NAME_MAX_LENGTH: 60,
  WIDGET_URL_MAX_LENGTH: 2048,
  WIDGETS_PER_PLUGIN_MAX: 5,
  WIDGET_WIDTH_MIN: 200,
  WIDGET_WIDTH_MAX: 600,
  WIDGET_HEIGHT_MIN: 100,
  WIDGET_HEIGHT_MAX: 800,
  REFRESH_INTERVAL_MIN_MS: 5000,
  REFRESH_INTERVAL_MAX_MS: 3_600_000
} as const

// A host is first-party when it lives under the same parent domain as one of ours (the last two labels, which includes
// the host itself): a frame there could reach what the web app's cookies and storage hold. A trailing dot is the same
// host. It errs on the side of refusing: a plugin on `x.co.uk` is refused where our host ends in `.co.uk`. One rule for the
// api (what it lists and answers) and the web proxy (what it lets a page frame), so they cannot drift.
function parentDomainOf(host: string): string {
  return host.replace(/\.$/, '').split('.').slice(-2).join('.')
}

export function isPlatformHost(host: string, platformHosts: readonly string[]): boolean {
  return platformHosts.some(platformHost => parentDomainOf(host) === parentDomainOf(platformHost))
}

// How the page drives a frame (TDD_10 §7). Timings are the page's: the server's own limits are above.
export const PluginWidgetTimings = {
  // A frame that has not answered the INIT with a first request by now gets a notice instead of an empty box
  INIT_TIMEOUT_MS: 10_000,
  // The page asks for a new session this long before the old one ends, and tries again this often if it fails
  RENEW_MARGIN_MS: 60_000,
  RENEW_RETRY_MS: 15_000
} as const

// The origins a store's widgets are framed from, written by the page as a cookie for the proxy (the proxy has no
// session: the refresh cookie is all it sees) and read there to build `frame-src` for that store only. The cookie is
// the browser's own and is never trusted as more than a hint of what to allow in this browser: the proxy keeps only
// well-formed https origins that are not the platform's, and the api decides what a frame may ask.
export const PluginWidgetFrames = {
  COOKIE_PREFIX: 'platform_widget_frames_',
  // Origins joined by this character; it cannot appear in an origin
  COOKIE_SEPARATOR: ' ',
  COOKIE_MAX_AGE_SECONDS: 2_592_000,
  // At most one origin per plugin, and a store has few plugins
  ORIGINS_MAX: 20,
  // The proxy hands the origins it allowed to the document, so the page knows what its own policy permits: a request
  // header the proxy always sets (a client's own is overwritten) that the root layout writes into a meta tag
  ORIGINS_HEADER: 'x-plugin-frame-origins',
  ORIGINS_META_NAME: 'plugin-frame-origins',
  // Where the page remembers that it already reloaded for a new set of origins, so a store whose cookie cannot be
  // set (blocked cookies) reloads once and not forever
  RELOAD_MARK_PREFIX: 'platform.widget.frames.reload.'
} as const

// What the installation's `config` keeps for widgets: the ones the store chose to hide from the agents. Other keys
// of the config are kept as they are when this one changes.
export const pluginWidgetConfigSchema = z.looseObject({
  hiddenWidgets: z.array(z.string().max(PluginWidgetLimits.WIDGET_ID_MAX_LENGTH)).default([])
})
export type PluginWidgetConfig = z.infer<typeof pluginWidgetConfigSchema>

export const pluginWidgetVisibilitySchema = z.strictObject({ visible: z.boolean() })
export type PluginWidgetVisibilityBody = z.infer<typeof pluginWidgetVisibilitySchema>

// The query parameter that tells the frame which conversation it is drawn for (an id, never a token)
// and which of the plugin's widgets it is (one url serves them all)
export const PluginWidgetQuery = {
  CONVERSATION_ID: 'conversationId',
  WIDGET_ID: 'widgetId'
} as const

// The manifest's `ui.widget` and `widgets` (TDD_10 §6.1). The url is https, has no credentials and no
// fragment: the frame loads it with a query of ours. `pluginManifestSchema` (Step 5.6) composes this.
const widgetUrlSchema = z
  .url({ protocol: /^https$/ })
  .max(PluginWidgetLimits.WIDGET_URL_MAX_LENGTH)
  .refine(
    value => {
      const url = new URL(value)
      return url.username === '' && url.password === '' && url.hash === '' && url.search === ''
    },
    { message: 'a widget url has no credentials, no query and no fragment' }
  )

export const pluginWidgetDeclarationSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .max(PluginWidgetLimits.WIDGET_ID_MAX_LENGTH),
  name: z.string().trim().min(1).max(PluginWidgetLimits.WIDGET_NAME_MAX_LENGTH),
  defaultWidth: z
    .number()
    .int()
    .min(PluginWidgetLimits.WIDGET_WIDTH_MIN)
    .max(PluginWidgetLimits.WIDGET_WIDTH_MAX)
    .optional(),
  defaultHeight: z
    .number()
    .int()
    .min(PluginWidgetLimits.WIDGET_HEIGHT_MIN)
    .max(PluginWidgetLimits.WIDGET_HEIGHT_MAX)
    .optional(),
  refreshInterval: z
    .number()
    .int()
    .min(PluginWidgetLimits.REFRESH_INTERVAL_MIN_MS)
    .max(PluginWidgetLimits.REFRESH_INTERVAL_MAX_MS)
    .optional()
})
export type PluginWidgetDeclaration = z.infer<typeof pluginWidgetDeclarationSchema>

// Only the two keys a widget needs; the rest of the manifest is `pluginManifestSchema`'s
export const pluginWidgetManifestSchema = z.object({
  ui: z.object({ widget: widgetUrlSchema }),
  widgets: z
    .array(pluginWidgetDeclarationSchema)
    .min(1)
    .max(PluginWidgetLimits.WIDGETS_PER_PLUGIN_MAX)
    .refine(list => new Set(list.map(widget => widget.id)).size === list.length, {
      message: 'widget ids are unique'
    })
})
export type PluginWidgetManifest = z.infer<typeof pluginWidgetManifestSchema>

// The frame is untrusted: this is parsed with safeParse and a miss is dropped without an answer
export const pluginBridgeRequestSchema = z.strictObject({
  type: z.literal(PluginBridgeMessages.REQUEST),
  id: z.string().min(1).max(PluginWidgetLimits.REQUEST_ID_MAX_LENGTH),
  operation: z.enum([PluginBridgeOperations.CONVERSATION_GET, PluginBridgeOperations.CUSTOMER_GET])
})
export type PluginBridgeRequest = z.infer<typeof pluginBridgeRequestSchema>

export const pluginBridgeReadySchema = z.strictObject({
  type: z.literal(PluginBridgeMessages.READY)
})

// What the page posts to the frame over the port: the session and the context it was opened in. The token is the
// only secret in it and is only ever on the port; the conversation is named here and never taken from the frame.
export interface PluginBridgeSessionMessage {
  type: typeof PluginBridgeMessages.SESSION
  token: string
  expiresInSeconds: number
  widgetId: string
  conversationId: string
}

// The fields of a conversation and of its customer a widget may read: the minimum, never the avatar url,
// the caution reason, the addresses or the identities
export interface PluginBridgeConversation {
  id: string
  status: string
  channelType: string
  createdAt: string
  lastInboundAt: string | null
  tags: string[]
}

export interface PluginBridgeCustomer {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  locale: string | null
}

export type PluginBridgeResponse =
  | {
      type: typeof PluginBridgeMessages.RESPONSE
      id: string
      ok: true
      data: PluginBridgeConversation | PluginBridgeCustomer
    }
  | {
      type: typeof PluginBridgeMessages.RESPONSE
      id: string
      ok: false
      failure: PluginBridgeFailure
    }
