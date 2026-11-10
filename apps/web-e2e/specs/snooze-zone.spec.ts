import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  newConversationIn,
  setStoreTimezone,
  setUserTimezone,
  snoozedUntilOf,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const EMAIL = personOf('admin', import.meta.url)
const DAY_MS = 86_400_000

// The wall clock of an instant in a zone, as the digits of a datetime-local value
const clockIn = (instant: Date, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
      .formatToParts(instant)
      .map(part => [part.type, part.value])
  )
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`
}

// The instant at which a zone shows this wall clock (the zones used here have no change within the day)
const instantIn = (clock: string, timeZone: string): Date => {
  const guess = new Date(`${clock}:00Z`).getTime()
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = new Date(guess - offsetMinutes * 60_000)
    if (clockIn(candidate, timeZone) === clock) return candidate
  }
  throw new Error(`${clock} does not exist in ${timeZone}`)
}

// Its own session and address, as the api limits the requests of each one
test('the time picked to snooze is counted in the zone the system shows, not in the one of the browser', async ({
  browser
}) => {
  test.setTimeout(120_000)
  const storeId = await storeIdNamed(FIRST_STORE)
  const storeBefore = await setStoreTimezone(storeId, 'Asia/Tokyo')
  const userBefore = await setUserTimezone(EMAIL, null)
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles' })
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, EMAIL)

    // Two days ahead at 09:00 of the zone that is shown
    const day = clockIn(new Date(Date.now() + 2 * DAY_MS), 'UTC').slice(0, 10)
    for (const zone of ['Asia/Tokyo', 'Pacific/Auckland']) {
      // The account chose none: the zone of the store. Then it chooses one, which wins over the store.
      await setUserTimezone(EMAIL, zone === 'Asia/Tokyo' ? null : zone)
      const conversationId = await newConversationIn(storeId)
      await page.goto(AppPaths.store.conversation(storeId, conversationId))
      await page.getByRole('button', { name: en.inbox.actions.snooze, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: en.inbox.snooze.title })
      await dialog.getByLabel(en.inbox.snooze.custom).fill(`${day}T09:00`)
      await dialog.getByRole('button', { name: en.inbox.snooze.confirm }).click()
      await expect
        .poll(async () => (await snoozedUntilOf(conversationId))?.toISOString())
        .toBe(instantIn(`${day}T09:00`, zone).toISOString())
    }
  } finally {
    await context.close()
    await setUserTimezone(EMAIL, userBefore)
    await setStoreTimezone(storeId, storeBefore)
  }
})
