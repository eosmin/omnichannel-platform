import type { Redis } from 'ioredis'

import type { PrismaService } from '@platform/core/database'
import type { ConversationsService } from '@platform/core/messaging'

import type { CustomersService } from '../customers/customers.service'

import { PluginWidgetsService } from './plugin-widgets.service'

const manifest = (url: string) => ({
  ui: { widget: url },
  widgets: [{ id: 'info', name: 'Info' }]
})

function serviceWith(installations: unknown[], platformOrigins: string[]): PluginWidgetsService {
  const prisma = {
    client: { pluginInstallation: { findMany: jest.fn().mockResolvedValue(installations) } }
  } as unknown as PrismaService
  return new PluginWidgetsService(
    prisma,
    {} as Redis,
    {} as ConversationsService,
    {} as CustomersService,
    { origins: platformOrigins }
  )
}

const row = (id: string, url: string, manifestOverride?: unknown) => ({
  id,
  scopes: [],
  plugin: { id: `plugin-${id}`, name: `Plugin ${id}`, manifest: manifestOverride ?? manifest(url) }
})

describe('PluginWidgetsService.list', () => {
  const platform = ['https://app.platform.example', 'https://api.platform.example']

  it('lists the widgets of a plugin on its own origin', async () => {
    const service = serviceWith([row('a', 'https://widgets.acme.example/panel')], platform)
    await expect(service.list('store')).resolves.toMatchObject([
      { installationId: 'a', widgetId: 'info', origin: 'https://widgets.acme.example' }
    ])
  })

  it('drops a widget served from the web app or the api: with allow-same-origin it would not be another origin', async () => {
    const service = serviceWith(
      [
        row('web', 'https://app.platform.example/evil'),
        row('api', 'https://api.platform.example/evil'),
        row('ok', 'https://widgets.acme.example/panel')
      ],
      platform
    )
    const views = await service.list('store')
    expect(views.map(view => view.installationId)).toEqual(['ok'])
  })

  it('drops a widget on a sibling host of the platform (same parent domain), whose frame could reach what the app keeps', async () => {
    const service = serviceWith(
      [
        row('sibling', 'https://plugins.platform.example/panel'),
        row('ok', 'https://widgets.acme.example/panel')
      ],
      platform
    )
    const views = await service.list('store')
    expect(views.map(view => view.installationId)).toEqual(['ok'])
  })

  it('reads the host the way a browser does: a trailing dot or a port is the same host', async () => {
    const service = serviceWith(
      [
        row('dot', 'https://plugins.platform.example./panel'),
        row('port', 'https://plugins.platform.example:8443/panel')
      ],
      platform
    )
    await expect(service.list('store')).resolves.toEqual([])
  })

  it('skips a plugin whose manifest has no valid widget declaration', async () => {
    const service = serviceWith(
      [
        row('bad', 'x', { ui: { widget: 'http://acme.example' }, widgets: [] }),
        row('none', 'x', {})
      ],
      platform
    )
    await expect(service.list('store')).resolves.toEqual([])
  })
})
