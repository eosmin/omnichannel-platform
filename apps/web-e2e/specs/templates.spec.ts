import { type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newWhatsAppConversationWrittenAgo, storeIdNamed, timelineOf } from '../support/database'
import { type FakeGraph, startFakeGraph, TEMPLATE_NAME } from '../support/fake-graph'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An agent may send templates, and the link of the administrator is already spent by other specs
const AGENT = 'agent@test.com'
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
// The reconnection of the socket backs off, so coming back online takes longer than the default wait
const RECONNECT_TIMEOUT_MS = 30_000
const SOCKET_PATH = '/socket.io'

const composer = en.inbox.composer
const filled = 'Hello Ana, your order 1042 is on its way.'

const variableLabel = (number: number): string =>
  composer.template.variable.replace('{number}', String(number))

const threadOf = (page: Page) => page.getByRole('list', { name: en.inbox.thread.label })

// The dialog, opened from a conversation whose window is closed, with the template chosen and filled
async function fillTemplate(page: Page): Promise<void> {
  await page.getByRole('button', { name: composer.window.chooseTemplate }).click()
  const dialog = page.getByRole('dialog', { name: composer.template.title })
  await dialog.getByRole('radio', { name: new RegExp(TEMPLATE_NAME) }).check()
  await dialog.getByLabel(variableLabel(1)).fill('Ana')
  await dialog.getByLabel(variableLabel(2)).fill('1042')
  await expect(dialog.getByText(filled)).toBeVisible()
}

// The messaging window of WhatsApp and the templates that go through it, against a fake Graph API that
// the api and the worker call instead of Meta's
test.describe.serial('the messaging window and the templates of WhatsApp', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string
  let graph: FakeGraph
  // The socket of the page goes through here, so that a case can cut it and keep it cut. Playwright's
  // offline mode does not close a socket that is up: the page would notice after the ping timeout.
  let isSocketCut = false
  const sockets: WebSocketRoute[] = []
  const cutSocket = async (): Promise<void> => {
    isSocketCut = true
    await Promise.all(sockets.splice(0).map(socket => socket.close().catch(() => undefined)))
  }

  test.beforeAll(async ({ browser }) => {
    graph = await startFakeGraph()
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await page.routeWebSocket(
      url => url.pathname.startsWith(SOCKET_PATH),
      socket => {
        if (isSocketCut) {
          void socket.close()
          return
        }
        socket.connectToServer()
        sockets.push(socket)
      }
    )
    await signIn(page, AGENT)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
    await graph.close()
  })
  test.beforeEach(() => {
    graph.sent.length = 0
    graph.failNextTemplateListings(0)
  })

  test('warns with the time left when less than two hours remain', async () => {
    const conversationId = await newWhatsAppConversationWrittenAgo(
      storeId,
      22 * HOUR_MS + 30 * MINUTE_MS
    )
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(page.getByRole('status').filter({ hasText: /closes in [01]h \d+m/ })).toBeVisible()
    // Still open: the box is there and no template is asked for
    await expect(page.getByRole('textbox', { name: composer.replyLabel })).toBeVisible()
    await expect(page.getByRole('button', { name: composer.window.chooseTemplate })).toHaveCount(0)
  })

  test('closes the box and offers a template when the window is over', async () => {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, 25 * HOUR_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(page.getByText(composer.window.closedTemplate)).toBeVisible()
    await expect(page.getByRole('textbox', { name: composer.replyLabel })).toHaveCount(0)
    await expect(page.getByRole('button', { name: composer.window.chooseTemplate })).toBeVisible()
  })

  test('sends a template: choose, fill the values, preview, send', async () => {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, 25 * HOUR_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await fillTemplate(page)
    const dialog = page.getByRole('dialog', { name: composer.template.title })
    await expect(dialog.getByRole('button', { name: composer.template.send })).toBeEnabled()
    await dialog.getByRole('button', { name: composer.template.send }).click()

    await expect(dialog).toBeHidden()
    await expect(threadOf(page).getByText(filled)).toBeVisible()
    // The worker hands it to the provider with the values in their places
    await expect.poll(() => graph.sent.length).toBe(1)
    expect(graph.sent[0]).toMatchObject({ templateName: TEMPLATE_NAME, variables: ['Ana', '1042'] })
    expect((await timelineOf(conversationId)).map(item => item.type)).toContain(
      MessageType.TEMPLATE
    )
  })

  test('refuses to send while there is no connection and allows it when it is back', async () => {
    // Coming back waits for the socket, which backs off
    test.setTimeout(3 * RECONNECT_TIMEOUT_MS)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, 25 * HOUR_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await fillTemplate(page)
    const dialog = page.getByRole('dialog', { name: composer.template.title })

    await cutSocket()
    try {
      await expect(dialog.getByText(composer.template.offline)).toBeVisible()
      await expect(dialog.getByRole('button', { name: composer.template.send })).toBeDisabled()
    } finally {
      isSocketCut = false
    }

    await expect(dialog.getByText(composer.template.offline)).toBeHidden({
      timeout: RECONNECT_TIMEOUT_MS
    })
    await expect(dialog.getByRole('button', { name: composer.template.send })).toBeEnabled()
    expect(graph.sent).toHaveLength(0)
  })

  test('shows the failure and a retry sends the template once', async () => {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, 25 * HOUR_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await fillTemplate(page)
    const dialog = page.getByRole('dialog', { name: composer.template.title })

    // The list was read when the dialog opened; the api reads it again before it stores the message
    graph.failNextTemplateListings(1)
    await dialog.getByRole('button', { name: composer.template.send }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(await timelineOf(conversationId)).toHaveLength(1)
    expect(graph.sent).toHaveLength(0)

    await dialog.getByRole('button', { name: composer.template.send }).click()

    await expect(dialog).toBeHidden()
    await expect.poll(() => graph.sent.length).toBe(1)
    await expect(threadOf(page).getByText(filled)).toHaveCount(1)
    // The one message of the customer and the one template: nothing was stored twice
    expect((await timelineOf(conversationId)).map(item => item.type)).toEqual([
      MessageType.TEXT,
      MessageType.TEMPLATE
    ])
  })
})
