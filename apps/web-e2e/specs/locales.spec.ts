import { AppPaths, LOCALE_COOKIE } from '@platform/api-client'
import { Locales } from '@platform/core/i18n'

import en from '../../web/messages/en.json' with { type: 'json' }
import es from '../../web/messages/es.json' with { type: 'json' }
import { WEB_URL } from '../support/env'
import { expect, test } from '../support/test'

const SIGN_IN_FORMS = [
  { locale: Locales.EN, messages: en },
  { locale: Locales.ES, messages: es }
]

test.describe('the interface follows the locale cookie', () => {
  for (const { locale, messages } of SIGN_IN_FORMS) {
    test(`the login renders in ${locale}`, async ({ page, context }) => {
      await context.addCookies([{ name: LOCALE_COOKIE, value: locale, url: WEB_URL }])

      await page.goto(AppPaths.login)

      await expect(page.getByRole('heading', { name: messages.login.title })).toBeVisible()
      await expect(page.getByRole('button', { name: messages.login.submit })).toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
    })
  }
})
