import { randomInt } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX } from '@platform/core/api'
import { TenantHeaders } from '@platform/core/auth'

export interface Actor {
  id: string
  email: string
  token: string
}

export interface StoreRef {
  id: string
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'

// Each request comes from an address of its own, as it would from the many clients of the real api:
// the rate limit is counted per address in a Redis that every run shares, and a suite that sent
// everything from one would be limited by it
function freshAddress(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`
}

export interface TestAgent {
  get: (path: string) => supertest.Test
  post: (path: string) => supertest.Test
  patch: (path: string) => supertest.Test
  put: (path: string) => supertest.Test
  delete: (path: string) => supertest.Test
}

// The last answers of the api to the current test, for tests/helpers/test-environment.cjs to print
// when the test fails
interface RecordedResponse {
  method: string
  path: string
  status: number
  code: string | undefined
}
const RECENT_LIMIT = 10
function record(entry: RecordedResponse): void {
  const store = globalThis as { __recentResponses?: RecordedResponse[] }
  const recent = (store.__recentResponses ??= [])
  recent.push(entry)
  if (recent.length > RECENT_LIMIT) recent.shift()
}

function agent(app: INestApplication, headers: Record<string, string>): TestAgent {
  const server = app.getHttpServer() as Parameters<typeof supertest>[0] // Nest types it as any
  const send = (method: Method, path: string): supertest.Test => {
    let request = supertest(server)[method](`${API_PREFIX}${path}`)
    request = request.set('x-forwarded-for', freshAddress())
    for (const [name, value] of Object.entries(headers)) request = request.set(name, value)
    request.once('response', (response: supertest.Response) => {
      const body = response.body as { error?: { code?: string } } | undefined
      record({ method, path, status: response.status, code: body?.error?.code })
    })
    return request
  }
  return {
    get: (path: string) => send('get', path),
    post: (path: string) => send('post', path),
    patch: (path: string) => send('patch', path),
    put: (path: string) => send('put', path),
    delete: (path: string) => send('delete', path)
  }
}

// Speaks to the api the way the frontend does: a token, and the store the user is working in
export function api(app: INestApplication, user: Actor, store: StoreRef): TestAgent {
  return agent(app, { authorization: `Bearer ${user.token}`, [TenantHeaders.STORE_ID]: store.id })
}

// A user with a token and no store header, for the routes of a person and for the requests that
// forget the header
export function apiWithoutStore(app: INestApplication, user: Actor): TestAgent {
  return agent(app, { authorization: `Bearer ${user.token}` })
}

export function anonymousApi(app: INestApplication): TestAgent {
  return agent(app, {})
}
