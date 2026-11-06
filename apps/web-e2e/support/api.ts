import { z } from 'zod'

import { type AccountProfile, accountProfileSchema } from '@platform/api-client'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { RoleNames, TenantHeaders } from '@platform/core/auth'
import { ChannelIds } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import { FORWARDED_FOR, newClientIp } from './client-ip'
import { API_URL } from './env'
import { waitForLinkBudget } from './link-budget'
import { emptyMailboxOf, magicLinkTokenIn, nextEmailTo } from './mailbox'

const consumeSchema = z.object({ session: z.object({ accessToken: z.string().min(1) }) })
const rolesSchema = z.array(z.object({ id: z.string(), name: z.string() }))

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API_URL}${API_PREFIX}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', [FORWARDED_FOR]: newClientIp(), ...init.headers }
  })
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status}`)
  return response.status === 204 ? null : response.json()
}

// What an administrator does through the api, for a test that needs a state the screens cannot yet
// set up (the invitation form is a task of Step 3.2). It signs in the way a person does: by link.
export async function signInByApi(email: string): Promise<string> {
  await waitForLinkBudget(email)
  await emptyMailboxOf(email)
  await call(ApiRoutes.auth.magicLinkRequest, { method: 'POST', body: JSON.stringify({ email }) })
  const token = magicLinkTokenIn(await nextEmailTo(email))
  return consumeSchema.parse(
    await call(ApiRoutes.auth.magicLinkConsume, { method: 'POST', body: JSON.stringify({ token }) })
  ).session.accessToken
}

export async function profileOf(token: string): Promise<AccountProfile> {
  return accountProfileSchema.parse(
    await call(ApiRoutes.auth.me, { headers: { authorization: `Bearer ${token}` } })
  )
}

// Invites an address to the first store of the signed-in administrator as an Agent
export async function inviteAsAgent(adminToken: string, invited: string): Promise<void> {
  const authorization = { authorization: `Bearer ${adminToken}` }
  const profile = await profileOf(adminToken)
  const store = profile.memberships[0]
  if (store === undefined) throw new Error('the administrator belongs to no store')
  const headers = { ...authorization, [TenantHeaders.STORE_ID]: store.storeId }
  const roles = rolesSchema.parse(await call(ApiRoutes.settings.roles, { headers }))
  const agent = roles.find(role => role.name === RoleNames.AGENT)
  if (agent === undefined) throw new Error('the store has no Agent role')
  await emptyMailboxOf(invited)
  await call(ApiRoutes.settings.members, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: invited, roleId: agent.id })
  })
}

// An internal note written by whoever holds the token, as a second session would write it: the
// thread of another browser has to show it without a reload
export async function writeNote(
  token: string,
  storeId: string,
  conversationId: string,
  content: string,
  mentions: readonly string[] = []
): Promise<void> {
  await call(ApiRoutes.messages.create, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, [TenantHeaders.STORE_ID]: storeId },
    body: JSON.stringify({
      type: 'INTERNAL_NOTE',
      conversationId,
      content,
      mentions,
      idempotencyKey: crypto.randomUUID()
    })
  })
}

const connectedSchema = z.object({ id: z.string().min(1) })
const embedSchema = z.object({ siteKey: z.string().min(1), snippet: z.string().min(1) })

export interface WidgetSite {
  connectionId: string
  siteKey: string
  snippet: string
}

const storeHeaders = (token: string, storeId: string) => ({
  authorization: `Bearer ${token}`,
  [TenantHeaders.STORE_ID]: storeId
})

// What the owner of a store does to put the web widget on a site: installs the channel (once; a
// store that has it keeps it), connects it for the sites and reads the snippet to paste
export async function connectWidget(
  token: string,
  storeId: string,
  siteOrigins: string[]
): Promise<WidgetSite> {
  const headers = storeHeaders(token, storeId)
  await call(ApiRoutes.plugins.install, {
    method: 'POST',
    headers,
    body: JSON.stringify({ pluginId: ChannelIds.WEB_WIDGET })
  }).catch((error: unknown) => {
    // The laptop keeps its database between runs, so the channel may already be installed
    if (!(error instanceof Error) || !error.message.endsWith(`${HttpStatusCodes.CONFLICT}`)) {
      throw error
    }
  })
  const { id } = connectedSchema.parse(
    await call(ApiRoutes.channels.connect(ChannelIds.WEB_WIDGET), {
      method: 'POST',
      headers,
      body: JSON.stringify({ credentials: { siteOrigins } })
    })
  )
  const embed = embedSchema.parse(await call(ApiRoutes.channels.widgetEmbed(id), { headers }))
  return { connectionId: id, ...embed }
}

const catalogSchema = z.array(
  z.object({ id: z.string(), installed: z.boolean(), installationId: z.string().nullable() })
)

// Takes the web widget off a store (every account of it is disconnected), as the Plugins page does.
// For the end of a spec that must leave the shared database as it found it: a store that is not
// installed is left as it is.
export async function uninstallWidget(token: string, storeId: string): Promise<void> {
  await uninstallChannel(token, storeId, ChannelIds.WEB_WIDGET)
}

// The same for any channel plugin: installing is the Plugins page's step before connecting
export async function installChannel(
  token: string,
  storeId: string,
  pluginId: string
): Promise<void> {
  await call(ApiRoutes.plugins.install, {
    method: 'POST',
    headers: storeHeaders(token, storeId),
    body: JSON.stringify({ pluginId })
  }).catch((error: unknown) => {
    // The laptop keeps its database between runs, so the channel may already be installed
    if (!(error instanceof Error) || !error.message.endsWith(`${HttpStatusCodes.CONFLICT}`)) {
      throw error
    }
  })
  // A 409 also answers "this plugin cannot be installed yet": the store must hold it at the end
  const catalog = catalogSchema.parse(
    await call(ApiRoutes.plugins.available, { headers: storeHeaders(token, storeId) })
  )
  const entry = catalog.find(candidate => candidate.id === pluginId)
  if (entry?.installed !== true) {
    throw new Error(
      `${pluginId} is not installed after the install: ${JSON.stringify(entry ?? null)}`
    )
  }
}

export async function uninstallChannel(
  token: string,
  storeId: string,
  pluginId: string
): Promise<void> {
  const headers = storeHeaders(token, storeId)
  const catalog = catalogSchema.parse(await call(ApiRoutes.plugins.available, { headers }))
  const installationId = catalog.find(entry => entry.id === pluginId)?.installationId
  if (installationId === null || installationId === undefined) return
  await call(ApiRoutes.plugins.revoke(installationId), { method: 'POST', headers })
}

// Deletes a store that holds nothing, through the same route as the organization page. The request
// goes through the first store of the person, as the page does; a store that is already gone is
// not an error, so a spec can call it from a `finally` after the page deleted the store itself.
// The api asks for the name of the store, as the page does (ORG-03).
export async function deleteStoreIfThere(
  token: string,
  storeId: string,
  name: string
): Promise<void> {
  const through = (await profileOf(token)).memberships[0]
  if (through === undefined) throw new Error('the person belongs to no store')
  await call(ApiRoutes.organizations.storeById(storeId), {
    method: 'DELETE',
    body: JSON.stringify({ confirmation: name }),
    headers: storeHeaders(token, through.storeId)
  }).catch((error: unknown) => {
    if (!(error instanceof Error) || !error.message.endsWith(`${HttpStatusCodes.NOT_FOUND}`)) {
      throw error
    }
  })
}

// The sites that may load the widget, replaced by the list
export async function setWidgetOrigins(
  token: string,
  storeId: string,
  connectionId: string,
  siteOrigins: string[]
): Promise<void> {
  await call(ApiRoutes.channels.widgetOrigins(connectionId), {
    method: 'PUT',
    headers: storeHeaders(token, storeId),
    body: JSON.stringify({ siteOrigins })
  })
}

// The pre-chat form of the widget, turned on or off
export async function setWidgetPreChat(
  token: string,
  storeId: string,
  connectionId: string,
  enabled: boolean
): Promise<void> {
  await call(ApiRoutes.channels.widgetPreChat(connectionId), {
    method: 'PUT',
    headers: storeHeaders(token, storeId),
    body: JSON.stringify({ enabled })
  })
}
