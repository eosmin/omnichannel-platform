import { Permissions } from '@platform/core/auth'
import { PluginScopes } from '@platform/plugins/sdk'

import { pluginExportAudience } from './plugin-export-audience'

const INSTALLATION = '0b8e7a52-6d1f-4a63-8c4e-2f9d3b7a1e55'

describe('pluginExportAudience', () => {
  it('owns the exports as plugin:<installation id>, never as a person', () => {
    expect(pluginExportAudience({ id: INSTALLATION, scopes: [] }).userId).toBe(
      `plugin:${INSTALLATION}`
    )
  })

  it('holds the permissions of every scope of the key, so the kinds it sees are the ones it may still make', () => {
    const { held } = pluginExportAudience({
      id: INSTALLATION,
      scopes: [PluginScopes.EXPORTS_READ, PluginScopes.ANALYTICS_READ, PluginScopes.EXPORTS_WRITE]
    })
    expect(held).toEqual(
      expect.arrayContaining([Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT])
    )
  })

  it('holds nothing of a kind whose scope the key lost, and ignores a scope the platform does not declare', () => {
    const { held } = pluginExportAudience({
      id: INSTALLATION,
      scopes: [PluginScopes.EXPORTS_READ, 'exports:everything']
    })
    expect(held).toEqual([])
  })
})
