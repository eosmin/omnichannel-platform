import { type BrowserContext, type Locator, type Page, devices } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MediaStatus,
  MessageType,
  ResolveUndo,
  SystemMessageEvents
} from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { writeNote } from '../support/api'
import {
  addManyMessagesTo,
  addMediaTo,
  addMessageTo,
  addOriginTo,
  addSnippetTo,
  firstMessageIdOf,
  mentionsOf,
  newConversationIn,
  messagesOf,
  newConversationWithUnread,
  newWhatsAppConversationWrittenAgo,
  quotedByReplyIn,
  setResolveBehavior,
  statusOf,
  timelineOf,
  storeIdNamed,
  unreadCountOf
} from '../support/database'
import { STORAGE_URL } from '../support/env'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An agent reads the thread, writes notes and resolves, so it is what the cases need. The magic link is
// limited to 5 requests a minute for each address and the whole suite runs inside that minute: the
// address of the administrator is already spent by the other specs.
const AGENT = 'agent2@test.com'
const MINUTE_MS = 60_000
// A valid 1x1 image, what the bucket would answer for the thumbnail of an ad
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)
// The first packet of a Socket.IO connection that the server accepted
const SOCKET_IO_CONNECTED = '40'

// The list of conversations repeats the last message, so the cases look inside the thread
const threadOf = (page: Page) => page.getByRole('list', { name: en.inbox.thread.label })

const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS)

// A silent WAV of the given length: 8 kHz, 8 bits, mono. The bucket does not hold the files of the
// fixtures, so the cases that play an audio answer its signed link with this.
function silentWav(seconds: number): Buffer {
  const rate = 8000
  const data = Buffer.alloc(rate * seconds, 128)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

// Answers the signed link of an audio the way a bucket does, with ranges: a browser asks for the start of
// the file to read its length, and wants a 206 for it
async function serveAudio(page: Page, seconds: number): Promise<void> {
  const wav = silentWav(seconds)
  await page.route(`${STORAGE_URL}/**`, route => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '')
    if (range === null) {
      return route.fulfill({
        status: 200,
        headers: { 'accept-ranges': 'bytes' },
        contentType: 'audio/wav',
        body: wav
      })
    }
    const start = Number(range[1])
    const end = range[2] === '' ? wav.length - 1 : Math.min(Number(range[2]), wav.length - 1)
    return route.fulfill({
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${wav.length}`
      },
      contentType: 'audio/wav',
      body: wav.subarray(start, end + 1)
    })
  })
}

// The element of a message in the thread, by its text
const messageWith = (page: Page, text: string): Locator =>
  page.locator('[id^="message-"]').filter({ hasText: text })

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
  // A route of one case (the audio of the bucket) must not answer the next one if the case failed
  test.afterEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
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

  test('draws the picture of the ad from the file of the store, never from the address of the ad', async () => {
    const remoteUrl = 'https://scontent.cdninstagram.com/never-drawn.jpg'
    const withPicture = await newConversationIn(storeId)
    const first = await addMessageTo(storeId, withPicture, {
      content: 'Is it still on sale?',
      createdAt: minutesAgo(5)
    })
    await addOriginTo(storeId, withPicture, first.id, 'Autumn sale', {
      status: MediaStatus.CLEAN,
      remoteUrl
    })
    const pending = await newConversationIn(storeId)
    const second = await addMessageTo(storeId, pending, {
      content: 'And this one?',
      createdAt: minutesAgo(4)
    })
    await addOriginTo(storeId, pending, second.id, 'Winter sale', {
      status: MediaStatus.PENDING,
      remoteUrl
    })

    // The row is enough for the signed link, but the object is not in the bucket: without an answer the
    // image fails to load and the card hides it, so the bucket is played by the browser
    await page.route(/\/ad-thumb\.png/, route =>
      route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    await page.goto(AppPaths.store.conversation(storeId, withPicture))
    const card = page.getByRole('region', { name: en.inbox.thread.origin.label })
    await expect(card.getByText('Autumn sale')).toBeVisible()
    await expect(card.locator('img')).toHaveAttribute('src', /\/stores\/.+\/ad-thumb\.png/)
    await expect(page.locator(`img[src="${remoteUrl}"]`)).toHaveCount(0)

    // Until the scan ends the card has no picture, and still not the address of the ad
    await page.goto(AppPaths.store.conversation(storeId, pending))
    await expect(card.getByText('Winter sale')).toBeVisible()
    await expect(card.locator('img')).toHaveCount(0)
    await expect(page.locator(`img[src="${remoteUrl}"]`)).toHaveCount(0)
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
      // The history keeps both lines, and the second says the resolution was taken back, not a bare "reopened"
      await expect(page.getByText(/undid the resolution/)).toBeVisible()
      await expect(page.getByText(/Reopened by/)).toHaveCount(0)
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
  test('edits an own note with the history kept, then deletes it', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await page.getByRole('tab', { name: en.inbox.composer.note }).click()
    const noteBox = page.getByRole('textbox', { name: en.inbox.composer.noteLabel })
    await noteBox.fill('first version')
    await noteBox.press('Enter')

    const note = threadOf(page).getByRole('listitem').filter({ hasText: 'first version' })
    await expect(note).toBeVisible()
    await note.hover()
    await note.getByRole('button', { name: en.inbox.thread.actions.more }).click()
    await page.getByRole('menuitem', { name: en.inbox.thread.actions.edit }).click()

    const editBox = page.getByRole('textbox', { name: en.inbox.thread.actions.editLabel })
    await editBox.fill('second version')
    await page.getByRole('button', { name: en.inbox.thread.actions.save }).click()

    const edited = threadOf(page).getByRole('listitem').filter({ hasText: 'second version' })
    await expect(edited).toBeVisible()
    await expect(edited.getByText(/^edited by /)).toBeVisible()

    await edited.hover()
    await edited.getByRole('button', { name: en.inbox.thread.actions.more }).click()
    await page.getByRole('menuitem', { name: en.inbox.thread.actions.revisions }).click()
    await expect(page.getByRole('dialog').getByText('first version')).toBeVisible()
    await page.keyboard.press('Escape')

    await edited.hover()
    await edited.getByRole('button', { name: en.inbox.thread.actions.more }).click()
    await page.getByRole('menuitem', { name: en.inbox.thread.actions.delete }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: en.inbox.thread.actions.delete })
      .click()

    await expect(threadOf(page).getByText('second version')).toHaveCount(0)
    await expect(threadOf(page).getByText(/ deleted this message$/)).toBeVisible()
  })

  test('draws each file of a message in the state of its scan', async () => {
    const conversationId = await newConversationIn(storeId)
    const withFile = async (
      filename: string,
      contentType: string,
      status: MediaStatus,
      type: MessageType,
      minutes: number
    ): Promise<void> => {
      const message = await addMessageTo(storeId, conversationId, {
        content: `caption of ${filename}`,
        type,
        createdAt: minutesAgo(minutes)
      })
      await addMediaTo(storeId, message.id, { filename, contentType, status })
    }
    await withFile('waiting.png', 'image/png', MediaStatus.PENDING, MessageType.IMAGE, 30)
    await withFile('virus.pdf', 'application/pdf', MediaStatus.INFECTED, MessageType.DOCUMENT, 20)
    await withFile('invoice.pdf', 'application/pdf', MediaStatus.CLEAN, MessageType.DOCUMENT, 10)

    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const thread = threadOf(page)
    await expect(
      thread.getByText(en.inbox.thread.media.checking.replace('{name}', 'waiting.png'))
    ).toBeVisible()
    await expect(
      thread.getByText(en.inbox.thread.media.infected.replace('{name}', 'virus.pdf'))
    ).toBeVisible()
    await expect(thread.getByText('caption of invoice.pdf')).toBeVisible()
    await expect(thread.getByRole('link', { name: new RegExp('invoice\\.pdf') })).toHaveAttribute(
      'href',
      /^http:\/\/localhost:8333\//
    )
  })

  test('draws a line for a file of the customer that could not be kept', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      content: 'the invoice',
      type: MessageType.DOCUMENT,
      createdAt: minutesAgo(1),
      unavailableFiles: [{ index: 0, code: 'refused' }]
    })

    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const thread = threadOf(page)
    await expect(thread.getByText('the invoice')).toBeVisible()
    await expect(thread.getByText(en.inbox.thread.media.notKept.refused)).toBeVisible()
  })

  test('refuses a file of a type that is not allowed before anything is uploaded', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, { content: 'Hello', createdAt: minutesAgo(1) })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(threadOf(page).getByText('Hello')).toBeVisible()

    await page.locator('input[type=file]').setInputFiles({
      name: 'setup.exe',
      mimeType: 'application/x-msdownload',
      buffer: Buffer.from('MZ')
    })

    await expect(
      page.getByRole('alert').filter({ hasText: en.errors.FILE_TYPE_NOT_ALLOWED })
    ).toBeVisible()
    await page
      .getByRole('button', { name: en.inbox.composer.attach.remove.replace('{name}', 'setup.exe') })
      .click()
    await expect(
      page.getByRole('alert').filter({ hasText: en.errors.FILE_TYPE_NOT_ALLOWED })
    ).toHaveCount(0)
  })

  test('answers a message: the action quotes it, the composer shows it and the reply carries it', async () => {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const quotedId = await firstMessageIdOf(conversationId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const message = messageWith(page, 'Hello, is my order on its way?')
    await expect(message).toBeVisible()

    await message.hover()
    await message.getByRole('button', { name: en.inbox.thread.actions.reply }).click()

    const chip = page.getByText(/^Replying to /)
    await expect(chip).toBeVisible()
    await expect(page.getByRole('textbox', { name: en.inbox.composer.replyLabel })).toBeFocused()
    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('On its way')
    await page.keyboard.press('Enter')

    await expect(chip).toHaveCount(0)
    await expect.poll(() => quotedByReplyIn(conversationId, 'On its way')).toBe(quotedId)
  })

  test('cancels the quote with its button and sends the next reply without it', async () => {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const message = messageWith(page, 'Hello, is my order on its way?')
    await message.hover()
    await message.getByRole('button', { name: en.inbox.thread.actions.reply }).click()
    await page.getByRole('button', { name: en.inbox.composer.cancelReply }).click()
    await expect(page.getByRole('button', { name: en.inbox.composer.cancelReply })).toHaveCount(0)

    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('Hi again')
    await page.keyboard.press('Enter')

    await expect.poll(() => quotedByReplyIn(conversationId, 'Hi again')).toBeNull()
  })

  test('says whether a quote of the customer points at the customer or at the team', async () => {
    const conversationId = await newConversationIn(storeId)
    const own = await addMessageTo(storeId, conversationId, {
      content: 'My first question',
      createdAt: minutesAgo(30)
    })
    const team = await addMessageTo(storeId, conversationId, {
      content: 'Our first answer',
      authorType: AuthorType.AGENT,
      deliveryStatus: DeliveryStatus.READ,
      createdAt: minutesAgo(20)
    })
    await addMessageTo(storeId, conversationId, {
      content: 'Following up on my own',
      replyToMessageId: own.id,
      createdAt: minutesAgo(10)
    })
    await addMessageTo(storeId, conversationId, {
      content: 'Following up on yours',
      replyToMessageId: team.id,
      createdAt: minutesAgo(5)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(messageWith(page, 'Following up on my own')).toContainText(/\(customer\)/)
    await expect(messageWith(page, 'Following up on yours')).toContainText(/\(team\)/)
  })

  test('draws a location as a card with its place and a button to the map, and no map', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      type: MessageType.LOCATION,
      content: 'Main Square - Street 1',
      metadata: {
        latitude: 19.4326,
        longitude: -99.1332,
        name: 'Main Square',
        address: 'Street 1'
      },
      createdAt: minutesAgo(1)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const card = messageWith(page, 'Main Square')
    await expect(card.getByText('Street 1')).toBeVisible()
    await expect(card.getByText('19.4326, -99.1332')).toBeVisible()
    const link = card.getByRole('link', { name: /Open on the map/ })
    await expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=19.4326%2C-99.1332'
    )
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    await expect(card.locator('iframe')).toHaveCount(0)
    await expect(threadOf(page).getByText(en.inbox.thread.neutral.LOCATION)).toHaveCount(0)
  })

  test('draws the contacts a customer shared as cards with their phones and emails, and copies a value', async () => {
    // Only this case may use the clipboard
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    test.info().annotations.push({ type: 'clipboard', description: 'granted to this case' })
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      type: MessageType.CONTACTS,
      content: 'Ana Pérez, Beto Ruiz',
      metadata: {
        contacts: [
          {
            name: 'Ana Pérez',
            phones: [{ number: '+52 55 1234 5678', kind: 'CELL' }, { number: '+52 55 8765 4321' }],
            emails: [{ address: 'ana@example.com', kind: 'WORK' }]
          },
          { name: 'Beto Ruiz', phones: [{ number: '+503 7000 0000' }], emails: [] }
        ]
      },
      createdAt: minutesAgo(1)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const cards = threadOf(page).getByRole('list', { name: en.inbox.thread.contacts.list })
    await expect(cards.getByText('Ana Pérez')).toBeVisible()
    await expect(cards.getByText('+52 55 1234 5678')).toBeVisible()
    // A kind WhatsApp names from its short list is drawn translated
    await expect(cards.getByText('Mobile')).toBeVisible()
    await expect(cards.getByText('ana@example.com')).toBeVisible()
    await expect(cards.getByText('Beto Ruiz')).toBeVisible()
    // The names are drawn once, in the cards, not again as the text of the bubble
    await expect(threadOf(page).getByText('Ana Pérez, Beto Ruiz')).toHaveCount(0)
    // Nothing is a link: the values are text of the customer
    await expect(cards.getByRole('link')).toHaveCount(0)
    await expect(threadOf(page).getByText(en.inbox.thread.neutral.unknown)).toHaveCount(0)

    try {
      await cards.getByRole('button', { name: 'Copy Work ana@example.com' }).click()
      await expect(
        page.locator('[data-sonner-toast]').getByText(en.inbox.thread.contacts.copied)
      ).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ana@example.com')
    } finally {
      await context.clearPermissions()
    }
  })

  test('keeps the line of a shared contact whose cards do not hold', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      type: MessageType.CONTACTS,
      content: 'Nobody',
      metadata: { contacts: 'not a list' },
      createdAt: minutesAgo(1)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(threadOf(page).getByText(en.inbox.thread.neutral.unknown)).toBeVisible()
    await expect(
      threadOf(page).getByRole('list', { name: en.inbox.thread.contacts.list })
    ).toHaveCount(0)
  })

  test('keeps the line of a location whose coordinates do not hold, with no link', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      type: MessageType.LOCATION,
      content: 'Nowhere',
      metadata: { latitude: 400, longitude: 2 },
      createdAt: minutesAgo(1)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(threadOf(page).getByText(en.inbox.thread.neutral.LOCATION)).toBeVisible()
    await expect(threadOf(page).getByRole('link', { name: /Open on the map/ })).toHaveCount(0)
  })

  test('calls a file with no name by its kind and plays an audio in a player of fixed width', async () => {
    const conversationId = await newConversationIn(storeId)
    const voice = await addMessageTo(storeId, conversationId, {
      type: MessageType.AUDIO,
      content: '',
      createdAt: minutesAgo(2)
    })
    await addMediaTo(storeId, voice.id, {
      filename: 'file',
      contentType: 'audio/ogg',
      status: MediaStatus.CLEAN
    })
    await serveAudio(page, 3)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const player = threadOf(page).getByRole('group', { name: en.inbox.thread.mediaLabel.AUDIO })
    await expect(player).toBeVisible()
    const box = await player.boundingBox()
    expect(box?.width).toBeLessThanOrEqual(260.5)
    await expect(player.getByRole('slider', { name: en.inbox.thread.audio.seek })).toHaveAttribute(
      'aria-valuemax',
      '3'
    )
    await expect(player.getByText('0:00/0:03')).toBeVisible()
    await expect(threadOf(page).getByText('file', { exact: true })).toHaveCount(0)

    await player
      .getByRole('button', { name: en.inbox.thread.audio.speed.replace('{speed}', '1') })
      .click()
    await expect(
      player.getByRole('button', { name: en.inbox.thread.audio.speed.replace('{speed}', '1.5') })
    ).toHaveText('1.5x')
    await player.getByRole('button', { name: en.inbox.thread.audio.play }).click()
    await expect(player.getByRole('button', { name: en.inbox.thread.audio.pause })).toBeVisible()
    await player.getByRole('button', { name: en.inbox.thread.audio.pause }).click()
    await expect(player.getByRole('button', { name: en.inbox.thread.audio.play })).toBeVisible()
  })

  test('draws a voice note that is an mp4 with the audio player, not as a video', async () => {
    const conversationId = await newConversationIn(storeId)
    const voice = await addMessageTo(storeId, conversationId, {
      type: MessageType.AUDIO,
      content: '',
      createdAt: minutesAgo(2)
    })
    // Instagram sends a voice note as an mp4: the file reads as a video, the message says audio
    await addMediaTo(storeId, voice.id, {
      filename: 'voice.mp4',
      contentType: 'video/mp4',
      status: MediaStatus.CLEAN
    })
    await serveAudio(page, 3)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const player = threadOf(page).getByRole('group', { name: 'voice.mp4' })
    await expect(player.getByRole('button', { name: en.inbox.thread.audio.play })).toBeVisible()
    // No button that opens a video in the modal
    await expect(
      threadOf(page).getByRole('button', {
        name: en.inbox.thread.media.play.replace('{name}', 'voice.mp4')
      })
    ).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('moves an audio with the keys of the bar', async () => {
    const conversationId = await newConversationIn(storeId)
    const voice = await addMessageTo(storeId, conversationId, {
      type: MessageType.AUDIO,
      content: '',
      createdAt: minutesAgo(2)
    })
    await addMediaTo(storeId, voice.id, {
      filename: 'note.ogg',
      contentType: 'audio/ogg',
      status: MediaStatus.CLEAN
    })
    await serveAudio(page, 30)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const bar = threadOf(page).getByRole('slider', { name: en.inbox.thread.audio.seek })
    await expect(threadOf(page).getByText('note.ogg', { exact: true })).toBeVisible()
    await expect(bar).toHaveAttribute('aria-valuemax', '30')
    await bar.focus()
    await page.keyboard.press('ArrowRight')
    await expect(bar).toHaveAttribute('aria-valuenow', '5')
    await page.keyboard.press('End')
    await expect(bar).toHaveAttribute('aria-valuenow', '30')
  })

  test('says that WhatsApp does not accept a type of file when a reply failed for it', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, { content: 'Hello', createdAt: minutesAgo(3) })
    await addMessageTo(storeId, conversationId, {
      content: 'Here is the file',
      authorType: AuthorType.AGENT,
      deliveryStatus: DeliveryStatus.FAILED,
      deliveryError: 'CHANNEL_FILE_TYPE_UNSUPPORTED',
      createdAt: minutesAgo(2)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await expect(threadOf(page).getByText(en.errors.CHANNEL_FILE_TYPE_UNSUPPORTED)).toBeVisible()
    await expect(threadOf(page).getByText(en.errors.CHANNEL_CAPABILITY_UNSUPPORTED)).toHaveCount(0)
  })

  test('shows the actions of a message on a touch screen without hover, with room to tap', async ({
    browser
  }) => {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    // The same session on a device whose pointer is coarse, wide enough to be past the narrow-screen rule
    const touch = await browser.newContext({
      ...devices['Pixel 7'],
      viewport: { width: 1100, height: 800 },
      storageState: await context.storageState()
    })
    await reachServicesFromOwnAddress(touch)
    const tapPage = await touch.newPage()
    try {
      await tapPage.goto(AppPaths.store.conversation(storeId, conversationId))
      const message = messageWith(tapPage, 'Hello, is my order on its way?')
      await expect(message).toBeVisible()

      const reply = message.getByRole('button', { name: en.inbox.thread.actions.reply })
      await expect(reply).toBeVisible()
      await expect(reply.locator('..')).toHaveCSS('opacity', '1')
      await expect
        .poll(async () => (await reply.boundingBox())?.width ?? 0)
        .toBeGreaterThanOrEqual(40)
    } finally {
      await touch.close()
    }
  })
})
