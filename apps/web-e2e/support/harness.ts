import type { Page } from '@playwright/test'

// Brings the `window.e2eRealtime` type of the web app into this program (it is erased at runtime)
export type { E2eRealtimeHarness } from '../../web/lib/realtime/e2e-harness'
export { ConnectionStatuses } from '../../web/lib/realtime/connection-status'

export function harnessPath(storeId: string): string {
  return `/s/${storeId}/e2e-realtime`
}

export const statusOf = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => window.e2eRealtime?.status())

export const waitingOf = (page: Page): Promise<number | undefined> =>
  page.evaluate(() => window.e2eRealtime?.waiting())

export const dropConnection = (page: Page): Promise<void> =>
  page.evaluate(() => window.e2eRealtime?.dropConnection())

// The id of the queued message, which the api keeps as its idempotency key
export const enqueue = (page: Page, conversationId: string, content: string): Promise<string> =>
  page.evaluate(
    ({ id, text }) => {
      if (window.e2eRealtime === undefined) throw new Error('the harness page is not open')
      return window.e2eRealtime.enqueue(id, text)
    },
    { id: conversationId, text: content }
  )

export const heard = (page: Page, event: string): Promise<unknown[]> =>
  page.evaluate(
    name => (window.e2eRealtime?.heard ?? []).filter(h => h.event === name).map(h => h.payload),
    event
  )
