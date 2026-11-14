import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// What the api caches (the tag list, the snippet list, the store preferences) is dropped by the cache
// invalidation listener when the service that writes it publishes the event. A write from anywhere else
// (another service, the worker, raw SQL) would leave the old entry until its TTL, so this reads the
// source and fails when one appears: whoever adds a writer either goes through the service or adds the
// event and lists the file here.
const ROOT = join(__dirname, '..', '..')
const SCANNED = ['apps/api/src', 'apps/worker/src', 'libs']
const SKIPPED =
  /(node_modules|generated|\.next|coverage|dist|testing|builders|\.spec\.ts|\.integration\.spec\.ts)/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (SKIPPED.test(path)) return []
    if (entry.isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

const FILES = SCANNED.flatMap(dir => sourceFiles(join(ROOT, dir))).map(path => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8')
}))

const writers = (pattern: RegExp): string[] =>
  FILES.filter(file => pattern.test(file.text)).map(file => file.path)

const TAG_WRITE = /\.tag\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/
const SNIPPET_WRITE = /\.snippet\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/
const SETTINGS_WRITE = /\.storeSettings\.(create|createMany|update|updateMany|upsert)\(/
const RAW_WRITE = /(insert into|update|delete from)\s+"?(tags|snippets)"?\b/i

describe('The writers of what the api caches', () => {
  it('writes tags only in TagsService, and a dev fixture', () => {
    expect(writers(TAG_WRITE).sort()).toEqual([
      'apps/api/src/modules/settings/tags.service.ts',
      'libs/core/database/src/dev-fixtures.ts' // Development data, loaded by hand; the entry lives at most its TTL
    ])
  })

  it('writes snippets only in SnippetsService', () => {
    expect(writers(SNIPPET_WRITE)).toEqual(['apps/api/src/modules/settings/snippets.service.ts'])
  })

  it('writes the preferences column only in PreferencesService (the other writers of StoreSettings set other columns)', () => {
    const withPreferences = FILES.filter(
      file => SETTINGS_WRITE.test(file.text) && /\bpreferences\s*:/.test(file.text)
    ).map(file => file.path)
    // bootstrap-owner creates the row of a new store before anything could have read it
    expect(withPreferences.sort()).toEqual(['apps/api/src/modules/settings/preferences.service.ts'])
  })

  it('has no raw SQL that writes tags or snippets, nor the preferences column, outside the migrations', () => {
    expect(writers(RAW_WRITE)).toEqual([])
    // The order counter is written with raw SQL on store_settings, and it is not what is cached
    const rawSettings = FILES.filter(file =>
      /(update|insert into)\s+"?store_settings"?\b[^;`]*\bpreferences\b/i.test(file.text)
    ).map(file => file.path)
    expect(rawSettings).toEqual([])
  })

  it('has each writer publish the event the listener hears', () => {
    const text = (path: string): string => FILES.find(file => file.path === path)?.text ?? ''
    const tags = text('apps/api/src/modules/settings/tags.service.ts')
    for (const event of ['TAG_CREATED', 'TAG_UPDATED', 'TAG_DELETED']) {
      expect(tags).toContain(`Events.${event}`)
    }
    const snippets = text('apps/api/src/modules/settings/snippets.service.ts')
    for (const event of ['SNIPPET_CREATED', 'SNIPPET_UPDATED', 'SNIPPET_DELETED']) {
      expect(snippets).toContain(`Events.${event}`)
    }
    expect(text('apps/api/src/modules/settings/preferences.service.ts')).toContain(
      'Events.STORE_SETTINGS_UPDATED'
    )
  })
})
