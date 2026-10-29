import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'
import { createOwnerClient, ensureUser } from '@platform/core/database-testing'

import en from '../../web/messages/en.json' with { type: 'json' }
import { inviteAsAgent, signInByApi } from '../support/api'
import { databaseUrls } from '../support/env'
import { signIn } from '../support/login'
import { invitationTokenIn, nextEmailTo } from '../support/mailbox'
import { expect, test } from '../support/test'

const ADMIN = 'admin@test.com'

const newAddress = (): string => `invited-${randomUUID().slice(0, 8)}@example.com`

// One link for the whole file: the api lets an address ask for five a minute
let adminToken = ''
test.beforeAll(async () => {
  adminToken = await signInByApi(ADMIN)
})

// The link that the invitation email carries, the only copy of the token there is
async function inviteAndTakeLink(invited: string): Promise<string> {
  await inviteAsAgent(adminToken, invited)
  return AppPaths.invitation(invitationTokenIn(await nextEmailTo(invited)))
}

test.describe('the page of an invitation', () => {
  test('a person with no account names themselves and gets one', async ({ page }) => {
    const invited = newAddress()
    const link = await inviteAndTakeLink(invited)

    await page.goto(link)
    await page.getByLabel(en.invitation.nameLabel).fill('Guest Person')
    await page.getByRole('button', { name: en.invitation.accept }).click()

    await expect(page).toHaveURL(/\/s\/[^/]+\/inbox$/)
  })

  test('a person with an account is asked to sign in, then accepts', async ({ page }) => {
    const invited = newAddress()
    const owner = createOwnerClient(databaseUrls.owner)
    try {
      await ensureUser(owner, invited, 'Existing Person')
    } finally {
      await owner.$disconnect()
    }
    const link = await inviteAndTakeLink(invited)

    await page.goto(link)
    await page.getByRole('button', { name: en.invitation.accept }).click()
    await expect(page.getByText(invited, { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: en.invitation.goToLogin })).toBeVisible()

    await signIn(page, invited)
    await page.goto(link)
    await page.getByRole('button', { name: en.invitation.accept }).click()

    await expect(page).toHaveURL(/\/s\/[^/]+\/inbox$/)
  })

  test('a session of another address is told so and nothing is accepted', async ({ page }) => {
    const invited = newAddress()
    const link = await inviteAndTakeLink(invited)

    await signIn(page, 'viewer@test.com')
    await page.goto(link)

    await expect(page.getByRole('heading', { name: en.invitation.mismatchTitle })).toBeVisible()
    await expect(page.getByRole('button', { name: en.invitation.accept })).toHaveCount(0)
  })

  test('a link that does not exist says so', async ({ page }) => {
    await page.goto(AppPaths.invitation('not-a-real-token'))

    await expect(page.getByRole('alert')).toBeVisible()
  })
})
