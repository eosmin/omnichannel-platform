import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PluginScopes } from '@platform/plugins/sdk'

// The consent screen of Settings → Plugins names each scope in the words of the store (`settings.plugins.scopes.<scope>`), in both
// languages. The web app cannot import the SDK, so this is what stops a new scope from reaching an owner as a bare id: it fails until
// the scope has its sentence. A sentence with no scope is a leftover and fails too.
const MESSAGES = join(__dirname, '..', '..', 'apps', 'web', 'messages')

function labelsOf(locale: string): Record<string, string> {
  const messages = JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8')) as {
    settings: { plugins: { scopes: Record<string, string> } }
  }
  return messages.settings.plugins.scopes
}

describe.each(['en', 'es'])('the scope labels of the plugins screen (%s)', locale => {
  const labels = labelsOf(locale)

  it('has a sentence for every scope', () => {
    const missing = Object.values(PluginScopes).filter(scope => !labels[scope])
    expect(missing).toEqual([])
  })

  it('has no sentence for a scope that does not exist', () => {
    const known = new Set<string>(Object.values(PluginScopes))
    expect(Object.keys(labels).filter(scope => !known.has(scope))).toEqual([])
  })
})
