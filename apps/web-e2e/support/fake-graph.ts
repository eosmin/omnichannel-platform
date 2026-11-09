import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import {
  WhatsAppApi,
  WhatsAppTemplateComponents,
  WhatsAppTemplateStatuses
} from '@platform/channels/whatsapp-constants'
import { HttpStatusCodes } from '@platform/core/errors'

import { GRAPH_HOST, GRAPH_PORT } from './env'

// The ids of the WhatsApp connection that the cases build (support/database.ts): numbers, because the
// plugin puts them in a url path and accepts nothing else
export const FAKE_PHONE_NUMBER_ID = '100000000000001'
export const FAKE_BUSINESS_ACCOUNT_ID = '100000000000002'
export const FAKE_ACCESS_TOKEN = 'e2e-access-token'

// The Page of a Messenger connection: the token that Meta accepts, one that it refuses, and the name
export const FAKE_PAGE_ID = '109000000000001'
export const FAKE_PAGE_TOKEN = 'e2e-page-token'
// Another token of the SAME Page (the owner generated a new one), and a token of ANOTHER Page
export const FAKE_PAGE_TOKEN_RENEWED = 'e2e-page-token-renewed'
export const FAKE_OTHER_PAGE_ID = '109000000000002'
export const FAKE_OTHER_PAGE_TOKEN = 'e2e-other-page-token'
export const FAKE_REJECTED_TOKEN = 'e2e-rejected-token'
// A token for which Meta answers with its throttle code (4): the page is asked to wait
export const FAKE_BUSY_TOKEN = 'e2e-busy-token'
// The app of the token (`GET app?fields=id`), whose entry is picked among the apps of the Page
// An invented id, not one of a real Meta app: the repository is public
export const FAKE_APP_ID = '100000000000001'
export const FAKE_PAGE_NAME = 'E2E Page'

// "Connect with Facebook": the secret of the app (the api is started with it, playwright.shared.ts), the codes the
// dialog sends back, and the tokens of the person they are traded for. One login grants everything the Messenger
// login asks for; the other leaves out `pages_read_engagement`, as a person who clears that box does. The
// portfolio holds the Page, and `me/accounts` is empty, as for the owner's own account (measured 2026-11-06).
export const FAKE_APP_SECRET = 'e2e-app-secret-of-more-than-16-characters'
export const FAKE_LOGIN_CODE = 'e2e-login-code'
export const FAKE_LOGIN_CODE_CLEARED = 'e2e-login-code-cleared'
const FAKE_USER_SHORT = 'e2e-user-short'
const FAKE_USER_SHORT_CLEARED = 'e2e-user-short-cleared'
export const FAKE_USER_TOKEN = 'e2e-user-token'
const FAKE_USER_TOKEN_CLEARED = 'e2e-user-token-cleared'
export const FAKE_BUSINESS_ID = '200000000000001'
// The Instagram account that the Page links, and a second Page of the portfolio that links none (for the channel
// that needs an account, it is shown and cannot be chosen)
export const FAKE_IG_ID = '17841400000000001'
export const FAKE_IG_USERNAME = 'e2e_ig'
export const FAKE_NO_IG_PAGE_ID = '109000000000003'
export const FAKE_NO_IG_PAGE_NAME = 'E2E Page without Instagram'
const LOGIN_PERMISSIONS = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  // The two of Instagram, so that one login serves both channels
  'instagram_basic',
  'instagram_manage_messages'
]

export const TEMPLATE_NAME = 'order_update'
export const TEMPLATE_LANGUAGE = 'en_US'
export const TEMPLATE_BODY = 'Hello {{1}}, your order {{2}} is on its way.'
// A template as a real account has them: a long name in one piece and a tracking link in the body, neither
// of which has a place to break. The dialog of templates must hold them on a phone (MODAL-390)
export const LONG_TEMPLATE_NAME = 'shipment_notification_with_tracking_link_and_delivery_window_v2'
export const LONG_TEMPLATE_BODY =
  'Track it at https://tracking.example.com/shipments/0123456789abcdef0123456789abcdef/status?lang=en_US'

export interface SentToGraph {
  to: string
  templateName: string
  variables: string[]
  authorization: string | undefined
}

export interface FakeGraph {
  // The sends that reached it, in order
  sent: SentToGraph[]
  // How many times the list of templates was asked for
  templateListings: () => number
  // The next `count` lists of templates fail with a server error
  failNextTemplateListings: (count: number) => void
  // The ids of the nodes that something tried to subscribe the app to (POST subscribed_apps), in order
  subscriptions: () => string[]
  // While it is on, Meta refuses the token of the Page (code 190), as it does once the person removes the app
  breakPageToken: (broken: boolean) => void
  close: () => Promise<void>
}

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readText(request)) || 'null')
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

interface TemplateSend {
  to: string
  template: {
    name: string
    components?: { parameters: { text: string }[] }[]
  }
}

// What the plugin of WhatsApp needs from Graph for the templates: the list of an account and a send.
// A real server, because the api and the worker are other processes. Anything else is a 404, so a call
// the case did not expect fails the case instead of passing in silence.
export async function startFakeGraph(): Promise<FakeGraph> {
  const sent: SentToGraph[] = []
  let listings = 0
  let failures = 0
  const subscriptions: string[] = []
  let pageTokenBroken = false

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake')
      const segments = url.pathname.split('/').filter(Boolean)
      // The Instagram account is read only when the call asks for it, as Meta does (it needs a permission)
      const asksInstagram = (url.searchParams.get('fields') ?? '').includes(
        'instagram_business_account'
      )
      // /v23.0/{id}/{edge}
      const [, id, edge] = segments
      if (
        request.method === 'GET' &&
        id === FAKE_BUSINESS_ACCOUNT_ID &&
        edge === WhatsAppApi.EDGE_TEMPLATES
      ) {
        listings += 1
        if (failures > 0) {
          failures -= 1
          reply(response, HttpStatusCodes.INTERNAL_SERVER_ERROR, {
            error: { message: 'unavailable', code: 2 }
          })
          return
        }
        reply(response, HttpStatusCodes.OK, {
          data: [
            {
              name: TEMPLATE_NAME,
              language: TEMPLATE_LANGUAGE,
              status: WhatsAppTemplateStatuses.APPROVED,
              components: [{ type: WhatsAppTemplateComponents.BODY, text: TEMPLATE_BODY }]
            },
            {
              name: LONG_TEMPLATE_NAME,
              language: TEMPLATE_LANGUAGE,
              status: WhatsAppTemplateStatuses.APPROVED,
              components: [{ type: WhatsAppTemplateComponents.BODY, text: LONG_TEMPLATE_BODY }]
            }
          ]
        })
        return
      }
      if (
        request.method === 'POST' &&
        id === FAKE_PHONE_NUMBER_ID &&
        edge === WhatsAppApi.EDGE_MESSAGES
      ) {
        const body = (await readJson(request)) as TemplateSend
        sent.push({
          to: body.to,
          templateName: body.template.name,
          variables: (body.template.components?.[0]?.parameters ?? []).map(item => item.text),
          authorization: request.headers.authorization
        })
        reply(response, HttpStatusCodes.OK, { messages: [{ id: `wamid.e2e-${sent.length}` }] })
        return
      }
      // The login with Facebook. The code of the dialog for a short token, and that one for a long-lived token,
      // proved with the secret of the app in the body (never in the address)
      if (request.method === 'POST' && id === 'oauth' && edge === 'access_token') {
        const form = new URLSearchParams(await readText(request))
        const proved =
          form.get('client_secret') === FAKE_APP_SECRET && form.get('client_id') === FAKE_APP_ID
        const code = form.get('code')
        const short = form.get('fb_exchange_token')
        if (!proved || request.headers.authorization !== undefined) {
          reply(response, HttpStatusCodes.BAD_REQUEST, { error: { message: 'bad app', code: 101 } })
        } else if (code === FAKE_LOGIN_CODE) {
          reply(response, HttpStatusCodes.OK, { access_token: FAKE_USER_SHORT })
        } else if (code === FAKE_LOGIN_CODE_CLEARED) {
          reply(response, HttpStatusCodes.OK, { access_token: FAKE_USER_SHORT_CLEARED })
        } else if (form.get('grant_type') === 'fb_exchange_token' && short === FAKE_USER_SHORT) {
          reply(response, HttpStatusCodes.OK, { access_token: FAKE_USER_TOKEN })
        } else if (
          form.get('grant_type') === 'fb_exchange_token' &&
          short === FAKE_USER_SHORT_CLEARED
        ) {
          reply(response, HttpStatusCodes.OK, { access_token: FAKE_USER_TOKEN_CLEARED })
        } else {
          reply(response, HttpStatusCodes.BAD_REQUEST, {
            error: { message: 'bad code', code: 100 }
          })
        }
        return
      }
      const userBearer = request.headers.authorization
      const isUser =
        userBearer === `Bearer ${FAKE_USER_TOKEN}` ||
        userBearer === `Bearer ${FAKE_USER_TOKEN_CLEARED}`
      if (request.method === 'GET' && isUser) {
        if (id === 'me' && edge === 'permissions') {
          const cleared = userBearer === `Bearer ${FAKE_USER_TOKEN_CLEARED}`
          reply(response, HttpStatusCodes.OK, {
            data: LOGIN_PERMISSIONS.map(permission => ({
              permission,
              status: cleared && permission === 'pages_read_engagement' ? 'declined' : 'granted'
            }))
          })
        } else if (id === 'me' && edge === 'accounts') {
          reply(response, HttpStatusCodes.OK, { data: [] })
        } else if (id === 'me' && edge === 'businesses') {
          reply(response, HttpStatusCodes.OK, {
            data: [{ id: FAKE_BUSINESS_ID, name: 'E2E portfolio' }]
          })
        } else if (id === FAKE_BUSINESS_ID && edge === 'owned_pages') {
          reply(response, HttpStatusCodes.OK, {
            data: [
              {
                id: FAKE_PAGE_ID,
                name: FAKE_PAGE_NAME,
                ...(asksInstagram
                  ? { instagram_business_account: { id: FAKE_IG_ID, username: FAKE_IG_USERNAME } }
                  : {})
              },
              { id: FAKE_NO_IG_PAGE_ID, name: FAKE_NO_IG_PAGE_NAME }
            ]
          })
        } else if (id === FAKE_PAGE_ID && edge === undefined) {
          // The token of the Page, read with the token of the person
          reply(response, HttpStatusCodes.OK, {
            id: FAKE_PAGE_ID,
            access_token: FAKE_PAGE_TOKEN,
            ...(asksInstagram ? { instagram_business_account: { id: FAKE_IG_ID } } : {})
          })
        } else {
          reply(response, HttpStatusCodes.NOT_FOUND, {
            error: { message: 'not served', code: 100 }
          })
        }
        return
      }
      // Connecting a Messenger Page: its id and name by `me`, and the subscription of the app to it. Any
      // token but the good one is refused with Meta's code 190, as an invalid or expired one is.
      const bearer = request.headers.authorization
      const isGoodPageToken =
        bearer === `Bearer ${FAKE_PAGE_TOKEN}` || bearer === `Bearer ${FAKE_PAGE_TOKEN_RENEWED}`
      // `me` itself, not its edges: `me/subscribed_apps` is Instagram's, and is answered further down
      if (request.method === 'GET' && id === 'me' && edge === undefined) {
        if (isGoodPageToken && !pageTokenBroken) {
          // The Page, and the account it links when the plugin asks for it (Instagram does)
          reply(response, HttpStatusCodes.OK, {
            id: FAKE_PAGE_ID,
            name: FAKE_PAGE_NAME,
            ...(asksInstagram
              ? { instagram_business_account: { id: FAKE_IG_ID, username: FAKE_IG_USERNAME } }
              : {})
          })
        } else if (bearer === `Bearer ${FAKE_OTHER_PAGE_TOKEN}`) {
          reply(response, HttpStatusCodes.OK, { id: FAKE_OTHER_PAGE_ID, name: 'E2E Other Page' })
        } else if (bearer === `Bearer ${FAKE_BUSY_TOKEN}`) {
          reply(response, HttpStatusCodes.BAD_REQUEST, {
            error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 }
          })
        } else {
          reply(response, HttpStatusCodes.BAD_REQUEST, {
            error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 }
          })
        }
        return
      }
      // What the plugin reads before it subscribes (nothing is subscribed blind): the app of the token, and
      // the apps that already have fields on the Page (none here)
      if (request.method === 'GET' && id === 'app' && isGoodPageToken) {
        reply(response, HttpStatusCodes.OK, { id: FAKE_APP_ID })
        return
      }
      if (
        request.method === 'GET' &&
        (id === FAKE_PAGE_ID || id === 'me') &&
        edge === 'subscribed_apps' &&
        isGoodPageToken
      ) {
        reply(response, HttpStatusCodes.OK, { data: [] })
        return
      }
      // Whatever the token, a subscription attempt is counted: a case proves that none was made
      if (request.method === 'POST' && edge === 'subscribed_apps') subscriptions.push(id ?? '')
      if (
        request.method === 'POST' &&
        (id === FAKE_PAGE_ID || id === 'me') &&
        edge === 'subscribed_apps' &&
        isGoodPageToken
      ) {
        reply(response, HttpStatusCodes.OK, { success: true })
        return
      }
      reply(response, HttpStatusCodes.NOT_FOUND, { error: { message: 'not served', code: 100 } })
    })().catch(() => reply(response, HttpStatusCodes.INTERNAL_SERVER_ERROR, {}))
  })
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(GRAPH_PORT, GRAPH_HOST, resolveListening)
  })
  return {
    sent,
    templateListings: () => listings,
    subscriptions: () => [...subscriptions],
    breakPageToken: broken => {
      pageTokenBroken = broken
    },
    failNextTemplateListings: count => {
      failures = count
    },
    close: () =>
      new Promise<void>((resolveClosed, reject) => {
        server.close(error => (error ? reject(error) : resolveClosed()))
        server.closeAllConnections()
      })
  }
}
