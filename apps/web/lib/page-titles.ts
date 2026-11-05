import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'

// The title of each page, made of the words the navigation already uses (the most specific first), so the
// tab of the browser, the history and a screen reader say where the person is (WCAG 2.4.2). The root layout
// adds the name of the app after it (`Canales · Ajustes · Plataforma omnicanal`). Each entry is the list of
// message paths that are joined with ` · `.
export const PageTitles = {
  login: ['login.title'],
  loginVerify: ['loginVerify.verifying'],
  invitation: ['invitation.title'],
  noAccess: ['noAccess.title'],
  notFound: ['notFound.title'],
  inbox: ['shell.nav.inbox'],
  customers: ['shell.nav.customers'],
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
  accountProfile: ['settings.nav.account.profile', 'settings.nav.account.title'],
  accountPreferences: ['settings.nav.account.preferences', 'settings.nav.account.title'],
  accountNotifications: ['settings.nav.account.notifications', 'settings.nav.account.title'],
  accountSecurity: ['settings.nav.account.security', 'settings.nav.account.title'],
  org: ['settings.nav.org.title'],
  orgProfile: ['settings.nav.org.profile', 'settings.nav.org.title'],
  orgStores: ['settings.nav.org.stores', 'settings.nav.org.title']
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
