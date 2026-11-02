// What the settings page needs to draw the connect form of a channel (Step 3.6). A plugin declares
// its fields (`ChannelPlugin.connectFields`); the words are message keys the web app translates, and
// they are kept here so that `validate:translations` fails when a key has no text.

// The label of each field of the official channels. The key of a field and the key of its text are
// different things: `whatsapp.phoneNumberId` is the field, this is how the owner reads it.
export const ChannelConnectFieldKeys = {
  WHATSAPP_PHONE_NUMBER_ID: 'settings.channels.connect.whatsapp.phoneNumberId',
  WHATSAPP_BUSINESS_ACCOUNT_ID: 'settings.channels.connect.whatsapp.businessAccountId',
  WHATSAPP_ACCESS_TOKEN: 'settings.channels.connect.whatsapp.accessToken',
  INSTAGRAM_ACCESS_TOKEN: 'settings.channels.connect.instagram.accessToken',
  MESSENGER_ACCESS_TOKEN: 'settings.channels.connect.messenger.accessToken',
  WEB_WIDGET_SITE_ORIGINS: 'settings.channels.connect.web_widget.siteOrigins'
} as const

// A step the owner takes on the provider's side, which the platform cannot do for them. Shown on the
// view of a connection when the provider refused what the step enables.
export const ChannelSetupStepKeys = {
  MESSENGER_PROFILE_ACCESS: 'settings.channels.setup.messengerProfileAccess'
} as const

// The signed url the widget settings read the bucket host from: signing is local, nothing is sent
export const ConnectSrcProbe = {
  KEY: 'connect-src-probe',
  CONTENT_TYPE: 'text/plain',
  CONTENT_LENGTH: 1
} as const

// Names a field cannot take: `credentials` is a plain object, and these are members of every one
export const RESERVED_CONNECT_FIELD_KEYS: ReadonlySet<string> = new Set([
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf'
])

// A plugin is not trusted to be well formed (a remote one is written by a third party): the registry
// checks the declaration against these before it keeps it, and the page only sees what passed.
export const ChannelConnectFieldLimits = {
  MAX_FIELDS: 20,
  // How the plugin names the field in `credentials`
  KEY_PATTERN: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
  // A message key: dotted segments of letters, digits, `_` and `-`
  MESSAGE_KEY_PATTERN: /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/,
  MESSAGE_KEY_MAX_LENGTH: 120
} as const
