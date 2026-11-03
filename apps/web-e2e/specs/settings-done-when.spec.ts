import { randomUUID } from 'node:crypto'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { RoleNames } from '@platform/core/auth'
import { RoutingActionTypes } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOwnerOfNewStore } from '../support/database'
import { signIn } from '../support/login'
import { emptyMailboxOf, invitationTokenIn, nextEmailTo } from '../support/mailbox'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'
import { openSite, SITE_ORIGIN, startSite } from '../support/widget-site'

const channels = en.settings.channels
const plugins = en.settings.plugins
const team = en.settings.team
const routing = en.settings.routing

const WIDGET_NAME = 'Web widget'
const AGENT_NAME = 'Done When Agent'
const VISITOR_TEXT = {
  open: 'Open the chat',
  input: 'Write a message',
  send: 'Send'
} as const

// The "Done when" of Step 3.6, all through the screens: an owner connects a channel from Settings,
// invites an agent, makes a routing rule, and the agent finds the conversation in the inbox. The
// only setup is the account of the owner and the store it owns, because nothing in the product
// makes the first owner. The store, its organization and every person are new to this run, so
// nothing that the other specs share is touched; the store holds a conversation when the case
// ends, which the product refuses to delete, so a laptop keeps one store per run (a clean CI
// database has none).
test.describe('Settings: the whole path of Step 3.6', () => {
  test('an owner connects the widget, invites an agent, routes to them, and the agent sees the conversation', async ({
    browser,
    page
  }) => {
    // The whole path: three sessions, an email through the worker and a message through the worker
    test.setTimeout(120_000)
    const suffix = randomUUID().slice(0, 8)
    const ownerEmail = `done-when-owner-${suffix}@example.com`
    const agentEmail = `done-when-agent-${suffix}@example.com`
    const keyword = `donewhen${suffix}`
    const question = `Do you have the ${keyword} model?`

    const storeId = await addOwnerOfNewStore(ownerEmail, `E2E Done When ${suffix}`)
    let stopSite: (() => Promise<void>) | undefined
    const contexts: { close: () => Promise<void> }[] = []
    try {
      // 1. The owner signs in and installs the web widget from the catalog
      await signIn(page, ownerEmail)
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
      await page.getByRole('button', { name: `${plugins.install.action} ${WIDGET_NAME}` }).click()
      await expect(
        page.getByRole('button', { name: `${plugins.uninstall.action} ${WIDGET_NAME}` })
      ).toBeVisible()

      // 2. They connect it for the site of the shop and copy the snippet that the card shows
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS))
      await page.getByRole('button', { name: `${channels.add.connect} ${WIDGET_NAME}` }).click()
      const connect = page.getByRole('dialog', {
        name: channels.connectDialog.title.replace('{name}', WIDGET_NAME)
      })
      await connect.getByLabel(channels.connect.web_widget.siteOrigins).fill(SITE_ORIGIN)
      await connect.getByRole('button', { name: channels.connectDialog.submit }).click()
      // The widget is the only account of this store, and its card is the one with the settings button
      const card = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('button', { name: channels.widget.toggle }) })
      await expect(card.getByText(channels.status.active)).toBeVisible()
      await card.getByRole('button', { name: channels.widget.toggle }).click()
      const snippet = await card.locator('code').first().textContent()
      expect(snippet).toContain('pk_widget_')
      stopSite = await startSite(snippet ?? '')

      // 3. They invite an agent: the email carries the only copy of the link
      await emptyMailboxOf(agentEmail)
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.TEAM))
      await page.getByRole('tab', { name: team.tabs.invitations }).click()
      await page.getByRole('button', { name: team.invitations.invite, exact: true }).click()
      const invite = page.getByRole('dialog', { name: team.invitations.dialog.title })
      await invite.getByLabel(team.invitations.dialog.email).fill(agentEmail)
      await invite.getByLabel(team.invitations.dialog.role).selectOption({ label: RoleNames.AGENT })
      await invite.getByRole('button', { name: team.invitations.dialog.send }).click()
      await expect(page.getByRole('listitem').filter({ hasText: agentEmail })).toBeVisible()
      const link = AppPaths.invitation(invitationTokenIn(await nextEmailTo(agentEmail)))

      // The agent, in a browser of their own, names themselves and joins the store
      const agentContext = await browser.newContext()
      contexts.push(agentContext)
      await reachServicesFromOwnAddress(agentContext)
      const agent = await agentContext.newPage()
      await agent.goto(link)
      await agent.getByLabel(en.invitation.nameLabel).fill(AGENT_NAME)
      await agent.getByRole('button', { name: en.invitation.accept }).click()
      await agent.waitForURL(new RegExp(`/s/${storeId}/inbox$`))

      // 4. The owner makes a rule that sends the conversations that ask for the keyword to the agent
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.ROUTING))
      await page.getByRole('button', { name: routing.create }).click()
      const rule = page.getByRole('dialog', { name: routing.dialog.createTitle })
      await rule.getByLabel(routing.dialog.name, { exact: true }).fill(`E2E rule ${suffix}`)
      await rule.getByLabel(routing.dialog.keywords).fill(keyword)
      await rule.getByLabel(routing.dialog.action).selectOption(RoutingActionTypes.ASSIGN_USER)
      const person = rule.getByLabel(AGENT_NAME)
      await person.click()
      await expect(person).toBeChecked()
      await rule.getByRole('button', { name: routing.dialog.save }).click()
      await expect(
        page.getByRole('heading', { name: new RegExp(`E2E rule ${suffix}`) })
      ).toBeVisible()

      // 5. A visitor writes from the shop, which is a real page under the widget's own script
      const visitorContext = await browser.newContext()
      contexts.push(visitorContext)
      await reachServicesFromOwnAddress(visitorContext)
      const visitor = await visitorContext.newPage()
      await openSite(visitor)
      await visitor.getByRole('button', { name: VISITOR_TEXT.open }).click()
      await visitor.getByRole('textbox', { name: VISITOR_TEXT.input }).fill(question)
      await visitor.getByRole('button', { name: VISITOR_TEXT.send }).click()
      await expect(visitor.getByRole('log').getByText(question)).toBeVisible()

      // 6. The agent finds it among the conversations assigned to them, and opens it. The worker
      // stores the message and applies the rule, so the list can take a few seconds to show it.
      await agent.goto(AppPaths.store.inbox(storeId))
      await agent
        .getByRole('group', { name: en.inbox.scopeLabel })
        .getByRole('button', { name: new RegExp(`^${en.inbox.scope.mine}`) })
        .click()
      const conversation = agent
        .getByRole('list', { name: en.inbox.listLabel })
        .getByText(question)
        .first()
      await expect(conversation).toBeVisible({ timeout: 30_000 })
      await conversation.click()
      await expect(
        agent.getByRole('list', { name: en.inbox.thread.label }).getByText(question)
      ).toBeVisible()
    } finally {
      // The site holds a fixed port that other specs use: it is closed even if a context will not
      try {
        for (const context of contexts) await context.close()
      } finally {
        await stopSite?.()
      }
    }
  })
})
