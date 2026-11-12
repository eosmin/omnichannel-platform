import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

// The title of each page, made of the words the navigation already uses (the most specific first), so the
// tab of the browser, the history and a screen reader say where the person is (WCAG 2.4.2). The root layout
// adds the name of the app after it (`Canales · Ajustes · Plataforma omnicanal`). Each entry is the list of
// message paths that are joined with ` · `.
export const PageTitles = {
  login: ['login.title'],
  // The name of the page, not "Iniciando tu sesión": the page stays on the screen when the link fails
  loginVerify: ['login.title'],
  invitation: ['invitation.title'],
  noAccess: ['noAccess.title'],
  notFound: ['notFound.title'],
  inbox: ['shell.nav.inbox'],
  customers: ['shell.nav.customers'],
  products: ['shell.nav.products'],
  orders: ['shell.nav.orders'],
  shipments: ['shell.nav.shipments'],
  pickups: ['shell.nav.pickups'],
  inventory: ['shell.nav.inventory'],
  remittances: ['shell.nav.remittances'],
  exports: ['shell.nav.exports'],
  settings: ['shell.nav.settings'],
  settingsGeneral: ['settings.nav.store.general', 'shell.nav.settings'],
  settingsChannels: ['settings.nav.store.channels', 'shell.nav.settings'],
  settingsPlugins: ['settings.nav.store.plugins', 'shell.nav.settings'],
  settingsTeam: ['settings.nav.store.team', 'shell.nav.settings'],
  settingsRouting: ['settings.nav.store.routing', 'shell.nav.settings'],
  settingsBusinessHours: ['settings.nav.store.businessHours', 'shell.nav.settings'],
  settingsTags: ['settings.nav.store.tags', 'shell.nav.settings'],
  settingsSnippets: ['settings.nav.store.snippets', 'shell.nav.settings'],
  settingsInbox: ['settings.nav.store.inbox', 'shell.nav.settings'],
  settingsInventory: ['settings.nav.store.inventory', 'shell.nav.settings'],
  settingsOrderTemplates: ['settings.nav.store.orderMessages', 'shell.nav.settings'],
  settingsReturns: ['settings.nav.store.returns', 'shell.nav.settings'],
  settingsPreferences: ['settings.nav.store.preferences', 'shell.nav.settings'],
  settingsCarriers: ['settings.nav.store.carriers', 'shell.nav.settings'],
  accountProfile: ['settings.nav.account.profile', 'settings.nav.account.title'],
  accountPreferences: ['settings.nav.account.preferences', 'settings.nav.account.title'],
  accountNotifications: ['settings.nav.account.notifications', 'settings.nav.account.title'],
  accountSecurity: ['settings.nav.account.security', 'settings.nav.account.title'],
  org: ['settings.nav.org.title'],
  orgProfile: ['settings.nav.org.profile', 'settings.nav.org.title'],
  orgStores: ['settings.nav.org.stores', 'settings.nav.org.title'],
  orgWarehouses: ['settings.nav.org.warehouses', 'settings.nav.org.title'],
  orgTransfers: ['settings.nav.org.transfers', 'settings.nav.org.title'],
  orgTransfer: ['transfers.detailTitle', 'settings.nav.org.title'],
  orgCounts: ['settings.nav.org.counts', 'settings.nav.org.title']
} as const satisfies Record<string, readonly string[]>

export type PageTitleName = keyof typeof PageTitles

const SEPARATOR = ' · '

// What a page exports as `generateMetadata`, in the language of the person
export function pageTitle(name: PageTitleName): () => Promise<Metadata> {
  return async () => {
    const t = await getTranslations()
    const words = PageTitles[name].map(path => t(path as Parameters<typeof t>[0]))
    return { title: words.join(SEPARATOR) }
  }
}
