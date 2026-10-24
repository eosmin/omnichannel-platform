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

  it('keeps the infrastructure routes outside the versioned groups', () => {
    expect(InfraRoutes.healthReady).toBe('/health/ready')
    expect(InfraRoutes.queues).toBe('/admin/queues')
  })
})
