import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { PageTitles } from './page-titles'

const APP_DIR = resolve(__dirname, '../app')

const messages = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(resolve(__dirname, `../messages/${locale}.json`), 'utf8')) as never

function textAt(tree: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      tree
    )
}

function filesNamed(directory: string, name: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesNamed(path, name)
    return entry.name === name ? [path] : []
  })
}

// Pages that draw nothing of their own: the first one sends the visitor on to where they belong, and the
// second is the redirect of /account to its first tab. Neither is ever on the screen long enough to be read.
const REDIRECT_ONLY = new Set(['page.tsx', 'account/page.tsx', 's/[storeId]/page.tsx'])

// The title each route must have. Written out, so that a page copied with the wrong name fails here
const TITLE_OF_PAGE: Record<string, string> = {
  'login/page.tsx': 'login',
  'login/verify/page.tsx': 'loginVerify',
  'invitations/[token]/page.tsx': 'invitation',
  'no-access/page.tsx': 'noAccess',
  'not-found.tsx': 'notFound',
  's/[storeId]/inbox/page.tsx': 'inbox',
  's/[storeId]/inbox/[conversationId]/page.tsx': 'inbox',
  's/[storeId]/customers/page.tsx': 'customers',
  's/[storeId]/products/page.tsx': 'products',
  's/[storeId]/exports/page.tsx': 'exports',
  's/[storeId]/settings/page.tsx': 'settings',
  's/[storeId]/settings/general/page.tsx': 'settingsGeneral',
  's/[storeId]/settings/channels/page.tsx': 'settingsChannels',
  's/[storeId]/settings/plugins/page.tsx': 'settingsPlugins',
  's/[storeId]/settings/team/page.tsx': 'settingsTeam',
  's/[storeId]/settings/routing/page.tsx': 'settingsRouting',
  's/[storeId]/settings/business-hours/page.tsx': 'settingsBusinessHours',
  's/[storeId]/settings/tags/page.tsx': 'settingsTags',
  's/[storeId]/settings/snippets/page.tsx': 'settingsSnippets',
  's/[storeId]/settings/inbox/page.tsx': 'settingsInbox',
  's/[storeId]/settings/inventory/page.tsx': 'settingsInventory',
  'account/profile/page.tsx': 'accountProfile',
  'account/preferences/page.tsx': 'accountPreferences',
  'account/notifications/page.tsx': 'accountNotifications',
  'account/security/page.tsx': 'accountSecurity',
  'org/page.tsx': 'org',
  'org/profile/page.tsx': 'orgProfile',
  'org/stores/page.tsx': 'orgStores',
  'org/warehouses/page.tsx': 'orgWarehouses'
}

// WCAG 2.4.2: every page has its own title, or all the tabs of a browser read the same (QA F2-T12)
describe('the title of each page', () => {
  const pages = filesNamed(APP_DIR, 'page.tsx')
    .concat(resolve(APP_DIR, 'not-found.tsx'))
    .map(path => ({ path, name: relative(APP_DIR, path) }))

  it('knows every page of the app, so that a new one has to be given a title', () => {
    const titled = pages.filter(page => !REDIRECT_ONLY.has(page.name)).map(page => page.name)
    expect(titled.sort()).toEqual(Object.keys(TITLE_OF_PAGE).sort())
  })

  it.each([...REDIRECT_ONLY])('%s really is a redirect', name => {
    expect(readFileSync(resolve(APP_DIR, name), 'utf8')).toMatch(/redirect|Redirect/)
  })

  it.each(Object.entries(TITLE_OF_PAGE))('%s is titled %s', (name, title) => {
    expect(readFileSync(resolve(APP_DIR, name), 'utf8')).toContain(
      `export const generateMetadata = pageTitle('${title}')`
    )
  })

  it('defines the titles it uses and no others', () => {
    expect([...new Set(Object.values(TITLE_OF_PAGE))].sort()).toEqual(
      Object.keys(PageTitles).sort()
    )
  })
})

describe.each(['es', 'en'])('the words of the titles in %s', locale => {
  const tree = messages(locale)

  it.each(Object.entries(PageTitles))('%s is made of texts that exist', (_name, paths) => {
    for (const path of paths) {
      const text = textAt(tree, path)
      expect(typeof text).toBe('string')
      expect(String(text).trim()).not.toBe('')
    }
  })
})
