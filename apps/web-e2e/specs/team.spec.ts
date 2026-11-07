import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { inviteAsAgent, signInByApi } from '../support/api'
import { signIn } from '../support/login'
import { invitationTokenIn, nextEmailTo } from '../support/mailbox'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const team = en.settings.team
const invitations = team.invitations
const roles = team.roles
const members = team.members

function storeIdOf(page: Page): string {
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
  expect(storeId).toBeDefined()
  return storeId ?? ''
}

async function createRole(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: roles.create }).click()
  const dialog = page.getByRole('dialog', { name: roles.dialog.createTitle })
  await dialog.getByLabel(roles.dialog.name, { exact: true }).fill(name)
  await dialog.getByLabel(team.permissions.customers.view).click()
  await dialog.getByRole('button', { name: roles.dialog.save }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test.describe('Settings → Team', () => {
  test('an administrator makes a role, invites with it, is held by the cooldown and revokes', async ({
    page
  }) => {
    const suffix = randomUUID().slice(0, 8)
    const usedRole = `E2E used ${suffix}`
    const freeRole = `E2E free ${suffix}`
    const email = `e2e-${suffix}@example.com`

    await signIn(page, 'admin3@test.com')
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    await page.goto(AppPaths.store.settings(storeIdOf(page), StoreSettingsSections.TEAM))

    // Members: the administrator is there, and the system role is theirs
    await expect(page.getByRole('heading', { name: team.title })).toBeVisible()
    await expect(page.getByRole('list', { name: team.members.listLabel })).toBeVisible()

    // Roles: the system roles are read-only, a custom one is made, edited and deleted
    await page.getByRole('tab', { name: team.tabs.roles }).click()
    const adminRow = page.getByRole('listitem').filter({ hasText: roles.system }).first()
    await expect(adminRow.getByRole('button', { name: roles.view, exact: false })).toBeVisible()
    await expect(
      adminRow.getByRole('button', { name: roles.delete.action, exact: false })
    ).toHaveCount(0)
    await createRole(page, usedRole)
    await createRole(page, freeRole)

    // Invitations: invite with the role that will then be in use
    await page.getByRole('tab', { name: team.tabs.invitations }).click()
    await page.getByRole('button', { name: invitations.invite, exact: true }).click()
    const invite = page.getByRole('dialog', { name: invitations.dialog.title })
    await invite.getByLabel(invitations.dialog.email).fill(email)
    await invite.getByLabel(invitations.dialog.role).selectOption({ label: usedRole })
    await invite.getByRole('button', { name: invitations.dialog.send }).click()
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: email }) })
    await expect(row).toBeVisible()

    // A resend right after inviting is held by the cooldown, and says how long to wait
    await row.getByRole('button', { name: invitations.resend.action, exact: false }).click()
    await expect(page.getByText(/An invitation was sent a moment ago/)).toBeVisible()

    // The role an invitation holds cannot be deleted; the free one can
    await page.getByRole('tab', { name: team.tabs.roles }).click()
    const deleteOf = (name: string) =>
      page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name }) })
        .getByRole('button', { name: roles.delete.action, exact: false })
    await deleteOf(usedRole).click()
    await page.getByRole('alertdialog').getByRole('button', { name: roles.delete.confirm }).click()
    await expect(page.getByText(roles.delete.inUse.replace('{name}', usedRole))).toBeVisible()
    await deleteOf(freeRole).click()
    await page.getByRole('alertdialog').getByRole('button', { name: roles.delete.confirm }).click()
    await expect(page.getByRole('heading', { name: freeRole })).toHaveCount(0)

    // Revoking asks first, and the invitation leaves the list
    await page.getByRole('tab', { name: team.tabs.invitations }).click()
    await row.getByRole('button', { name: invitations.revoke.action, exact: false }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: invitations.revoke.confirm })
      .click()
    await expect(row).toHaveCount(0)
  })

  test('a viewer who may not see the team gets the permission message', async ({ page }) => {
    await signIn(page, 'viewer@test.com')
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.store.settings(storeIdOf(page), StoreSettingsSections.TEAM))
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title })
    ).toBeVisible()
  })

  test('a suspended member is kept out at once, is told so, and returns with their role when reactivated', async ({
    page,
    browser
  }) => {
    const suffix = randomUUID().slice(0, 8)
    const name = `Guest ${suffix}`
    const email = `suspend-${suffix}@example.com`

    // A new person joins the store through an invitation, and is working in it
    await inviteAsAgent(await signInByApi('admin3@test.com'), email)
    const guest = await browser.newContext()
    try {
      await reachServicesFromOwnAddress(guest)
      const guestPage = await guest.newPage()
      await guestPage.goto(AppPaths.invitation(invitationTokenIn(await nextEmailTo(email))))
      await guestPage.getByLabel(en.invitation.nameLabel).fill(name)
      await guestPage.getByRole('button', { name: en.invitation.accept }).click()
      await guestPage.waitForURL(/\/s\/[^/]+\/inbox$/)
      const inboxPath = new URL(guestPage.url()).pathname

      // The administrator suspends them after being asked to confirm
      await signIn(page, 'admin3@test.com')
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      await page.goto(AppPaths.store.settings(storeIdOf(page), StoreSettingsSections.TEAM))
      const row = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name, exact: true }) })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: members.suspend.action, exact: false }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: members.suspend.confirm })
        .click()
      await expect(row.getByText(members.status.suspended, { exact: true })).toBeVisible()
      await expect(row.getByRole('button', { name: members.suspend.action })).toHaveCount(0)
      await expect(row.getByRole('button', { name: members.reactivate.action })).toBeVisible()

      // Their open tab is cut and says why, without a generic refusal
      await expect(guestPage).toHaveURL(AppPaths.noAccess)
      await expect(
        guestPage.getByRole('heading', { name: en.noAccess.suspendedTitle })
      ).toBeVisible()

      // Opening the store by its link does the same, and does not loop
      await guestPage.goto(inboxPath)
      await expect(guestPage).toHaveURL(AppPaths.noAccess)
      await expect(
        guestPage.getByRole('heading', { name: en.noAccess.suspendedTitle })
      ).toBeVisible()

      // The filter finds them, and inviting their address says to reactivate instead
      await page.getByLabel(members.filter.label).selectOption({ label: members.filter.suspended })
      await expect(row).toBeVisible()
      await page.getByLabel(members.filter.label).selectOption({ label: members.filter.active })
      await expect(row).toHaveCount(0)
      await page.getByRole('tab', { name: team.tabs.invitations }).click()
      await page.getByRole('button', { name: invitations.invite, exact: true }).click()
      const invite = page.getByRole('dialog', { name: invitations.dialog.title })
      await invite.getByLabel(invitations.dialog.email).fill(email)
      // No role is chosen for the person: sending is refused until they pick one
      await expect(invite.getByRole('button', { name: invitations.dialog.send })).toBeDisabled()
      await invite.getByLabel(invitations.dialog.role).selectOption({ index: 1 })
      await invite.getByRole('button', { name: invitations.dialog.send }).click()
      await expect(invite.getByText(en.errors.TENANT_INVITEE_SUSPENDED)).toBeVisible()
      await invite.getByRole('button', { name: en.common.cancel }).click()

      // Reactivating asks too, and gives the access back
      await page.getByRole('tab', { name: team.tabs.members }).click()
      await page.getByLabel(members.filter.label).selectOption({ label: members.filter.all })
      await row.getByRole('button', { name: members.reactivate.action, exact: false }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: members.reactivate.confirm })
        .click()
      await expect(row.getByText(members.status.active, { exact: true })).toBeVisible()

      // The person checks again and is back in the store with the role they had
      await guestPage.getByRole('button', { name: en.noAccess.checkAgain }).click()
      await expect(guestPage).toHaveURL(/\/s\/[^/]+\/inbox$/)
    } finally {
      await guest.close()
    }
  })
})
