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
const REDIRECT_ONLY = new Set(['page.tsx', 'account/page.tsx'])

// WCAG 2.4.2: every page has its own title, or all the tabs of a browser read the same (QA F2-T12)
describe('the title of each page', () => {
  const pages = filesNamed(APP_DIR, 'page.tsx')
    .concat(resolve(APP_DIR, 'not-found.tsx'))
    .map(path => ({ path, name: relative(APP_DIR, path) }))

  it('has pages to check', () => {
    expect(pages.length).toBeGreaterThan(25)
  })

  it.each(pages.filter(page => !REDIRECT_ONLY.has(page.name)))(
    '$name names itself with pageTitle',
    ({ path }) => {
      expect(readFileSync(path, 'utf8')).toMatch(
        /export const generateMetadata = pageTitle\('\w+'\)/
      )
    }
  )

  it('uses every title it defines, and only the ones it defines', () => {
    const used = pages.flatMap(({ path }) =>
      [...readFileSync(path, 'utf8').matchAll(/pageTitle\('(\w+)'\)/g)].map(match => match[1])
    )
    expect([...new Set(used)].sort()).toEqual(Object.keys(PageTitles).sort())
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
