import { z } from 'zod'

import {
  type ChannelOAuthLinkedAccount,
  ChannelIds,
  ChannelOAuthKinds
} from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes, PluginChecks } from '@platform/core/errors'
import { type ChannelOAuth, type OAuthAsset, PluginError } from '@platform/plugins/sdk'

import { MetaErrorCodes } from './meta-constants'
import type { MetaGraphClient } from './meta-graph.client'
import { MetaOAuth } from './meta-oauth-constants'
import { grantedMetaScopes, metaOAuthScopeParam, metaOAuthScopesFor } from './meta-oauth-scopes'

// The Graph writes an id as a string of digits; anything else is not an id of a Page, a portfolio or an account
const assetId = z.string().regex(MetaOAuth.ASSET_ID_PATTERN)
const pageSchema = z.object({
  id: assetId,
  name: z.string().optional(),
  instagram_business_account: z.object({ id: assetId, username: z.string().optional() }).optional()
})
const pageListSchema = z.object({ data: z.array(pageSchema) })
const businessListSchema = z.object({ data: z.array(z.object({ id: assetId })) })
const pageTokenSchema = z.object({
  id: assetId,
  access_token: z.string().min(1).optional(),
  instagram_business_account: z.object({ id: assetId }).optional()
})

// The login of Messenger and Instagram: classic Facebook Login with the code on the server. The core keeps
// the state and the session; this only knows Meta's calls (measured on 2026-11-06 with the owner's account:
// `me/accounts` is empty for a Page that lives in a portfolio, `me/businesses` and `owned_pages` find it; on
// 2026-11-07, with a token WITHOUT `business_management` and an administrator of the app in development mode,
// they still did, so the login does not ask for that permission).
export class MetaLogin implements ChannelOAuth {
  readonly kind = ChannelOAuthKinds.AUTHORIZATION_CODE_WITH_ASSETS
  readonly scopes: readonly string[]
  // The dialog is on Facebook's site, and the ids of its accounts are digits (MetaOAuth.ASSET_ID_PATTERN)
  readonly dialogOrigin = MetaOAuth.DIALOG_ORIGIN
  readonly providerName = { es: 'Facebook', en: 'Facebook' }
  readonly assetIdPattern = MetaOAuth.ASSET_ID_PATTERN.source
  // Only Instagram reads the account a Page links: a Page without one cannot be connected for it
  readonly linkedAccount: ChannelOAuthLinkedAccount | null

  constructor(
    private readonly pluginId: string,
    private readonly meta: MetaGraphClient
  ) {
    this.scopes = metaOAuthScopesFor(pluginId)
    this.linkedAccount =
      pluginId === ChannelIds.INSTAGRAM
        ? {
            required: true,
            label: { es: 'Instagram: @{username}', en: 'Instagram: @{username}' },
            missingLabel: {
              es: 'Sin cuenta de Instagram vinculada',
              en: 'No Instagram account linked'
            }
          }
        : null
  }

  // Only Instagram reads the account a Page links: the field needs `instagram_basic`, which Messenger never asks for
  private get pageFields(): string {
    return this.pluginId === ChannelIds.INSTAGRAM
      ? MetaOAuth.PAGE_FIELDS_WITH_INSTAGRAM
      : MetaOAuth.PAGE_FIELDS
  }

  authorizationUrl(ctx: { state: string; redirectUri: string }): string {
    return this.meta.loginDialogUrl({
      state: ctx.state,
      redirectUri: ctx.redirectUri,
      scope: metaOAuthScopeParam(this.scopes)
    })
  }

  // A token of an account taken from a short token dies with it, so the short one is exchanged first
  async exchangeCode(ctx: { code: string; redirectUri: string }): Promise<string> {
    const short = await this.meta.exchangeToken({ code: ctx.code, redirect_uri: ctx.redirectUri })
    return this.meta.exchangeToken({
      grant_type: MetaOAuth.GRANT_EXCHANGE,
      [MetaOAuth.GRANT_EXCHANGE]: short
    })
  }

  async grantedScopes(ctx: { userToken: string }): Promise<readonly string[]> {
    const answer = await this.meta.get({
      path: MetaOAuth.EDGE_PERMISSIONS.split('/'),
      token: ctx.userToken,
      schema: z.unknown(),
      // The answer lists the declined and the expired too: a granted one must not fall on a second page
      query: { limit: MetaOAuth.LIST_LIMIT }
    })
    return grantedMetaScopes(answer)
  }

  // The Pages the person can connect, by every way Meta has to find them, without repeats: first the ones
  // they have a role on, then those of their portfolios (all of them). One way failing does not hide the
  // other; only when both fail is the first failure the answer, so that an outage is not an empty list.
  async listAssets(ctx: { userToken: string }): Promise<readonly OAuthAsset[]> {
    const found = new Map<string, OAuthAsset>()
    const failures: unknown[] = []
    // The refusals of the PORTFOLIO lists, which the screen can go on without (it asks for the number of the Page);
    // a refusal of `me/accounts` is not among them: that list needs only `pages_show_list`, which was checked
    const refusedLists: unknown[] = []
    // The pages of one list, or nothing when that way failed: the failure is kept, and the answer of the
    // others still counts. A list is merged in the order the ways were tried, whichever answered first.
    const pagesAt = async (
      path: readonly string[],
      portfolio = false
    ): Promise<z.infer<typeof pageSchema>[]> => {
      try {
        const answer = await this.meta.get({
          path,
          token: ctx.userToken,
          schema: pageListSchema,
          query: { fields: this.pageFields, limit: MetaOAuth.LIST_LIMIT }
        })
        return answer.data
      } catch (error) {
        this.refuseDeadToken(error)
        failures.push(error)
        if (portfolio && isRefusedList(error)) refusedLists.push(error)
        return []
      }
    }
    // One Page by its id. A refusal (the Page is not reachable with this token) is a Page that is not listed.
    const pageAt = async (id: string): Promise<z.infer<typeof pageSchema> | null> => {
      try {
        return await this.meta.get({
          path: [id],
          token: ctx.userToken,
          schema: pageSchema,
          query: { fields: this.pageFields }
        })
      } catch (error) {
        this.refuseDeadToken(error)
        failures.push(error)
        if (isRefusedList(error) || isUnreachableObject(error)) refusedLists.push(error)
        return null
      }
    }
    // A Page found twice keeps the entry that says which account it links: one way may leave the field out
    const keep = (pages: readonly z.infer<typeof pageSchema>[]): void => {
      for (const page of pages) {
        const known = found.get(page.id)
        if (
          known === undefined ||
          (known.linkedAccount === null && page.instagram_business_account)
        ) {
          found.set(page.id, assetOf(page))
        }
      }
    }
    const portfolios = async (): Promise<string[]> => {
      try {
        const answer = await this.meta.get({
          path: MetaOAuth.EDGE_BUSINESSES.split('/'),
          token: ctx.userToken,
          schema: businessListSchema,
          query: { fields: MetaOAuth.BUSINESS_FIELDS, limit: MetaOAuth.LIST_LIMIT }
        })
        return answer.data.slice(0, MetaOAuth.MAX_BUSINESSES).map(business => business.id)
      } catch (error) {
        this.refuseDeadToken(error)
        failures.push(error)
        if (isRefusedList(error)) refusedLists.push(error)
        return []
      }
    }
    // The Pages the person ticked in the dialog of Facebook: they need no permission of ours, and are the way in
    // when the person has no role on the Page and no portfolio answers (a consent given again after the app was
    // removed grants only the permissions asked). A failure here is not one of the person's: nothing is lost.
    const ticked = async (): Promise<string[]> => {
      try {
        return await this.meta.grantedPageIds(ctx.userToken)
      } catch (error) {
        // Meta, the network or the app not answering (a PluginError) loses nothing; a bug of ours is not hidden
        if (error instanceof PluginError) return []
        throw error
      }
    }
    // The three do not depend on each other, so they are asked together
    const [roles, businesses, tickedIds] = await Promise.all([
      pagesAt(MetaOAuth.EDGE_ACCOUNTS.split('/')),
      portfolios(),
      ticked()
    ])
    keep(roles)
    // A few portfolios at a time: one after another would be a call each for a person who has many
    for (let from = 0; from < businesses.length; from += MetaOAuth.OWNED_PAGES_CONCURRENCY) {
      const group = businesses.slice(from, from + MetaOAuth.OWNED_PAGES_CONCURRENCY)
      const lists = await Promise.all(
        group.map(business => pagesAt([business, MetaOAuth.EDGE_OWNED_PAGES], true))
      )
      for (const pages of lists) keep(pages)
    }
    // A ticked Page that no list found is read by its id, as the screen does with a number the person types
    const missing = tickedIds.filter(id => !found.has(id))
    for (let from = 0; from < missing.length; from += MetaOAuth.OWNED_PAGES_CONCURRENCY) {
      const group = missing.slice(from, from + MetaOAuth.OWNED_PAGES_CONCURRENCY)
      const pages = await Promise.all(group.map(id => pageAt(id)))
      for (const page of pages) if (page) keep([page])
    }
    // Nothing found and something failed: an outage is not "nothing to connect". A list that Meta REFUSED to
    // this token (a permission the token lacks, an edge it may not read: the portfolios need no permission of
    // ours, but Meta may ask one of an account that is not an administrator of the app) is an empty list: the
    // screen then asks for the number of the Page, which is the way in that needs nothing from the lists.
    if (found.size === 0 && failures.length > 0) {
      // Every failure is a refusal of a portfolio list: an empty list. Otherwise the first one that is not
      // (not the first to arrive: the lists are asked together, so the order is the network's).
      const open = failures.filter(failure => !refusedLists.includes(failure))
      // An outage is told before a refusal: it is the one the person can do something about by waiting
      const cause = open.find(failure => !isRefusedList(failure)) ?? open[0]
      // What the helpers of this class throw is a PluginError, or the error of a read the schema refused
      if (cause !== undefined) throw cause as Error
    }
    return [...found.values()]
  }

  // The token of one Page, read with the token of the person. The id may be one the person typed, so what
  // Meta answers is checked to be that Page's. Instagram also needs the Page to link an account.
  async credentialsFor(ctx: {
    userToken: string
    assetId: string
  }): Promise<Record<string, unknown>> {
    if (!MetaOAuth.ASSET_ID_PATTERN.test(ctx.assetId)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.PARENT_ID_NOT_NUMERIC
      })
    }
    const needsInstagram = this.pluginId === ChannelIds.INSTAGRAM
    let page
    try {
      page = await this.meta.get({
        path: [ctx.assetId],
        token: ctx.userToken,
        schema: pageTokenSchema,
        query: {
          fields: needsInstagram
            ? MetaOAuth.PAGE_TOKEN_FIELDS_WITH_INSTAGRAM
            : MetaOAuth.PAGE_TOKEN_FIELDS
        }
      })
    } catch (error) {
      this.refuseDeadToken(error)
      // A Page that does not exist or that the person cannot reach answers 100. A permission error keeps the
      // reason it already has: the person has to grant something, not to type another number.
      if (isUnreachableObject(error)) {
        throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
          retryable: false,
          providerCode: error.providerCode,
          reason: ChannelConnectFailureReasons.NO_ASSETS
        })
      }
      throw error
    }
    if (page.id !== ctx.assetId) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.PARENT_ID_MISMATCH
      })
    }
    if (page.access_token === undefined) {
      // The person has the Page without the task that gives a token for it
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        reason: ChannelConnectFailureReasons.PERMISSION_MISSING
      })
    }
    if (needsInstagram && page.instagram_business_account === undefined) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        reason: ChannelConnectFailureReasons.LINKED_ACCOUNT_MISSING
      })
    }
    return { accessToken: page.access_token }
  }

  // A token Meta no longer accepts ends the login whatever else was being tried
  private refuseDeadToken(error: unknown): void {
    if (
      error instanceof PluginError &&
      error.reason === ChannelConnectFailureReasons.TOKEN_REJECTED
    ) {
      throw error
    }
  }
}

function assetOf(page: z.infer<typeof pageSchema>): OAuthAsset {
  const name = (page.name ?? '').slice(0, MetaOAuth.ASSET_NAME_MAX_LENGTH).trim()
  return {
    id: page.id,
    name: name === '' ? page.id : name,
    linkedAccount:
      page.instagram_business_account === undefined
        ? null
        : {
            id: page.instagram_business_account.id,
            username: page.instagram_business_account.username ?? null
          }
  }
}

// Meta answered a list with a refusal that will not change by asking again. The code alone does not say so: an
// outage or a throttle can carry 100, 10 or 2xx too (the Graph copies the code into every failure), so a failure
// that may be tried again, or whose outcome is unknown, is never a refusal. A dead token (190) was stopped before.
function isRefusedList(error: unknown): boolean {
  if (!(error instanceof PluginError) || error.retryable === true || error.outcomeUnknown) {
    return false
  }
  const code = error.providerCode
  return (
    code === MetaErrorCodes.INVALID_PARAMETER ||
    code === MetaErrorCodes.PERMISSION_DENIED ||
    (code !== undefined &&
      code >= MetaErrorCodes.PERMISSION_RANGE_START &&
      code <= MetaErrorCodes.PERMISSION_RANGE_END)
  )
}

function isUnreachableObject(error: unknown): error is PluginError {
  return (
    error instanceof PluginError &&
    error.retryable !== true &&
    !error.outcomeUnknown &&
    error.providerCode === MetaErrorCodes.INVALID_PARAMETER
  )
}
