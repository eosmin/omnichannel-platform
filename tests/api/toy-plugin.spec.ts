import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { PluginRegistry } from '@platform/plugins/runtime'

import { PluginCatalogSync } from '../../apps/api/src/modules/plugins/plugin-catalog-sync.service'
import { ensurePluginInstallation } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { withToyChannel } from '../helpers/env'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const TOY_ID = 'acme_chat'

interface CatalogEntry {
  id: string
  isOfficial: boolean
  channel: {
    connectFields: Record<string, unknown>[]
    descriptor: Record<string, unknown>
    oauth: unknown
    callbackUrl: string | null
  } | null
}
interface DirectoryEntry {
  pluginId: string
  pluginName: string
  limits: { textMaxLength: number } | null
  descriptor: { displayName: { es: string; en: string }; iconKey: string } | null
}

// The third-party plugin that no file of the platform names, registered the way the e2e registers it: with
// E2E_TOY_PLUGIN=1 in a test environment. The api, with no edit, offers it, connects it and tells the web how to
// draw it and what its text holds.
describe('a channel plugin the platform has never heard of', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await withToyChannel(() => createTestApp())
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    // After the stores: an installation keeps its plugin row, and the toy row is written at every boot
    await owner.plugin.deleteMany({ where: { id: TOY_ID } })
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  it('is registered as a plugin of a third party, not as an official one', () => {
    const registry = app.get(PluginRegistry, { strict: false })
    expect(registry.has(TOY_ID)).toBe(true)
    expect(registry.listOfficial().map(plugin => plugin.id)).not.toContain(TOY_ID)
  })

  it('shows in the catalog with the form it asks for, drawn from its own texts, and no login', async () => {
    const response = await asAdmin().get(ApiRoutes.plugins.available)
    expect(response.status).toBe(OK)
    const entry = (response.body as CatalogEntry[]).find(candidate => candidate.id === TOY_ID)
    expect(entry?.isOfficial).toBe(false)
    expect(entry?.channel?.connectFields).toEqual([
      {
        key: 'apiKey',
        labelKey: null,
        label: { es: 'Clave de Acme', en: 'Acme API key' },
        helpKey: null,
        secret: true,
        required: true,
        multiple: false
      }
    ])
    expect(entry?.channel?.descriptor).toMatchObject({
      displayName: { es: 'Acme Chat', en: 'Acme Chat' },
      iconKey: 'message-square'
    })
    expect(entry?.channel?.oauth).toBeNull()
    // What only the build of the web app needs never reaches a browser
    expect(JSON.stringify(response.body)).not.toContain('img.acme.test')
  })

  it('connects, and the directory tells the web what its text holds and how to name it', async () => {
    await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId: TOY_ID })

    const connected = await asAdmin()
      .post(ApiRoutes.channels.connect(TOY_ID))
      .send({ credentials: { apiKey: 'acme-key-1' } })
    expect(connected.status).toBe(CREATED)
    expect(JSON.stringify(connected.body)).not.toContain('acme-key-1')

    const directory = await asAdmin().get(ApiRoutes.channels.directory)
    const entry = (directory.body as DirectoryEntry[]).find(item => item.pluginId === TOY_ID)
    expect(entry?.limits).toEqual({ textMaxLength: 500, caption: null })
    expect(entry?.descriptor?.displayName.en).toBe('Acme Chat')
  })
})

describe('the catalog row of a plugin the code registers and nobody published', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient

  beforeAll(async () => {
    owner = ownerClient()
    // A row left by an earlier run belongs to whoever wrote it: the case starts from none
    await owner.plugin.deleteMany({ where: { id: TOY_ID, installations: { none: {} } } })
    app = await withToyChannel(() => createTestApp())
    await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    // After the stores: an installation keeps its plugin row, and the toy row is written at every boot
    await owner.plugin.deleteMany({ where: { id: TOY_ID } })
    await app.close()
    await owner.$disconnect()
  })

  it('is its own, with no approval it was not given, and is not taken over from another publisher', async () => {
    const row = await owner.plugin.findUniqueOrThrow({ where: { id: TOY_ID } })
    expect(row).toMatchObject({ isOfficial: false, authorName: 'Acme' })
    expect(row.authorEmail).not.toBe('plugins@omnichannel.invalid')

    await owner.plugin.update({
      where: { id: TOY_ID },
      data: { authorName: 'Someone else', name: 'Their name' }
    })
    try {
      await app.get(PluginCatalogSync, { strict: false }).sync()

      const after = await owner.plugin.findUniqueOrThrow({ where: { id: TOY_ID } })
      expect(after).toMatchObject({ authorName: 'Someone else', name: 'Their name' })
    } finally {
      await owner.plugin.update({
        where: { id: TOY_ID },
        data: { authorName: 'Acme', name: row.name }
      })
    }
  })
})
