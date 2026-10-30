import { type BrowserContext, type Locator, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  ResolveUndo,
  SystemMessageEvents
} from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { writeNote } from '../support/api'
import {
  addManyMessagesTo,
  addMessageTo,
  addOriginTo,
  addSnippetTo,
  mentionsOf,
  newConversationIn,
  messagesOf,
  newConversationWithUnread,
  setResolveBehavior,
  statusOf,
  timelineOf,
  storeIdNamed,
  unreadCountOf
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An agent reads the thread, writes notes and resolves, so it is what the cases need. The magic link is
// limited to 5 requests a minute for each address and the whole suite runs inside that minute: the
// address of the administrator is already spent by the other specs.
const AGENT = 'agent@test.com'
const MINUTE_MS = 60_000
// The first packet of a Socket.IO connection that the server accepted
const SOCKET_IO_CONNECTED = '40'

// The list of conversations repeats the last message, so the cases look inside the thread
const threadOf = (page: Page) => page.getByRole('list', { name: en.inbox.thread.label })

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS)

// One session for the cases: the magic link is limited for each address
test.describe.serial('the thread of a conversation', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string
  // The access token the page last sent to the api: a second writer without asking for another link,
  // because the link is limited for each address
  let token = ''

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    page.on('request', request => {
      const authorization = request.headers()['authorization']
      if (authorization?.startsWith('Bearer ')) token = authorization.slice('Bearer '.length)
    })
    await signIn(page, AGENT)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('draws the customer, the reply with its ticks, the note, the line of the system and the origin', async () => {
    const conversationId = await newConversationIn(storeId)
    const first = await addMessageTo(storeId, conversationId, {
      content: 'Do you have it in blue?',
      createdAt: minutesAgo(30)
    })
    await addOriginTo(storeId, conversationId, first.id, 'Spring sale')
    await addMessageTo(storeId, conversationId, {
      content: 'Yes, we do',
      authorType: AuthorType.AGENT,
      deliveryStatus: DeliveryStatus.READ,
      createdAt: minutesAgo(20)
    })
    await addMessageTo(storeId, conversationId, {
      content: 'Check the stock first',
      type: MessageType.INTERNAL_NOTE,
      createdAt: minutesAgo(10)
    })
    await addMessageTo(storeId, conversationId, {
      type: MessageType.SYSTEM,
      authorType: AuthorType.SYSTEM,
      content: '',
      system: { event: SystemMessageEvents.RESOLVED, actorType: 'system' },
      createdAt: minutesAgo(5)
    })

    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(threadOf(page).getByText('Do you have it in blue?')).toBeVisible()
    await expect(threadOf(page).getByText('Yes, we do')).toBeVisible()
    await expect(
      threadOf(page).getByText(en.inbox.thread.ticks.read, { exact: true })
    ).toBeAttached()
    await expect(threadOf(page).getByText('Check the stock first')).toBeVisible()
    await expect(
      threadOf(page).getByText(en.inbox.thread.internalNote, { exact: true })
    ).toBeVisible()
    await expect(threadOf(page).getByText('Resolved automatically')).toBeVisible()
    await expect(page.getByText('Spring sale')).toBeVisible()
  })

  test('shows a note written by another session without a reload', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      content: 'First message',
      createdAt: minutesAgo(1)
    })
    // The note is announced once and not replayed: the socket has to be up before it is written
    // The listener sits on the socket from the moment it is created, so the frame cannot go by first
    const connected = new Promise<void>(resolve => {
      page.once('websocket', socket => {
        socket.on('framereceived', frame => {
          if (String(frame.payload).startsWith(SOCKET_IO_CONNECTED)) resolve()
        })
      })
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(threadOf(page).getByText('First message')).toBeVisible()
    await connected
    expect(token).not.toBe('')

    await writeNote(token, storeId, conversationId, 'Written elsewhere')

    await expect(threadOf(page).getByText('Written elsewhere')).toBeVisible()
  })

  test('marks the conversation read when it opens', async () => {
    const conversationId = await newConversationWithUnread(storeId, 2)
    await addMessageTo(storeId, conversationId, {
      content: 'Are you there?',
      createdAt: minutesAgo(1)
    })

    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(threadOf(page).getByText('Are you there?')).toBeVisible()

    await expect.poll(() => unreadCountOf(conversationId)).toBe(0)
  })

  test('keeps what the reader is looking at where it was when older messages load', async () => {
    const PAGE_SIZE = 25
    const conversationId = await newConversationIn(storeId)
    await addManyMessagesTo(storeId, conversationId, PAGE_SIZE * 3)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const thread = threadOf(page)
    await expect(thread.getByText(`Message number ${PAGE_SIZE * 3}`)).toBeVisible()

    // The oldest message that is loaded, at the top of the view
    const oldestLoaded = thread.getByText(`Message number ${PAGE_SIZE * 2 + 1}`)
    await oldestLoaded.scrollIntoViewIfNeeded()
    const scroller = thread.locator('xpath=ancestor::div[contains(@class, "overflow-y-auto")]')
    // To the top and the position of the message in one step: the older page is asked for when the
    // top comes into view, and the position has to be read before that can have happened
    const before = await oldestLoaded.evaluate(node => {
      const container = node.closest('.overflow-y-auto')
      if (container === null) throw new Error('the thread has no scroll container')
      container.scrollTop = 0
      return node.getBoundingClientRect().y
    })

    // Older ones are asked for when the top comes into view
    await expect(thread.getByText(`Message number ${PAGE_SIZE * 2}`)).toBeAttached()

    // What went in above pushed the message down and the scroll followed by the same amount, so it is
    // still where the reader saw it. A browser that also anchored the scroll would move it twice.
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const after = (await oldestLoaded.boundingBox())?.y
    expect(Math.abs((after ?? Infinity) - before)).toBeLessThanOrEqual(2)
  })

  test('keeps the place also when the last page goes in and the button goes away', async () => {
    const PAGE_SIZE = 25
    const LAST_PAGE_SIZE = 5
    const total = PAGE_SIZE * 2 + LAST_PAGE_SIZE
    const conversationId = await newConversationIn(storeId)
    await addManyMessagesTo(storeId, conversationId, total)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const thread = threadOf(page)
    await expect(thread.getByText(`Message number ${total}`)).toBeVisible()

    const toTopAndMeasure = (message: Locator) =>
      message.evaluate(node => {
        const container = node.closest('.overflow-y-auto')
        if (container === null) throw new Error('the thread has no scroll container')
        container.scrollTop = 0
        return node.getBoundingClientRect().y
      })
    const loadEarlierButton = page.getByRole('button', { name: en.inbox.thread.loadEarlier })

    // The second page, with the third still to come
    const firstOfPage1 = thread.getByText(`Message number ${total - PAGE_SIZE + 1}`)
    const beforePage2 = await toTopAndMeasure(firstOfPage1)
    await expect(
      thread.getByText(`Message number ${LAST_PAGE_SIZE + 1}`, { exact: true })
    ).toBeAttached()
    await expect(loadEarlierButton).toBeVisible()
    expect(
      Math.abs(((await firstOfPage1.boundingBox())?.y ?? Infinity) - beforePage2)
    ).toBeLessThanOrEqual(2)

    // The last page: the button is gone in the same step, and the place is kept all the same
    const firstOfPage2 = thread.getByText(`Message number ${LAST_PAGE_SIZE + 1}`, { exact: true })
    const beforePage3 = await toTopAndMeasure(firstOfPage2)
    await expect(thread.getByText('Message number 1', { exact: true })).toBeAttached()
    await expect(loadEarlierButton).toBeHidden()
    expect(
      Math.abs(((await firstOfPage2.boundingBox())?.y ?? Infinity) - beforePage3)
    ).toBeLessThanOrEqual(2)
  })

  test('scrolls to a message that is quoted even when it is drawn as a line', async () => {
    const conversationId = await newConversationIn(storeId)
    const location = await addMessageTo(storeId, conversationId, {
      type: MessageType.LOCATION,
      content: '',
      createdAt: minutesAgo(3)
    })
    await addMessageTo(storeId, conversationId, {
      content: 'Thanks, on my way',
      authorType: AuthorType.AGENT,
      deliveryStatus: DeliveryStatus.SENT,
      replyToMessageId: location.id,
      createdAt: minutesAgo(2)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await threadOf(page).getByRole('button', { name: /./ }).first().click()

    await expect(page.locator(`#message-${location.id}`)).toBeFocused()
  })

  test('sends a reply with Enter, keeps the line break of Shift+Enter, and writes a note from its own tab', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const reply = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await reply.fill('first line')
    await reply.press('Shift+Enter')
    await reply.pressSequentially('second line')
    await reply.press('Enter')

    await expect(reply).toHaveValue('')
    await expect
      .poll(async () => (await messagesOf(conversationId)).map(m => m.content))
      .toEqual(['first line\nsecond line'])

    await page.getByRole('tab', { name: en.inbox.composer.note }).click()
    const noteBox = page.getByRole('textbox', { name: en.inbox.composer.noteLabel })
    await noteBox.fill('for the team only')
    await noteBox.press('Enter')

    const note = threadOf(page).getByRole('listitem').filter({ hasText: 'for the team only' })
    await expect(note).toBeVisible()
    await expect(note.getByText(en.inbox.thread.internalNote)).toBeVisible()
  })
  test('inserts a saved reply from the slash menu, with the keyboard', async () => {
    const shortcut = `hi-${Date.now()}`
    await addSnippetTo(storeId, shortcut)
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const reply = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })

    await reply.fill('/')
    await expect(
      page.getByRole('listbox', { name: en.inbox.composer.menu.label.commands })
    ).toBeVisible()
    await reply.fill(`/snippet ${shortcut}`)
    await expect(page.getByRole('option', { name: new RegExp(`/${shortcut}`) })).toBeVisible()
    await reply.press('Enter')

    await expect(reply).toHaveValue('Hello!')
    // Picking is not sending
    expect(await messagesOf(conversationId)).toEqual([])
  })

  test('snoozes from the /snooze command with a preset', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const reply = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })

    await reply.fill('/snooze')
    await reply.press('Enter')
    const dialog = page.getByRole('dialog', { name: en.inbox.snooze.title })
    await dialog
      .getByRole('button', { name: new RegExp(en.inbox.snooze.presets.tomorrowMorning) })
      .click()

    await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.SNOOZED)
    await expect(page.getByRole('button', { name: en.inbox.actions.wakeUp })).toBeVisible()
  })

  test('resolves with the options dialog and reopens from the header', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await page.getByRole('button', { name: en.inbox.actions.resolve }).click()
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await dialog.getByRole('textbox', { name: en.inbox.resolve.reason }).fill('Sorted out')
    await dialog.getByRole('button', { name: en.inbox.resolve.confirm }).click()

    await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.RESOLVED)
    await page.getByRole('button', { name: en.inbox.actions.reopen }).click()
    await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.OPEN)
  })

  test('resolves at once when the store asks for it, and Undo takes it back', async () => {
    await setResolveBehavior(storeId, { showOptions: false, closingSnippetId: null })
    try {
      const conversationId = await newConversationIn(storeId)
      await page.goto(AppPaths.store.conversation(storeId, conversationId))

      await page.getByRole('button', { name: en.inbox.actions.resolve }).click()
      await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.RESOLVED)
      await page.getByRole('button', { name: en.common.undo }).click()

      await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.OPEN)
    } finally {
      await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
    }
  })

  test('resolves at once and the server sends the closing message after the Undo time', async () => {
    const snippetId = await addSnippetTo(storeId, `bye-${Date.now()}`)
    await setResolveBehavior(storeId, { showOptions: false, closingSnippetId: snippetId })
    try {
      const conversationId = await newConversationIn(storeId)
      await page.goto(AppPaths.store.conversation(storeId, conversationId))

      await page.getByRole('button', { name: en.inbox.actions.resolve }).click()

      await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.RESOLVED)
      // The line of the system comes first and the message follows, once the time to undo is over. A
      // message sent as a reply would have reopened the conversation and a "reopened" line would follow.
      await expect
        .poll(async () => (await timelineOf(conversationId)).map(m => [m.type, m.content]), {
          timeout: ResolveUndo.DURATION_MS + ResolveUndo.CLOSING_GRACE_MS + 15_000
        })
        .toEqual([
          [MessageType.SYSTEM, null],
          [MessageType.TEXT, 'Hello!']
        ])
      expect(await statusOf(conversationId)).toBe(ConversationStatus.RESOLVED)
    } finally {
      await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
    }
  })

  test('mentions a teammate in a note and stores who was mentioned', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await page.getByRole('tab', { name: en.inbox.composer.note }).click()
    const noteBox = page.getByRole('textbox', { name: en.inbox.composer.noteLabel })

    await noteBox.pressSequentially('please look @')
    await expect(
      page.getByRole('listbox', { name: en.inbox.composer.menu.label.mentions })
    ).toBeVisible()
    await noteBox.press('Enter')
    await noteBox.pressSequentially('at this')
    await noteBox.press('Enter')

    await expect.poll(async () => (await mentionsOf(conversationId)).flat()).toHaveLength(1)
  })
})
