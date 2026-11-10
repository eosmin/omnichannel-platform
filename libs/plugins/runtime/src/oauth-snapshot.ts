import {
  type ChannelOAuthDescriptor,
  ChannelOAuthKinds,
  ChannelOAuthLimits,
  isDialogOrigin,
  LINKED_ACCOUNT_PLACEHOLDERS,
  parseAssetIdPattern,
  readLocalizedText
} from '@platform/core/domain'
import type { ChannelOAuth, ChannelPlugin } from '@platform/plugins/sdk'

import { contractViolation, printable } from './contract-rules'

const KINDS: readonly unknown[] = Object.values(ChannelOAuthKinds)
const FUNCTIONS = [
  'authorizationUrl',
  'exchangeCode',
  'grantedScopes',
  'listAssets',
  'credentialsFor'
] as const

// What the core keeps of a plugin's login: a copy of the DECLARATION taken once, when the plugin passed its
// contract. The scopes are frozen and the functions are the ones seen then, so a plugin that swaps them or
// grows its list afterwards cannot widen what the dialog asks for. The behaviour of the functions is the
// plugin's own: one that keeps state in the object they are bound to can still change what they do, and a
// plugin is code the owner reviews, not a sandbox.
export type ChannelOAuthSnapshot = {
  // What the page draws the login from (frozen), and the pattern of an account id, compiled
  readonly descriptor: ChannelOAuthDescriptor
  readonly assetId: RegExp
  // The plugin declared an address that is not the callback of this platform, so its login was turned off
  readonly redirectRefused: boolean
} & Pick<
  ChannelOAuth,
  | 'kind'
  | 'dialogOrigin'
  | 'providerName'
  | 'linkedAccount'
  | 'assetIdPattern'
  | 'scopes'
  | 'redirectUri'
  | 'authorizationUrl'
  | 'exchangeCode'
  | 'grantedScopes'
  | 'listAssets'
  | 'credentialsFor'
>

// A plugin with no login is the normal case (null). One that declares a login badly is refused at boot, like
// one that lacks a method: the permissions go into an address the person is sent to, so they are held to the
// shape of a permission name, and nothing about the declaration is printed (it is not trusted).
//
// `ceilingOf` answers, for the kind this very declaration has (read once, here), what the login may ask for: null for an official plugin (the code of the platform, which the
// owner reviews, holds only to the shape of a permission name), and for any other plugin the permissions that
// the official plugins with the same kind of login already ask for. A third party therefore cannot make the
// platform's app ask a person for ads, publishing or anything the official channels do not need, and the core
// names no provider to know it.
export function snapshotChannelOAuth(
  plugin: ChannelPlugin,
  id: string,
  ceilingOf: (kind: string) => ReadonlySet<string> | null,
  callbackUrl: string | undefined
): ChannelOAuthSnapshot | null {
  const declared: unknown = plugin.oauth
  if (declared === undefined) return null
  const refuse = (what: string): never => {
    throw contractViolation(`Plugin ${printable(id)} declares an invalid oauth ${what}`)
  }
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) refuse('block')
  const block = declared as Record<string, unknown>
  const kind = block['kind']
  if (!KINDS.includes(kind)) refuse('kind')
  const ceiling = ceilingOf(kind as string)
  const scopes = block['scopes']
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > ChannelOAuthLimits.MAX_SCOPES ||
    !scopes.every(
      (scope: unknown) => typeof scope === 'string' && ChannelOAuthLimits.SCOPE_PATTERN.test(scope)
    ) ||
    new Set<unknown>(scopes).size !== scopes.length ||
    (ceiling !== null && !scopes.every((scope: string) => ceiling.has(scope)))
  ) {
    refuse('scopes list')
  }
  // The address the code of a person is sent to: none (the login is off) or exactly the callback of this
  // platform, which the registry was given. Compared as a string, so a look-alike host, another port or scheme,
  // a login in the address, another path, a query or a fragment are all a different string. An address that is
  // not that one never reaches the dialog: the login of THAT plugin is turned off and the registry says so in
  // its log, because a mismatch is a mistake of configuration (a tunnel that is not API_URL) and must not take
  // the webhooks and every other channel of the platform down with it. Something that is not text is a broken
  // declaration and is refused like any other.
  const declaredRedirect = block['redirectUri']
  if (declaredRedirect !== null && typeof declaredRedirect !== 'string') refuse('redirect address')
  const redirectRefused = declaredRedirect !== null && declaredRedirect !== callbackUrl
  const redirectUri = redirectRefused ? null : (declaredRedirect as string | null)
  const dialogOrigin = block['dialogOrigin']
  if (!isDialogOrigin(dialogOrigin)) refuse('dialog address')
  const providerName = readLocalizedText(block['providerName'])
  if (providerName === null) refuse('provider name')
  const linked = block['linkedAccount']
  let linkedAccount: ChannelOAuthDescriptor['linkedAccount'] = null
  if (linked !== null) {
    const raw = (typeof linked === 'object' && !Array.isArray(linked) ? linked : {}) as Record<
      string,
      unknown
    >
    const label = readLocalizedText(raw['label'], undefined, LINKED_ACCOUNT_PLACEHOLDERS)
    const missingLabel = readLocalizedText(raw['missingLabel'])
    // Each value is read once: what is kept is what was checked
    const required = raw['required']
    if (typeof required !== 'boolean' || label === null || missingLabel === null) {
      refuse('linked account')
    }
    linkedAccount = Object.freeze({
      required: required as boolean,
      label: label as NonNullable<typeof label>,
      missingLabel: missingLabel as NonNullable<typeof missingLabel>
    })
  }
  const assetIdPattern = block['assetIdPattern']
  const assetId = parseAssetIdPattern(assetIdPattern)
  if (assetId === null) refuse('account id pattern')
  const functions = {} as Record<(typeof FUNCTIONS)[number], unknown>
  for (const name of FUNCTIONS) {
    const fn = block[name]
    if (typeof fn !== 'function') refuse(`${name} function`)
    functions[name] = (fn as (...args: unknown[]) => unknown).bind(declared)
  }
  return Object.freeze({
    descriptor: Object.freeze({
      dialogOrigin: dialogOrigin as string,
      providerName: providerName as NonNullable<typeof providerName>,
      linkedAccount,
      assetIdPattern: assetIdPattern as string
    }),
    assetId: assetId as RegExp,
    dialogOrigin: dialogOrigin as string,
    providerName: providerName as NonNullable<typeof providerName>,
    linkedAccount,
    assetIdPattern: assetIdPattern as string,
    kind: kind as ChannelOAuth['kind'],
    redirectUri,
    redirectRefused,
    scopes: Object.freeze([...(scopes as string[])]),
    authorizationUrl: functions.authorizationUrl as ChannelOAuth['authorizationUrl'],
    exchangeCode: functions.exchangeCode as ChannelOAuth['exchangeCode'],
    grantedScopes: functions.grantedScopes as ChannelOAuth['grantedScopes'],
    listAssets: functions.listAssets as ChannelOAuth['listAssets'],
    credentialsFor: functions.credentialsFor as ChannelOAuth['credentialsFor']
  })
}
