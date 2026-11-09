import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  ChannelOAuthConfig,
  connectReasonOfError,
  withTimeout
} from '@platform/channels/connections'
import { CredentialCipher, generateToken } from '@platform/core/crypto'
import {
  AppPaths,
  ASSET_ID_MAX_LENGTH,
  ChannelAuthMethods,
  ChannelHealthLimits,
  ChannelOAuthLimits,
  ChannelOAuthQuery,
  missingOAuthScopes,
  OAuthProviderErrors,
  StoreSettingsSections
} from '@platform/core/domain'
import {
  ChannelConnectFailureReasons,
  type ChannelConnectFailureReason,
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { PluginRegistry } from '@platform/plugins/runtime'
import { type ChannelOAuthSnapshot } from '@platform/plugins/runtime'
import { pluginFailureLog } from '@platform/plugins/sdk'

import type { Actor } from '../../tenancy'
import {
  type ChannelConnectionView,
  ChannelConnectionsService
} from '../channel-connections.service'

import { STATE_PATTERN } from './channel-oauth.schemas'
import {
  ChannelOAuthStore,
  type OAuthSessionRecord,
  type OAuthStateRecord
} from './channel-oauth.store'

// What the page may be told about a Page: these three fields, whatever else a plugin returned
export interface OAuthAssetView {
  id: string
  name: string
  linkedAccount: { id: string; username: string | null } | null
}

// The Pages of a session. When the login repairs a connection it says which one and what account it is, so
// that the screen can show which Page is the connection's.
export interface OAuthAssetsView {
  pluginId: string
  connectionId: string | null
  repairAccountId: string | null
  assets: OAuthAssetView[]
}

const MAX_ASSETS = 200
// The `code` of the provider: printable ASCII, and no longer than any code is
const CODE_PATTERN = /^[\x21-\x7E]{1,2048}$/

// "Connect with Facebook" (Step 7.8). The state and the session live in the store; what is specific to a
// provider is behind `plugin.oauth`. The callback only exchanges the code and keeps a sealed session; the
// connection is made by `complete`, which an authenticated call with permissions finishes, over the same
// `connect` as a pasted token.
@Injectable()
export class ChannelOAuthService {
  constructor(
    private readonly registry: PluginRegistry,
    private readonly store: ChannelOAuthStore,
    private readonly config: ChannelOAuthConfig,
    private readonly cipher: CredentialCipher,
    private readonly connections: ChannelConnectionsService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ChannelOAuthService.name)
  }

  // The login of a plugin this store may use, or nothing
  private oauthFor(pluginId: string, storeId: string): ChannelOAuthSnapshot | null {
    return this.registry.isVisibleTo(pluginId, storeId) ? this.registry.oauthOf(pluginId) : null
  }

  async start(
    storeId: string,
    userId: string,
    pluginId: string,
    connectionId?: string
  ): Promise<{ authorizeUrl: string }> {
    const oauth = this.oauthFor(pluginId, storeId)
    const redirectUri = this.config.redirectUri
    // Off, no login for the plugin, or a plugin this store cannot see: all the same answer
    if (oauth === null || redirectUri === undefined) throw resourceNotFound('channel login')
    // Before the person leaves for the provider: a plugin the store has not installed cannot be connected
    await this.connections.ensureInstalled(storeId, pluginId)
    // A login that repairs a connection says which one in the record of its state, after the connection was
    // found in this store and for this plugin
    if (connectionId !== undefined) {
      await this.connections.assertRepairable(storeId, connectionId, pluginId)
    }
    const state = generateToken(ChannelOAuthLimits.STATE_BYTES)
    // The plugin builds the address, so the core checks it keeps what the core gave: an address that is not
    // https, or that carries another state or callback, would send the state somewhere else or make it useless
    let authorizeUrl: string | null = null
    try {
      authorizeUrl = oauth.authorizationUrl({ state, redirectUri })
    } catch (error) {
      this.logger.warn({ pluginId, storeId, ...pluginFailureLog(error) }, 'oauth address not made')
    }
    const checked = keepsTheState(authorizeUrl, state, redirectUri, oauth.dialogOrigin)
    if (checked === null) {
      this.logger.error({ pluginId, storeId }, 'a plugin made no authorization address of ours')
      throw new PlatformException(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        'the provider did not accept the connection',
        HttpStatusCodes.BAD_REQUEST,
        { reason: ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED }
      )
    }
    await this.store.saveState(state, {
      userId,
      storeId,
      pluginId,
      ...(connectionId === undefined ? {} : { connectionId })
    })
    return { authorizeUrl: checked }
  }

  // Where the callback sends the browser. It never throws and never echoes what the provider put in the
  // address: the answer is either the id of a session or a reason of the closed list. A refusal leaves a line
  // with the reason alone (no code, no state), so that probing and replay can be seen.
  async callback(query: Record<string, unknown>): Promise<string> {
    const state = oneOf(query[ChannelOAuthQuery.STATE], STATE_PATTERN)
    // No state, a repeated one or one of another shape: nobody here made it, and there is no store to name
    if (state === undefined) {
      return this.refuse(null, ChannelConnectFailureReasons.OAUTH_EXPIRED, 'no state')
    }
    let record: OAuthStateRecord | null
    try {
      // Read and removed: a second callback with the same state finds nothing
      record = await this.store.takeState(state)
    } catch (error) {
      return this.failed(null, error)
    }
    if (record === null) {
      return this.refuse(null, ChannelConnectFailureReasons.OAUTH_EXPIRED, 'unknown state')
    }
    try {
      return await this.finish(record, query)
    } catch (error) {
      return this.failed(record.storeId, error)
    }
  }

  // Redis, the cipher or anything else the login did not expect: the person is sent back to try again instead
  // of to a page of errors, and the line names the error and never the address
  private failed(storeId: string | null, error: unknown): string {
    this.logger.error({ storeId, ...pluginFailureLog(error) }, 'oauth callback failed')
    return this.back(storeId, { reason: ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE })
  }

  private async finish(record: OAuthStateRecord, query: Record<string, unknown>): Promise<string> {
    const { storeId, pluginId } = record
    const refused = query[ChannelOAuthQuery.ERROR]
    if (refused !== undefined) {
      // Only `access_denied` is the person saying no; the provider failing is not their doing, and the value
      // is read here and never repeated
      return this.refuse(storeId, reasonOfProviderError(refused), 'refused at the provider')
    }
    const code = oneOf(query[ChannelOAuthQuery.CODE], CODE_PATTERN)
    const oauth = this.oauthFor(pluginId, storeId)
    const redirectUri = this.config.redirectUri
    if (code === undefined || oauth === null || redirectUri === undefined) {
      return this.refuse(storeId, ChannelConnectFailureReasons.OAUTH_EXPIRED, 'no code or no login')
    }
    let userToken: unknown
    try {
      userToken = await withTimeout(
        oauth.exchangeCode({ code, redirectUri }),
        ChannelOAuthLimits.EXCHANGE_TIMEOUT_MS
      )
    } catch (error) {
      // The code, the state and what the provider said are not logged: the name of the error, the numbers of
      // its answer and the name of the check that refused (see pluginFailureLog)
      this.logger.warn(
        { pluginId, storeId, ...pluginFailureLog(error) },
        'oauth code exchange failed'
      )
      return this.back(storeId, {
        reason: connectReasonOfError(error) ?? ChannelConnectFailureReasons.REQUEST_REJECTED
      })
    }
    // A plugin is code the core does not control: a token that is not text would be sealed and never opened
    if (typeof userToken !== 'string' || userToken === '') {
      return this.refuse(
        storeId,
        ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED,
        'the exchange gave no token'
      )
    }
    const sessionId = generateToken(ChannelOAuthLimits.SESSION_ID_BYTES)
    await this.store.saveSession(sessionId, {
      userId: record.userId,
      storeId,
      pluginId,
      ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
      sealed: this.cipher.seal({ userToken }).toString('base64')
    })
    return this.back(storeId, { session: sessionId })
  }

  async assets(storeId: string, userId: string, sessionId: string): Promise<OAuthAssetsView> {
    const { session, oauth, userToken } = await this.open(storeId, userId, sessionId)
    await this.requireScopes(session, oauth, userToken)
    const found = await this.guarded(
      session,
      () => oauth.listAssets({ userToken }),
      ChannelOAuthLimits.LIST_TIMEOUT_MS
    )
    return {
      pluginId: session.pluginId,
      // Set when the login repairs a connection, so that the screen can say so and show which Page it is
      connectionId: session.connectionId ?? null,
      repairAccountId: await this.repairAccountOf(session),
      // Only ids that are ids of the provider as its plugin declared them: one that is not could not be chosen
      assets: assetsOf(found, oauth.assetId)
    }
  }

  // The session is consumed only when the connection was made: a Page typed wrong, or a refusal of the
  // provider, leaves it for another try until it expires
  async complete(
    storeId: string,
    actor: Actor,
    sessionId: string,
    assetId: string
  ): Promise<ChannelConnectionView> {
    const { session, oauth, userToken } = await this.open(storeId, actor.userId, sessionId)
    // The id is held to the pattern the plugin declared (the registry kept it as a pattern that cannot backtrack),
    // since it goes to the provider in a path. Before anything is asked of the provider: an id that can never match is
    // answered here
    if (assetId.length > ASSET_ID_MAX_LENGTH || !oauth.assetId.test(assetId)) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'request validation failed',
        HttpStatusCodes.BAD_REQUEST,
        {
          issues: [{ path: 'assetId', code: 'custom', message: 'not an account id' }],
          truncated: false
        }
      )
    }
    // Here too and not only when the Pages are listed: a call that goes straight to `complete` with a Page
    // number must not connect with a permission the person cleared in the dialog
    await this.requireScopes(session, oauth, userToken)
    const credentials = await this.guarded(session, () =>
      oauth.credentialsFor({ userToken, assetId })
    )
    // The connection is checked again where its credentials are written, not only when the login started: it
    // may have been disconnected meanwhile, and the plugin of the row must still be the plugin of the session
    if (session.connectionId !== undefined) {
      await this.connections.assertRepairable(storeId, session.connectionId, session.pluginId)
    }
    const options = { authMethod: ChannelAuthMethods.FACEBOOK_LOGIN }
    // A login that repairs a connection takes only the Page that connection already is: another Page is
    // `other_account` and nothing is written, as for a pasted token. Any other login makes or finds its own.
    const view =
      session.connectionId === undefined
        ? await this.connections.connect(storeId, session.pluginId, { credentials }, actor, options)
        : await this.connections.updateToken(
            storeId,
            session.connectionId,
            { credentials },
            actor,
            options
          )
    // The connection is made: a session that cannot be removed now (Redis down) is not a failure of it, and it
    // expires by itself. Answering an error would make the person connect the same Page twice.
    try {
      await this.store.deleteSession(sessionId)
    } catch (error) {
      this.logger.warn(
        { pluginId: session.pluginId, storeId, ...pluginFailureLog(error) },
        'oauth session not removed after the connection'
      )
    }
    return view
  }

  // The account of the connection a session repairs, for the screen; nothing when it repairs none or the connection
  // is gone (the screen then has no Page to mark, and `complete` says why)
  private async repairAccountOf(session: OAuthSessionRecord): Promise<string | null> {
    if (session.connectionId === undefined) return null
    try {
      return (
        await this.connections.assertRepairable(
          session.storeId,
          session.connectionId,
          session.pluginId
        )
      ).accountId
    } catch (error) {
      // A connection that is gone or disconnected is expected; anything else is a failure to be seen
      if (!(error instanceof PlatformException)) {
        this.logger.warn(
          { pluginId: session.pluginId, storeId: session.storeId, ...pluginFailureLog(error) },
          'the connection a login repairs could not be read'
        )
      }
      return null
    }
  }

  // Dropping a session needs only to be its owner: no token is opened and no plugin is looked up, so one whose
  // blob can no longer be read (a key that changed) or whose plugin is gone can still be removed
  async cancel(storeId: string, userId: string, sessionId: string): Promise<void> {
    await this.ownedSession(storeId, userId, sessionId)
    await this.store.deleteSession(sessionId)
  }

  // The dialog lets a person clear a box: say which, instead of failing later with the provider's own error
  private async requireScopes(
    session: OAuthSessionRecord,
    oauth: ChannelOAuthSnapshot,
    userToken: string
  ): Promise<void> {
    const granted = await this.guarded(session, () => oauth.grantedScopes({ userToken }))
    const missing = missingOAuthScopes(oauth.scopes, granted)
    if (missing.length > 0) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        'the login did not grant every permission',
        HttpStatusCodes.BAD_REQUEST,
        { reason: ChannelConnectFailureReasons.PERMISSION_MISSING, missingPermissions: missing }
      )
    }
  }

  // A session of another user, of another store, expired, or of a plugin this store cannot use is one answer
  // with a session that never existed
  private async ownedSession(
    storeId: string,
    userId: string,
    sessionId: string
  ): Promise<OAuthSessionRecord> {
    const session = await this.store.readSession(sessionId)
    if (session === null || session.userId !== userId || session.storeId !== storeId) {
      throw resourceNotFound('oauth session')
    }
    return session
  }

  private async open(storeId: string, userId: string, sessionId: string) {
    const session = await this.ownedSession(storeId, userId, sessionId)
    const oauth = this.oauthFor(session.pluginId, storeId)
    if (oauth === null) throw resourceNotFound('oauth session')
    return { session, oauth, userToken: this.tokenOf(session) }
  }

  private tokenOf(session: OAuthSessionRecord): string {
    try {
      const opened = this.cipher.open(Buffer.from(session.sealed, 'base64'))
      if (typeof opened['userToken'] === 'string' && opened['userToken'] !== '') {
        return opened['userToken']
      }
    } catch {
      // A key that changed or bytes that are not ours: the session is as good as gone
    }
    throw resourceNotFound('oauth session')
  }

  // A call to the provider: bounded in time (the call itself is not cancelled by the bound, as for every
  // plugin call), and a failure comes out as one refusal that holds a reason of the closed list and nothing the
  // provider said
  private async guarded<T>(
    session: OAuthSessionRecord,
    run: () => Promise<T>,
    timeoutMs: number = ChannelHealthLimits.PROVIDER_TIMEOUT_MS
  ): Promise<T> {
    try {
      return await withTimeout(run(), timeoutMs)
    } catch (error) {
      this.logger.warn(
        { pluginId: session.pluginId, storeId: session.storeId, ...pluginFailureLog(error) },
        'oauth step failed'
      )
      const reason = connectReasonOfError(error)
      throw new PlatformException(
        ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        'the provider did not accept the connection',
        HttpStatusCodes.BAD_REQUEST,
        reason === undefined ? undefined : { reason }
      )
    }
  }

  // A callback that ends in a refusal: the reason is in the log, never the address it came with
  private refuse(storeId: string | null, reason: ChannelConnectFailureReason, why: string): string {
    this.logger.info({ storeId, reason, why }, 'oauth callback refused')
    return this.back(storeId, { reason })
  }

  // The address of the web app: the channels settings of the store that started the login, or the root when
  // nothing is known of it. Only an opaque session id or a reason travels in it.
  private back(
    storeId: string | null,
    params: { session: string } | { reason: ChannelConnectFailureReason }
  ): string {
    const origin = new URL(this.config.frontendUrl).origin
    const path =
      storeId === null ? '/' : AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS)
    const url = new URL(path, origin)
    if ('session' in params) url.searchParams.set(ChannelOAuthQuery.SESSION, params.session)
    else url.searchParams.set(ChannelOAuthQuery.FAILURE, params.reason)
    return url.href
  }
}

// The origin too: the plugin declared the one site its dialog is on, and the registry held that declaration to an
// exact https origin. An address on any other site, whatever it carries, is not the dialog it declared.
function keepsTheState(
  authorizeUrl: unknown,
  state: string,
  redirectUri: string,
  dialogOrigin: string
): string | null {
  if (typeof authorizeUrl !== 'string') return null
  try {
    const url = new URL(authorizeUrl)
    const keeps =
      url.protocol === 'https:' &&
      url.origin === dialogOrigin &&
      // `origin` leaves these out: an address with a login in it, or a fragment, is not the dialog that was declared
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.searchParams.getAll(ChannelOAuthQuery.STATE).length === 1 &&
      url.searchParams.get(ChannelOAuthQuery.STATE) === state &&
      // Once each, so the provider cannot read the last one while the core read the first
      url.searchParams.getAll(ChannelOAuthQuery.REDIRECT_URI).length === 1 &&
      url.searchParams.get(ChannelOAuthQuery.REDIRECT_URI) === redirectUri
    // What is sent is the address that was checked, parsed and written back, not the string the plugin gave
    return keeps ? url.href : null
  } catch {
    return null
  }
}

// A query value that is one string of the shape asked for. A repeated parameter arrives as a list, and a nested
// one as an object: neither is a value.
function oneOf(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

// What the provider's own `error` means for the person: `access_denied` is the person saying no, an outage is
// the provider's, and anything else (a scope or an app that is wrong) is a refusal of the request
function reasonOfProviderError(error: unknown): ChannelConnectFailureReason {
  switch (error) {
    case OAuthProviderErrors.ACCESS_DENIED:
      return ChannelConnectFailureReasons.OAUTH_CANCELLED
    case OAuthProviderErrors.SERVER_ERROR:
    case OAuthProviderErrors.TEMPORARILY_UNAVAILABLE:
      return ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
    default:
      return ChannelConnectFailureReasons.REQUEST_REJECTED
  }
}

const ASSET_TEXT_MAX_LENGTH = 200

// What a plugin lists, as the page may be told it. A third party writes the plugin, so nothing is taken on trust: the
// answer must be a list, each entry an object whose id is a STRING that fits the pattern the plugin declared (a number
// or an object would pass a pattern by being turned into text), the names are bounded text, and the account a Page
// links is held to the same pattern. An entry that is not any of that is left out, not repaired.
function assetsOf(found: unknown, pattern: RegExp): OAuthAssetView[] {
  if (!Array.isArray(found)) return []
  // Cut by characters (never through a pair), and with the control, format and direction characters taken out
  const text = (value: unknown): string | null =>
    typeof value === 'string'
      ? Array.from(value.replace(/\p{C}/gu, '')).slice(0, ASSET_TEXT_MAX_LENGTH).join('')
      : null
  const assets: OAuthAssetView[] = []
  for (const entry of found as unknown[]) {
    if (assets.length >= MAX_ASSETS) break
    if (typeof entry !== 'object' || entry === null) continue
    const { id, name, linkedAccount } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id.length > ASSET_ID_MAX_LENGTH || !pattern.test(id)) continue
    let linked: OAuthAssetView['linkedAccount'] = null
    if (typeof linkedAccount === 'object' && linkedAccount !== null) {
      const account = linkedAccount as Record<string, unknown>
      const accountId = account['id']
      // The account a choice links has ids of its own: only its shape is held (a bounded string), not the pattern of
      // the choices. One that is not that leaves the choice without a linked account, and a choice that needs one
      // then cannot be connected.
      if (typeof accountId === 'string' && accountId.length <= ASSET_ID_MAX_LENGTH) {
        linked = { id: accountId, username: text(account['username']) }
      }
    }
    assets.push({ id, name: text(name) ?? id, linkedAccount: linked })
  }
  return assets
}
