import type { ChannelOAuthKind } from '@platform/core/domain'

import type { ConnectInput } from './channel-types'

// What a provider's login (Step 7.8) needs from a plugin. The core owns everything that is about security:
// the `state`, the address the provider sends the browser back to, the exchange of the code for a token,
// the encryption of the session and the final call to `connect`. A plugin only knows its provider, so it
// holds no database, no environment and no redirect, and a plugin of a third party cannot get the state
// wrong because it never sees it.

// What the plugin is given: the token of the PERSON (not of an account), which the core holds only until
// the person picks an account. A plugin must not log it, store it or send it anywhere but the provider.
export interface OAuthUserContext {
  readonly userToken: string
}

// An account the person may connect, as the provider shows it
export interface OAuthAsset {
  // Opaque to the core: what `credentialsFor` is given back
  readonly id: string
  readonly name: string
  // The account of the channel this one links (the Instagram account of a Page), when there is one
  readonly linkedAccount: { readonly id: string; readonly username: string | null } | null
}

export interface ChannelOAuth {
  // Which sequence the core runs (a constant of `ChannelOAuthKinds`)
  readonly kind: ChannelOAuthKind
  // The permissions the dialog asks for, as the provider names them. Checked by the registry: a list, no
  // repeats, each a plain permission name, because the list ends up in an address.
  readonly scopes: readonly string[]
  // The address of the provider's dialog for this `state`. Pure: it reads the plugin's own app id and
  // calls nothing. The core made `state` (256 random bits) and `redirectUri` (its callback), and the
  // plugin only places them, so it cannot weaken the state.
  authorizationUrl(ctx: { readonly state: string; readonly redirectUri: string }): string
  // The token of the PERSON for the `code` the provider sent back to the callback, exchanged with the
  // plugin's app secret and, when the provider has one, made long lived (a token of an account taken
  // from a short one dies with it). Throws a PluginError. The code and the token are never logged.
  exchangeCode(ctx: { readonly code: string; readonly redirectUri: string }): Promise<string>
  // READ-ONLY. The scopes the person actually granted: the dialog lets them clear any box, so the core
  // compares this with `scopes` and says which one is missing instead of failing later with the
  // provider's own error.
  grantedScopes(ctx: OAuthUserContext): Promise<readonly string[]>
  // READ-ONLY. The accounts the person can connect. Every way the provider has to find them is tried by
  // the plugin and the answer is one list with no repeats; an empty list is a final answer (the person
  // has nothing to connect, or the plugin cannot see it), and the core then asks for the id by hand.
  listAssets(ctx: OAuthUserContext): Promise<readonly OAuthAsset[]>
  // The credentials the connection keeps for one account: the same shape `connect` takes, usually the
  // token of the account and not the person's. `assetId` is an id from `listAssets` or one the person
  // typed, so the plugin checks it against the provider before trusting it. Throws a PluginError.
  credentialsFor(
    ctx: OAuthUserContext & { readonly assetId: string }
  ): Promise<ConnectInput['credentials']>
}
