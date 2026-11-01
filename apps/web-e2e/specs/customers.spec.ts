import { randomInt, randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ChannelType } from '@platform/core/domain'
import { GalleryTypes } from '@platform/core/storage'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addCustomerFileTo,
  mediaZipsOf,
  mergedIntoOf,
  newCustomerIn,
  newTagIn,
  savedProfileOf,
  storeIdNamed,
  withWhatsAppChannel
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// Only an administrator holds the permission to merge customers. Not admin@test.com: the magic link is
// limited to 5 requests a minute for each address, and the other specs already spend that one
// (the realtime cases failed for lack of their e-mail). This user is an administrator of the first
// store too.
const ADMIN = 'multi-store@test.com'
const MERGE_WORD = en.customers.merge.confirmWord

// A name no other run has used: the database keeps what a case writes, and the case finds the
// customer by it
const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

// A Salvadoran mobile number no other run has used: a handle belongs to one customer of the store, and
// the database keeps what a case writes. `digits` is what is stored, `typed` what a person writes.
const THREE_DIGITS = 1_000
const FOUR_DIGITS = 10_000
function uniqueHandle(): { digits: string; typed: string } {
  const head = `7${String(randomInt(THREE_DIGITS)).padStart(3, '0')}`
  const tail = String(randomInt(FOUR_DIGITS)).padStart(4, '0')
  return { digits: `503${head}${tail}`, typed: `+503 ${head} ${tail}` }
}

// The label of the unlink button names the channel and the handle; the profile holds one identity here
const unlinkLabelStart = en.customers.identity.unlink.split('{')[0]?.trim() ?? ''

// Finds the customer on the customers page and opens the profile drawer
async function openProfile(page: Page, storeId: string, name: string): Promise<void> {
  await page.goto(AppPaths.store.customers(storeId))
  await page.getByLabel(en.customers.list.searchLabel).fill(name)
  await page.getByRole('button', { name }).click()
  await expect(page.getByRole('dialog', { name: en.customers.profile.title })).toBeVisible()
}

test.describe('customer merge and identities', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    await withWhatsAppChannel(storeId)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('merges two customers choosing the data to keep, and undoes it from the activity', async () => {
    const survivorName = uniqueName('Survivor')
    const absorbedName = uniqueName('Absorbed')
    const survivorId = await newCustomerIn(storeId, { name: survivorName, email: 'a@example.com' })
    const absorbedId = await newCustomerIn(storeId, { name: absorbedName, email: 'a@example.com' })

    await openProfile(page, storeId, survivorName)
    await page.getByRole('button', { name: en.customers.merge.moreActions }).click()
    await page.getByRole('menuitem', { name: en.customers.merge.open }).click()

    const dialog = page.getByRole('dialog', { name: en.customers.merge.title })
    await dialog.getByLabel(en.customers.merge.searchLabel).fill(absorbedName)
    await dialog.getByRole('button', { name: absorbedName }).click()

    // Only the name differs, so it is the only choice; the survivor is the default
    await expect(dialog.getByText(en.customers.merge.conflictsTitle)).toBeVisible()
    await expect(dialog.getByRole('radio', { name: survivorName })).toBeChecked()
    await dialog.getByRole('radio', { name: absorbedName }).check()
    await dialog.getByRole('button', { name: en.customers.merge.continue }).click()

    const confirm = dialog.getByRole('button', { name: en.customers.merge.confirm })
    await expect(confirm).toBeDisabled()
    await dialog
      .getByLabel(en.customers.merge.confirmLabel.replace('{word}', MERGE_WORD))
      .fill(MERGE_WORD)
    await confirm.click()

    await expect(dialog).toBeHidden()
    const profile = page.getByRole('dialog', { name: en.customers.profile.title })
    await expect(profile.getByText(absorbedName, { exact: true })).toBeVisible()
    await expect(profile.getByText(en.customers.timeline.merged)).toBeVisible()
    expect(await mergedIntoOf(absorbedId)).toBe(survivorId)

    await profile.getByRole('button', { name: en.customers.timeline.undoMerge }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: en.customers.timeline.undoConfirm })
      .click()

    await expect(profile.getByText(en.customers.timeline.unmerged)).toBeVisible()
    expect(await mergedIntoOf(absorbedId)).toBeNull()
  })

  test('offers to merge instead when the handle belongs to another customer', async () => {
    const ownerName = uniqueName('Owner')
    const otherName = uniqueName('Other')
    const handle = uniqueHandle()
    await newCustomerIn(storeId, { name: ownerName, handle: handle.digits })
    await newCustomerIn(storeId, { name: otherName })

    await openProfile(page, storeId, otherName)
    await page.getByRole('button', { name: en.customers.identity.add }).click()
    await page.getByLabel(en.customers.identity.handle).fill(handle.typed)
    await page.getByRole('button', { name: en.customers.identity.link, exact: true }).click()

    await expect(page.getByText(en.customers.identity.taken)).toBeVisible()
    await page.getByRole('button', { name: en.customers.identity.mergeInstead }).click()

    // The dialog skips the search: it opens on the preview of the owner of the handle
    const dialog = page.getByRole('dialog', { name: en.customers.merge.title })
    await expect(
      dialog.getByText(
        en.customers.merge.summary.replace('{absorbed}', ownerName).replace('{survivor}', otherName)
      )
    ).toBeVisible()
  })

  test('links a handle and unlinks it', async () => {
    const name = uniqueName('Linker')
    const handle = uniqueHandle()
    await newCustomerIn(storeId, { name })

    await openProfile(page, storeId, name)
    await page.getByRole('button', { name: en.customers.identity.add }).click()
    await page.getByLabel(en.customers.identity.handle).fill(handle.typed)
    await page.getByRole('button', { name: en.customers.identity.link, exact: true }).click()

    const profile = page.getByRole('dialog', { name: en.customers.profile.title })
    await expect(profile.getByText(handle.digits)).toBeVisible()
    await profile.getByRole('button', { name: unlinkLabelStart }).click()
    await expect(profile.getByText(en.customers.profile.noIdentities)).toBeVisible()
  })

  test('edits the name, tags, addresses and notes from the drawer', async () => {
    const name = uniqueName('Editor')
    const newName = uniqueName('Renamed')
    const tagName = uniqueName('Vip')
    const city = uniqueName('City')
    const note = uniqueName('Note')
    const customerId = await newCustomerIn(storeId, { name })
    await newTagIn(storeId, tagName)

    await openProfile(page, storeId, name)
    const profile = page.getByRole('dialog', { name: en.customers.profile.title })

    await profile.getByRole('button', { name: en.customers.edit.editProfile }).click()
    await profile.getByLabel(en.customers.edit.name, { exact: true }).fill(newName)
    await profile.getByRole('button', { name: en.customers.edit.save, exact: true }).click()
    await expect(profile.getByText(newName, { exact: true })).toBeVisible()

    await profile
      .getByRole('button', { name: en.customers.edit.tags.add.replace('{name}', tagName) })
      .click()
    await expect(
      profile.getByRole('button', {
        name: en.customers.edit.tags.remove.replace('{name}', tagName)
      })
    ).toBeVisible()

    await profile.getByRole('button', { name: en.customers.edit.address.add }).click()
    await profile.getByLabel(en.customers.edit.address.fields.line1).fill('1 Main Street')
    await profile.getByLabel(en.customers.edit.address.fields.city).fill(city)
    await profile.getByRole('button', { name: en.customers.edit.address.save }).click()
    await expect(profile.getByText(city, { exact: false })).toBeVisible()

    await profile.getByLabel(en.customers.edit.note.label).fill(note)
    await profile.getByRole('button', { name: en.customers.edit.note.add }).click()
    await expect(profile.getByText(note)).toBeVisible()

    expect(await savedProfileOf(customerId)).toEqual({
      name: newName,
      tagNames: [tagName],
      noteCount: 1,
      cities: [city]
    })
  })

  test('opens the files of a customer, filters them, walks the lightbox and queues the ZIP', async () => {
    const name = uniqueName('Gallery')
    const handle = uniqueHandle()
    const customerId = await newCustomerIn(storeId, {
      name,
      channelType: ChannelType.WHATSAPP,
      handle: handle.digits
    })
    const at = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)
    await addCustomerFileTo(storeId, customerId, {
      filename: 'shoe.png',
      contentType: 'image/png',
      createdAt: at(30)
    })
    await addCustomerFileTo(storeId, customerId, {
      filename: 'size.png',
      contentType: 'image/png',
      createdAt: at(20)
    })
    await addCustomerFileTo(storeId, customerId, {
      filename: 'receipt.pdf',
      contentType: 'application/pdf',
      createdAt: at(10)
    })

    await openProfile(page, storeId, name)
    const profile = page.getByRole('dialog', { name: en.customers.profile.title })
    await profile.getByRole('button', { name: en.customers.profile.media }).click()
    const gallery = page.getByRole('dialog', { name: en.customers.gallery.title })

    // The tabs carry their counts
    await expect(
      gallery.getByRole('tab', { name: `${en.customers.gallery.tabs.all} 3` })
    ).toBeVisible()
    await expect(
      gallery.getByRole('tab', { name: `${en.customers.gallery.tabs.image} 2` })
    ).toBeVisible()

    // A search narrows the grid by file name
    await gallery.getByLabel(en.customers.gallery.search).fill('receipt')
    await expect(gallery.getByText('receipt.pdf')).toBeVisible()
    await expect(gallery.getByText('shoe.png')).toBeHidden()
    await gallery.getByLabel(en.customers.gallery.search).fill('')

    // The arrows walk the images in the lightbox
    await gallery
      .getByRole('tab', { name: new RegExp(`^${en.customers.gallery.tabs.image}`) })
      .click()
    await gallery
      .getByRole('button', { name: en.customers.gallery.open.replace('{name}', 'size.png') })
      .click()
    const lightbox = page.getByRole('dialog', { name: 'size.png' })
    await expect(lightbox).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('dialog', { name: 'shoe.png' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'shoe.png' })).toBeHidden()

    // "Download all" queues a ZIP of the tab that is open
    await gallery.getByRole('button', { name: en.customers.gallery.downloadAll }).click()
    await expect(page.getByText(en.customers.gallery.zipQueued)).toBeVisible()
    const zips = await mediaZipsOf(storeId)
    expect(zips[0]?.filters).toMatchObject({ customerId, type: GalleryTypes.IMAGE })
  })
})
