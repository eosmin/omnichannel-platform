import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }

import { emptyMailboxOf, magicLinkTokenIn, nextEmailTo } from './mailbox'

// Signs in the way a person does: asks for the link on the login page, takes it from the mailbox
// and opens it. Leaves the page on the start screen of the person and returns the token that was traded.
export async function signIn(page: Page, email: string): Promise<string> {
  await emptyMailboxOf(email)
  await page.goto(AppPaths.login)
  await page.getByLabel(en.login.emailLabel).fill(email)
  await page.getByRole('button', { name: en.login.submit }).click()
  const token = magicLinkTokenIn(await nextEmailTo(email))
  await page.goto(`${AppPaths.magicLink}#token=${token}`)
  await page.waitForURL(url => url.pathname !== AppPaths.magicLink)
  return token
}
