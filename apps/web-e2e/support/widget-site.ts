import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

import type { Page, Response } from '@playwright/test'

import { HttpStatusCodes } from '@platform/core/errors'

import { API_URL } from './env'

// The address the api expects the script at (WIDGET_SCRIPT_URL); a plain http origin is allowed for a
// machine of the developer, so the stand-in site needs no certificate
export const SITE_ORIGIN = 'http://localhost:4173'
const SITE_PAGE = `${SITE_ORIGIN}/`
const BUNDLE = resolve(import.meta.dirname, '../../../dist/apps/widget/widget.js')

const apiOrigin = new URL(API_URL)

// The strictest policy a store can have: scripts of its own origin, no inline script and no
// stylesheet source at all, and the api (and its socket) as the only place the page may talk to
export const STRICT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `connect-src ${apiOrigin.origin} ${apiOrigin.protocol === 'https:' ? 'wss' : 'ws'}://${apiOrigin.host}`
].join('; ')

// The snippet as the store pastes it, pointing at the bundle that `nx build widget` wrote
function pageWith(snippet: string): string {
  const patched = snippet
    .replace(/src="[^"]*"/, 'src="/widget.js"')
    .replace(' async>', ' data-locale="en" async>')
  if (!patched.includes('src="/widget.js"') || !patched.includes('data-locale="en"')) {
    throw new Error(`the snippet changed shape, update the stand-in site: ${snippet}`)
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><h1>Shop</h1>${patched}</body></html>`
}

// Serves the stand-in site on the port of WIDGET_SCRIPT_URL: the page holding the snippet under the
// strict policy, and the bundle. A real server, because a page answered by the test runner has no
// address and the browser then refuses it any request to the loopback api.
export async function startSite(snippet: string): Promise<() => Promise<void>> {
  const bundle = readFileSync(BUNDLE)
  const server = createServer((request, response) => {
    const headers = { 'content-security-policy': STRICT_CSP }
    if (request.url === '/widget.js') {
      response
        .writeHead(HttpStatusCodes.OK, { ...headers, 'content-type': 'text/javascript' })
        .end(bundle)
    } else if (request.url === '/') {
      response
        .writeHead(HttpStatusCodes.OK, { ...headers, 'content-type': 'text/html' })
        .end(pageWith(snippet))
    } else {
      response.writeHead(HttpStatusCodes.NOT_FOUND).end()
    }
  })
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(new URL(SITE_ORIGIN).port, resolveListening)
  })
  return () =>
    new Promise<void>((resolveClosed, reject) => {
      server.close(error => (error ? reject(error) : resolveClosed()))
      server.closeAllConnections()
    })
}

export function openSite(page: Page): Promise<Response | null> {
  return page.goto(SITE_PAGE)
}
