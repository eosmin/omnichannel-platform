import {
  ChannelOAuthKinds,
  ChannelOAuthLimits,
  MetaOAuth,
  MetaOAuthScopes
} from '@platform/core/domain'
import type { ChannelOAuth, ChannelPlugin } from '@platform/plugins/sdk'

import { contractViolation, printable } from './contract-rules'

const KINDS: readonly unknown[] = Object.values(ChannelOAuthKinds)
// The permissions a kind of login may ask for. A name outside the list is refused at boot, so that a plugin
// cannot make the platform's app ask a person for ads, publishing or anything else the channels do not need
// (the constants of `MetaOAuthScopes` are the whole list; adding a permission is a change of the core).
const SCOPES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  [ChannelOAuthKinds.META_FACEBOOK_LOGIN]: Object.values(MetaOAuthScopes)
}
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
export type ChannelOAuthSnapshot = Pick<
  ChannelOAuth,
  | 'kind'
  | 'scopes'
  | 'authorizationUrl'
  | 'exchangeCode'
  | 'grantedScopes'
  | 'listAssets'
  | 'credentialsFor'
>

// A plugin with no login is the normal case (null). One that declares a login badly is refused at boot, like
// one that lacks a method: the permissions go into an address the person is sent to, so they are held to the
// shape of a permission name, and nothing about the declaration is printed (it is not trusted).
export function snapshotChannelOAuth(
  plugin: ChannelPlugin,
  id: string
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
  const scopes = block['scopes']
  if (
    !Array.isArray(scopes) ||
    scopes.length === 0 ||
    scopes.length > ChannelOAuthLimits.MAX_SCOPES ||
    !scopes.every(
      (scope: unknown) => typeof scope === 'string' && MetaOAuth.SCOPE_PATTERN.test(scope)
    ) ||
    new Set<unknown>(scopes).size !== scopes.length ||
    !scopes.every((scope: string) => SCOPES_BY_KIND[kind as string]?.includes(scope))
  ) {
    refuse('scopes list')
  }
  const functions = {} as Record<(typeof FUNCTIONS)[number], unknown>
  for (const name of FUNCTIONS) {
    const fn = block[name]
    if (typeof fn !== 'function') refuse(`${name} function`)
    functions[name] = (fn as (...args: unknown[]) => unknown).bind(declared)
  }
  return Object.freeze({
    kind: kind as ChannelOAuth['kind'],
    scopes: Object.freeze([...(scopes as string[])]),
    authorizationUrl: functions.authorizationUrl as ChannelOAuth['authorizationUrl'],
    exchangeCode: functions.exchangeCode as ChannelOAuth['exchangeCode'],
    grantedScopes: functions.grantedScopes as ChannelOAuth['grantedScopes'],
    listAssets: functions.listAssets as ChannelOAuth['listAssets'],
    credentialsFor: functions.credentialsFor as ChannelOAuth['credentialsFor']
  })
}
