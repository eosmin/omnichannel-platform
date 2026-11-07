import { type BrowserContext, test as base } from '@playwright/test'

import { FORWARDED_FOR, newClientIp } from './client-ip'
import { API_URL, WEB_URL } from './env'

const SERVICE_ORIGINS = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])

// Makes the context reach the web app and the api from an address of its own. For a context that a
// spec opens by hand (browser.newContext); the contexts of `test` already have it. Returns the way to
// change the address: the api limits each route to 100 requests a minute for each address, and a spec that
// keeps one session for many cases (the inbox) asks for a new address before each, so that its cases do
// not share one minute of that limit (the limit itself is a control that stays as it is).
export async function reachServicesFromOwnAddress(context: BrowserContext): Promise<() => void> {
  let ip = newClientIp()
  await context.route(
    url => SERVICE_ORIGINS.has(url.origin),
    route => route.continue({ headers: { ...route.request().headers(), [FORWARDED_FOR]: ip } })
  )
  return () => {
    const previous = ip
    do ip = newClientIp()
    while (ip === previous)
  }
}

// `test` of the specs: every context reaches the web app and the api from an address of its own
export const test = base.extend({
  context: async ({ context }, use) => {
    await reachServicesFromOwnAddress(context)
    await use(context)
  }
})

export { expect } from '@playwright/test'
