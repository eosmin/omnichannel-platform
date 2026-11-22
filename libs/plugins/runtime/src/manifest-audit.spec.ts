import { findInvalidManifests } from './manifest-audit'

const valid = {
  id: 'acme-sync',
  version: '1.0.0',
  name: 'Acme Sync',
  description: 'Keeps the orders in the books',
  author: { name: 'Acme Inc', email: 'support@acme.example.com' },
  type: 'integration',
  pricing: { model: 'free' },
  scopes: ['orders:read']
}

describe('findInvalidManifests', () => {
  it('finds nothing in a manifest the parser of today accepts, nor in an empty registry', () => {
    expect(findInvalidManifests([{ id: 'acme-sync', manifest: valid }])).toEqual([])
    expect(findInvalidManifests([])).toEqual([])
  })

  it('names the plugin and the path of a third language in names', () => {
    const problems = findInvalidManifests([
      { id: 'ok', manifest: valid },
      { id: 'acme-sync', manifest: { ...valid, names: { es: 'Acme', en: 'Acme', fr: 'Acme' } } }
    ])

    expect(problems).toHaveLength(1)
    expect(problems[0]?.pluginId).toBe('acme-sync')
    expect(problems[0]?.issues.join('\n')).toContain('names')
  })

  it('finds a widget whose size is out of range', () => {
    const problems = findInvalidManifests([
      {
        id: 'w',
        manifest: {
          ...valid,
          ui: { widget: 'https://acme.example.com/w' },
          widgets: [{ id: 'a', name: 'A', defaultWidth: 999999, defaultHeight: 200 }]
        }
      }
    ])

    expect(problems).toHaveLength(1)
    expect(problems[0]?.pluginId).toBe('w')
  })

  it('finds a manifest that is not an object at all', () => {
    expect(findInvalidManifests([{ id: 'x', manifest: null }])).toEqual([
      { pluginId: 'x', issues: [expect.stringContaining('(manifest)')] }
    ])
  })
})
