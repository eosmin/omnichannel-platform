import { z } from 'zod'

import {
  CHANNEL_ID_PATTERN,
  ChannelConnectFieldLimits,
  ChannelManifestLimits,
  ChannelPluginScopes,
  isOfficialChannelId,
  isPlainDescriptorText,
  type LocalizedText,
  PluginCatalogTypes,
  PluginManifestLimits,
  PluginWidgetLimits,
  pluginWidgetManifestSchema,
  PluginPricingModels,
  readLocalizedText,
  ManifestChannelCapabilities,
  RESERVED_CONNECT_FIELD_KEYS,
  WebhookHeaders
} from '@platform/core/domain'
import { type EventName, Events } from '@platform/core/events'
import { isAcceptableCommandsUrl, isWellFormedPublicHttpsUrl } from '@platform/core/url-safety'
import { PluginEventScopes, type PluginScope, PluginScopes } from '@platform/plugins/sdk'

// The manifest of an integration plugin, as the owner pastes it (TDD_10 §6.1, `MVP_TRIM_CHECKLIST.md` §7, D10). Nothing in
// it is trusted: every key is named (a key that is not here is refused, so a document cannot carry what no code reads),
// every text and list has a ceiling, and every address is checked for its shape. The addresses are checked again, against
// the network, by whoever calls them (the install challenge, every delivery): a name can lead anywhere later.
//
// What it refuses on purpose, each with the step that will accept it:
// - `type: "channel"` is accepted with its `channel` block (TDD_10 §6.7.2); an integration plugin carries neither the
//   block nor `capabilities`, and a channel plugin carries both, with the two channel scopes.
// - `pricing.model` other than `free`: paid and plan-gated plugins are Phase 2 (`MVP_TRIM_CHECKLIST.md` §7).
// - a scope that does not exist: a scope is added with the first route that uses it.

const PLAIN_ID = new RegExp(CHANNEL_ID_PATTERN)
// Up to nine digits a part: a number that a double cannot tell from its neighbour is not a version
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*$/
// Headers the transport, a proxy or the platform's own request sets: a signature header that is one of them would be
// overwritten, would break the request or would clobber what the receiver relies on
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'user-agent',
  'accept',
  'accept-encoding',
  'date',
  'forwarded',
  'origin',
  'referer',
  // The headers the platform sets on every delivery: one of them as the signature header would be overwritten by the event or
  // the delivery id, or would overwrite them
  WebhookHeaders.EVENT,
  WebhookHeaders.DELIVERY
])
const isReservedHeader = (name: string): boolean => {
  const lower = name.toLowerCase()
  return (
    RESERVED_HEADERS.has(lower) ||
    lower.startsWith('proxy-') ||
    lower.startsWith('sec-') ||
    lower.startsWith('x-forwarded-')
  )
}
const EMAIL = /^[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/

const EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(Events))
const SCOPES: ReadonlySet<string> = new Set(Object.values(PluginScopes))

// A text that is only text: no markup, no control character, trimmed, within its ceiling
const plainText = (max: number) =>
  z.string().refine(value => isPlainDescriptorText(value, max), { message: 'plain text expected' })

const urlOf = (accepts: (raw: string) => boolean) =>
  z
    .string()
    .max(PluginManifestLimits.URL_MAX_LENGTH)
    .refine(accepts, { message: 'an https address on the public internet' })
const publicUrl = urlOf(isWellFormedPublicHttpsUrl)

// The reader of a localized text copies es and en and leaves the rest, so a third language would be dropped without a word: the
// manifest refuses it instead, as it refuses a key that no code reads
function hasOnlyTheTwoLanguages(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true
  return Object.keys(value).every(key => key === 'es' || key === 'en')
}

// The name in each language the interface speaks (es and en). Read once and copied: what is stored is what was checked.
const localizedText = (max: number) =>
  z.unknown().transform((value, ctx): LocalizedText => {
    if (!hasOnlyTheTwoLanguages(value)) {
      ctx.addIssue({ code: 'custom', message: 'only es and en are accepted' })
      return z.NEVER
    }
    const text = readLocalizedText(value, max)
    if (text === null) {
      ctx.addIssue({ code: 'custom', message: 'a plain text in es and en' })
      return z.NEVER
    }
    return text
  })
const localizedName = localizedText(PluginManifestLimits.NAME_MAX_LENGTH)

const author = z.strictObject({
  name: plainText(PluginManifestLimits.NAME_MAX_LENGTH),
  email: z.string().max(PluginManifestLimits.EMAIL_MAX_LENGTH).regex(EMAIL),
  url: publicUrl.optional()
})

const webhooks = z.strictObject({
  endpoint: publicUrl,
  events: z
    .array(
      z
        .string()
        .refine((name): name is EventName => EVENT_NAMES.has(name), { message: 'unknown event' })
        // Only what can be sent: an event with no scope or that a store cannot follow would
        // be a subscription that never fires, with no word of why
        .refine(name => Object.hasOwn(PluginEventScopes, name), {
          message: 'an event a plugin is not sent'
        })
    )
    .min(1)
    .max(PluginManifestLimits.MAX_WEBHOOK_EVENTS)
    .refine(list => new Set(list).size === list.length, { message: 'repeated event' }),
  signatureHeader: z
    .string()
    .max(PluginManifestLimits.HEADER_MAX_LENGTH)
    .regex(HEADER_NAME)
    .refine(name => !isReservedHeader(name), { message: 'a header the transport sets' })
})

// The limits of a widget are the reader's (`PluginWidgetLimits`, the ones `pluginWidgetManifestSchema` applies when the
// panel is listed): one set of numbers, so that a manifest that registers is a manifest whose widgets are shown. The sizes stay required here (the reader takes them as optional): stricter on purpose
const widgetSize = (min: number, max: number) => z.number().int().min(min).max(max)

// Read and kept here; drawn by Step 5.7 (plugin widgets)
const widget = z.strictObject({
  id: z.string().max(PluginWidgetLimits.WIDGET_ID_MAX_LENGTH).regex(PLAIN_ID),
  name: plainText(PluginWidgetLimits.WIDGET_NAME_MAX_LENGTH),
  defaultWidth: widgetSize(
    PluginWidgetLimits.WIDGET_WIDTH_MIN,
    PluginWidgetLimits.WIDGET_WIDTH_MAX
  ),
  defaultHeight: widgetSize(
    PluginWidgetLimits.WIDGET_HEIGHT_MIN,
    PluginWidgetLimits.WIDGET_HEIGHT_MAX
  ),
  refreshInterval: z
    .number()
    .int()
    .min(PluginWidgetLimits.REFRESH_INTERVAL_MIN_MS)
    .max(PluginWidgetLimits.REFRESH_INTERVAL_MAX_MS)
    .optional()
})

const CHANNEL_CAPABILITIES: ReadonlySet<string> = new Set(ManifestChannelCapabilities)

// The text of a connection field, in each language the interface speaks (the web draws it when it has no message of
// its own for the field, `fieldLabelOf`)
const fieldLabel = localizedText(PluginManifestLimits.FIELD_LABEL_MAX_LENGTH)

// A field of the form that connects an account of the provider, as the registry keeps it (`ConnectFieldSnapshot`),
// except that a third party names it with a text and never with a message key of the web app
const connectField = z.strictObject({
  key: z
    .string()
    .regex(ChannelConnectFieldLimits.KEY_PATTERN)
    .refine(key => !RESERVED_CONNECT_FIELD_KEYS.has(key), {
      message: 'a key the platform reserves'
    }),
  label: fieldLabel,
  secret: z.boolean(),
  required: z.boolean(),
  multiple: z.boolean()
})

const channelBlock = z.strictObject({
  // Shown as it is: a plugin does not translate its name
  label: plainText(ChannelManifestLimits.LABEL_MAX_LENGTH),
  // Checked for its shape here; resolved against the network at every call
  commandsUrl: urlOf(isAcceptableCommandsUrl),
  // Absent: the channel has no window. `requiresTemplateWhenClosed` is not accepted: a remote plugin sends no template.
  messagingWindow: z
    .strictObject({
      hours: z
        .number()
        .int()
        .min(ChannelManifestLimits.MIN_WINDOW_HOURS)
        .max(ChannelManifestLimits.MAX_WINDOW_HOURS)
    })
    .optional(),
  connectFields: z
    .array(connectField)
    .max(ChannelConnectFieldLimits.MAX_FIELDS)
    .refine(list => new Set(list.map(field => field.key)).size === list.length, {
      message: 'repeated field key'
    })
    .optional()
})

export const pluginManifestSchema = z
  .strictObject({
    id: z.string().regex(PLAIN_ID),
    version: z.string().max(PluginManifestLimits.VERSION_MAX_LENGTH).regex(SEMVER),
    name: plainText(PluginManifestLimits.NAME_MAX_LENGTH),
    // The name in each language, for the interface; `name` is what the other places show
    names: localizedName.optional(),
    description: plainText(PluginManifestLimits.DESCRIPTION_MAX_LENGTH),
    author,
    type: z.enum([PluginCatalogTypes.INTEGRATION, PluginCatalogTypes.CHANNEL]),
    icon: publicUrl.optional(),
    pricing: z.strictObject({ model: z.literal(PluginPricingModels.FREE) }),
    // What a channel can do (TDD_10 §6.7.2); only a channel plugin has them
    capabilities: z
      .array(
        z.string().refine(capability => CHANNEL_CAPABILITIES.has(capability), {
          message: 'a capability a remote channel cannot declare'
        })
      )
      .max(CHANNEL_CAPABILITIES.size)
      .refine(list => new Set(list).size === list.length, { message: 'repeated capability' })
      .optional(),
    channel: channelBlock.optional(),
    scopes: z
      .array(z.string().refine((scope): scope is PluginScope => SCOPES.has(scope)))
      .max(SCOPES.size)
      .refine(list => new Set(list).size === list.length, { message: 'repeated scope' }),
    webhooks: webhooks.optional(),
    ui: z.strictObject({ settings: publicUrl.optional(), widget: publicUrl.optional() }).optional(),
    widgets: z
      .array(widget)
      .min(1)
      .max(PluginWidgetLimits.WIDGETS_PER_PLUGIN_MAX)
      .refine(list => new Set(list.map(item => item.id)).size === list.length, {
        message: 'repeated widget id'
      })
      .optional(),
    limits: z
      .strictObject({
        maxRequestsPerMinute: z
          .number()
          .int()
          .min(PluginManifestLimits.MIN_REQUESTS_PER_MINUTE)
          .max(PluginManifestLimits.MAX_REQUESTS_PER_MINUTE)
          .optional(),
        maxWebhooksPerDay: z
          .number()
          .int()
          .min(PluginManifestLimits.MIN_WEBHOOKS_PER_DAY)
          .max(PluginManifestLimits.MAX_WEBHOOKS_PER_DAY)
          .optional()
      })
      .optional(),
    legal: z
      .strictObject({
        privacyPolicy: publicUrl.optional(),
        termsOfService: publicUrl.optional()
      })
      .optional()
  })
  .superRefine((manifest, ctx) => {
    if (manifest.type !== PluginCatalogTypes.CHANNEL) {
      for (const key of ['channel', 'capabilities'] as const) {
        if (manifest[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'only a channel plugin has it' })
        }
      }
      // The two scopes of a channel are the channel's: an integration plugin that held one could act as a channel
      for (const scope of Object.values(ChannelPluginScopes)) {
        if (manifest.scopes.includes(scope)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scopes'],
            message: `${scope} is for a channel plugin`
          })
        }
      }
      return
    }
    if (manifest.channel === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['channel'],
        message: 'a channel plugin has a channel block'
      })
    }
    // The id is the channel id: never one of the platform's (the table is checked by whoever stores it)
    if (isOfficialChannelId(manifest.id)) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: 'the id of an official channel' })
    }
    for (const scope of Object.values(ChannelPluginScopes)) {
      if (!manifest.scopes.includes(scope)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scopes'],
          message: `a channel plugin holds ${scope}`
        })
      }
    }
  })
  // A widget needs the address its iframe loads
  .refine(manifest => manifest.widgets === undefined || manifest.ui?.widget !== undefined, {
    path: ['ui', 'widget'],
    message: 'a plugin with widgets names the address of its widget'
  })
  // What the list of widgets of an installation reads is parsed by the reader's own schema, which drops without a word what it
  // does not accept: a manifest is refused here for the same reasons (the address of the frame has no query, for one)
  .superRefine((manifest, ctx) => {
    if (manifest.widgets === undefined || manifest.ui?.widget === undefined) return
    const read = pluginWidgetManifestSchema.safeParse({
      ui: { widget: manifest.ui.widget },
      widgets: manifest.widgets
    })
    if (read.success) return
    for (const issue of read.error.issues) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })
    }
  })

export type PluginManifest = z.output<typeof pluginManifestSchema>

// The numbers of a version, to tell a newer manifest from an older one. Only the plain `major.minor.patch` the manifest
// accepts: anything else is not a version.
function versionParts(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version)
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

// Whether `next` is a higher version than `current`; false when either is not a version
export function isNewerVersion(next: string, current: string): boolean {
  const a = versionParts(next)
  const b = versionParts(current)
  if (a === null || b === null) return false
  for (let index = 0; index < 3; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x > y
  }
  return false
}

// What a stored manifest says about its webhooks: the events it follows and the header that carries the signature. Read from the
// row that was validated on registration, but read again defensively (a row is data, and a bad one must deliver nothing rather
// than throw in the middle of an event). The address is not here on purpose: a delivery goes to the one that passed the install
// challenge (`PluginInstallation.webhookEndpoint`), whatever a newer manifest says.
export interface ManifestWebhook {
  events: readonly string[]
  signatureHeader: string
}

// The cap of deliveries a day that the manifest declares (`limits.maxWebhooksPerDay`), read from a stored manifest the way
// `manifestWebhookOf` reads the block of webhooks: anything that is not a whole number in the accepted range is no cap
export function manifestMaxWebhooksPerDay(manifest: unknown): number | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const limits = (manifest as { limits?: unknown }).limits
  if (typeof limits !== 'object' || limits === null) return null
  const cap = (limits as { maxWebhooksPerDay?: unknown }).maxWebhooksPerDay
  return typeof cap === 'number' &&
    Number.isInteger(cap) &&
    cap >= PluginManifestLimits.MIN_WEBHOOKS_PER_DAY &&
    cap <= PluginManifestLimits.MAX_WEBHOOKS_PER_DAY
    ? cap
    : null
}

export function manifestWebhookOf(manifest: unknown): ManifestWebhook | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const block = (manifest as { webhooks?: unknown }).webhooks
  if (typeof block !== 'object' || block === null) return null
  const { events, signatureHeader } = block as { events?: unknown; signatureHeader?: unknown }
  if (!Array.isArray(events) || typeof signatureHeader !== 'string') return null
  if (
    signatureHeader.length > PluginManifestLimits.HEADER_MAX_LENGTH ||
    !HEADER_NAME.test(signatureHeader) ||
    isReservedHeader(signatureHeader)
  ) {
    return null
  }
  return {
    events: events.filter((event): event is string => typeof event === 'string'),
    signatureHeader
  }
}
