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
