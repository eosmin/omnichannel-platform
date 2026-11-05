import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import {
  WhatsAppApi,
  WhatsAppTemplateComponents,
  WhatsAppTemplateStatuses
} from '@platform/core/domain'
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
export const FAKE_REJECTED_TOKEN = 'e2e-rejected-token'
// A token for which Meta answers with its throttle code (4): the page is asked to wait
export const FAKE_BUSY_TOKEN = 'e2e-busy-token'
// The app of the token (`GET app?fields=id`), whose entry is picked among the apps of the Page
export const FAKE_APP_ID = '1804256354142951'
export const FAKE_PAGE_NAME = 'E2E Page'

export const TEMPLATE_NAME = 'order_update'
export const TEMPLATE_LANGUAGE = 'en_US'
export const TEMPLATE_BODY = 'Hello {{1}}, your order {{2}} is on its way.'

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
  close: () => Promise<void>
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
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

  const server = createServer((request, response) => {
    void (async () => {
      const segments = new URL(request.url ?? '/', 'http://fake').pathname
        .split('/')
        .filter(Boolean)
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
      // Connecting a Messenger Page: its id and name by `me`, and the subscription of the app to it. Any
      // token but the good one is refused with Meta's code 190, as an invalid or expired one is.
      const bearer = request.headers.authorization
      if (request.method === 'GET' && id === 'me') {
        if (bearer === `Bearer ${FAKE_PAGE_TOKEN}`) {
          reply(response, HttpStatusCodes.OK, { id: FAKE_PAGE_ID, name: FAKE_PAGE_NAME })
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
      if (request.method === 'GET' && id === 'app' && bearer === `Bearer ${FAKE_PAGE_TOKEN}`) {
        reply(response, HttpStatusCodes.OK, { id: FAKE_APP_ID })
        return
      }
      if (
        request.method === 'GET' &&
        id === FAKE_PAGE_ID &&
        edge === 'subscribed_apps' &&
        bearer === `Bearer ${FAKE_PAGE_TOKEN}`
      ) {
        reply(response, HttpStatusCodes.OK, { data: [] })
        return
      }
      if (
        request.method === 'POST' &&
        id === FAKE_PAGE_ID &&
        edge === 'subscribed_apps' &&
        bearer === `Bearer ${FAKE_PAGE_TOKEN}`
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
