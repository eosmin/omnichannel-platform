import { API_PREFIX } from './api-prefix'
import { ApiRoutes, InfraRoutes } from './api-routes'

type RouteValue = string | ((...args: string[]) => string) | { [key: string]: RouteValue }

function collect(group: Record<string, RouteValue>, path: string[] = []): Array<[string, string]> {
  const routes: Array<[string, string]> = []
  for (const [key, value] of Object.entries(group)) {
    const name = [...path, key].join('.')
    if (typeof value === 'string') routes.push([name, value])
    else if (typeof value === 'function')
      routes.push([name, value(...Array<string>(value.length).fill(':p'))])
    else routes.push(...collect(value, [...path, key]))
  }
  return routes
}

const routes = collect(ApiRoutes)

describe('ApiRoutes', () => {
  it.each(routes)('%s is a clean path relative to the version prefix', (_name, path) => {
    expect(path.startsWith('/')).toBe(true)
    expect(path).not.toContain('//')
    expect(path).not.toContain('/api/v1')
    expect(path.endsWith('/')).toBe(false)
  })

  it.each(routes)('%s never puts two parameters in a row', (_name, path) => {
    expect(path).not.toMatch(/\/:[A-Za-z0-9]+\/:[A-Za-z0-9]+/)
  })

  it('builds parameterised paths from placeholders', () => {
    expect(ApiRoutes.conversations.byId(':id')).toBe('/conversations/:id')
    expect(ApiRoutes.customers.identityById(':id', ':identityId')).toBe(
      '/customers/:id/identities/:identityId'
    )
    expect(ApiRoutes.webhooks.carrier(':connectionId')).toBe('/webhooks/carriers/:connectionId')
  })

  it('logs in by magic link, with no signup, password or OAuth route', () => {
    expect(Object.keys(ApiRoutes.auth)).toEqual(
      expect.arrayContaining(['magicLinkRequest', 'magicLinkConsume'])
    )
    const forbidden =
      /(signup|password|google|verify-email|stripe|billing|referral|impersonation|take-over)/
    expect(routes.filter(([, path]) => forbidden.test(path))).toEqual([])
    expect(Object.keys(ApiRoutes)).not.toEqual(
      expect.arrayContaining(['billing', 'referrals', 'ai', 'support'])
    )
  })

  it('puts the login of the channels under /channels and keeps its callback a fixed path', () => {
    // The provider is given this address in the dashboard, so it cannot take a parameter
    expect(ApiRoutes.channels.oauthCallback).toBe('/channels/oauth/callback')
    expect(ApiRoutes.channels.oauthStart(':pluginId')).toBe(
      '/channels/connections/oauth/:pluginId/start'
    )
    expect(ApiRoutes.channels.oauthAssets(':id')).toBe(
      '/channels/connections/oauth/sessions/:id/assets'
    )
    expect(ApiRoutes.channels.oauthComplete(':id')).toBe(
      '/channels/connections/oauth/sessions/:id/complete'
    )
    expect(ApiRoutes.channels.oauthSession(':id')).toBe('/channels/connections/oauth/sessions/:id')
  })

  it('gives the login routes paths that no other route of the api can capture', () => {
    // A path with a parameter in a segment that is a word here (`/channels/connections/:id/...`) would answer
    // for `oauth` as if it were an id: compare each login path with the pattern of every other route
    const login = routes.filter(([name]) => name.startsWith('channels.oauth'))
    const others = routes.filter(([name]) => !name.startsWith('channels.oauth'))
    expect(login).toHaveLength(5)
    for (const [, path] of login) {
      const concrete = path.replace(/:p/g, 'abc')
      for (const [otherName, other] of others) {
        const pattern = new RegExp(`^${other.replace(/:p/g, '[^/]+')}$`)
        expect({ otherName, captures: pattern.test(concrete) }).toEqual({
          otherName,
          captures: false
        })
      }
    }
  })

  it('keeps the infrastructure routes outside the versioned groups', () => {
    expect(InfraRoutes.healthReady).toBe('/health/ready')
    expect(InfraRoutes.queues).toBe('/admin/queues')
  })
})

describe('API_PREFIX', () => {
  it('is the version prefix, with a leading slash and no trailing one', () => {
    expect(API_PREFIX).toBe('/api/v1')
  })

  it('is not part of the infra routes, which are mounted outside of it', () => {
    for (const path of Object.values(InfraRoutes)) expect(path.startsWith(API_PREFIX)).toBe(false)
  })
})
