import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import { PluginBridgeMessages, PluginBridgeOperations } from '@platform/core/domain'
import { PluginScopes } from '@platform/plugins/sdk'

import { createConversationOf, ensureWidgetPlugin } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404
const BAD_REQUEST = 400

interface SettingsBody {
  installationId: string
  widgetId: string
  visible: boolean
}

// Settings → Plugins, widgets: the owner shows or hides a plugin's sidebar panel for the whole store
describe('showing and hiding the widgets of the plugins', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-acme-hideable`.slice(0, 60)
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let installationId: string
  let conversationId: string

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    installationId = (
      await ensureWidgetPlugin(owner, {
        storeId: ctx.storeA.id,
        pluginId,
        widgetUrl: 'https://widgets.acme.example/panel',
        scopes: [PluginScopes.CONVERSATIONS_READ]
      })
    ).id
    conversationId = (await createConversationOf(owner, { storeId: ctx.storeA.id })).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: pluginId } })
    await app.close()
    await owner.$disconnect()
  })

  afterEach(async () => {
    await owner.pluginInstallation.update({ where: { id: installationId }, data: { config: {} } })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  // Read when a test runs: the installation exists only after `beforeAll`
  const route = () => ApiRoutes.pluginWidgets.visibility(installationId, 'info')
  const mine = (body: unknown) =>
    (body as (SettingsBody & { pluginId: string })[]).filter(widget => widget.pluginId === pluginId)

  // The audit log is written after the response: waits for a row newer than the ones already there
  async function newAuditEntry(action: string, before: number) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const count = await owner.auditLog.count({ where: { action, resourceId: installationId } })
      if (count > before) {
        return owner.auditLog.findFirstOrThrow({
          where: { action, resourceId: installationId },
          orderBy: { timestamp: 'desc' }
        })
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('no audit entry was written')
  }

  it('lists a widget as visible in Settings and in the sidebar until it is hidden', async () => {
    const settings = await asAdmin().get(ApiRoutes.pluginWidgets.settings)
    expect(settings.status).toBe(OK)
    expect(mine(settings.body)).toMatchObject([{ installationId, widgetId: 'info', visible: true }])
    const list = await asAgent().get(ApiRoutes.pluginWidgets.list)
    expect(mine(list.body)).toHaveLength(1)
  })

  it('hides it from the agents, keeps it in Settings as not visible, and shows it again', async () => {
    const hidden = await asAdmin().put(route()).send({ visible: false })
    expect(hidden.status).toBe(OK)
    expect(hidden.body).toMatchObject({ installationId, widgetId: 'info', visible: false })

    expect(mine((await asAgent().get(ApiRoutes.pluginWidgets.list)).body)).toHaveLength(0)
    expect(mine((await asAdmin().get(ApiRoutes.pluginWidgets.settings)).body)).toMatchObject([
      { visible: false }
    ])

    const shown = await asAdmin().put(route()).send({ visible: true })
    expect(shown.status).toBe(OK)
    expect(mine((await asAgent().get(ApiRoutes.pluginWidgets.list)).body)).toHaveLength(1)
  })

  it('gives no new session for a hidden widget and ends the ones already open', async () => {
    const open = await asAgent()
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId, conversationId })
    expect(open.status).toBe(CREATED)
    const token = (open.body as { token: string }).token
    const ask = () =>
      asAgent()
        .post(ApiRoutes.pluginWidgets.bridge)
        .send({
          token,
          request: {
            type: PluginBridgeMessages.REQUEST,
            id: 'h',
            operation: PluginBridgeOperations.CONVERSATION_GET
          }
        })
    expect((await ask()).status).toBe(OK)

    await asAdmin().put(route()).send({ visible: false })
    expect((await ask()).status).toBe(410)
    const again = await asAgent()
      .post(ApiRoutes.pluginWidgets.sessions)
      .send({ installationId, conversationId })
    expect(again.status).toBe(NOT_FOUND)
  })

  it('audits the change with the widget and the choice, and audits nothing when nothing changed', async () => {
    const action = AuditAction.PLUGIN_WIDGET_VISIBILITY_CHANGED
    const before = await owner.auditLog.count({ where: { action, resourceId: installationId } })
    await asAdmin().put(route()).send({ visible: false })
    const entry = await newAuditEntry(action, before)
    expect(entry.metadata).toEqual({ widgetId: 'info', visible: false })
    // Hiding it again is no change: no second entry
    await asAdmin().put(route()).send({ visible: false })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(await owner.auditLog.count({ where: { action, resourceId: installationId } })).toBe(
      before + 1
    )
  })

  it('keeps what else the installation config holds', async () => {
    await owner.pluginInstallation.update({
      where: { id: installationId },
      data: { config: { other: 'kept' } }
    })
    await asAdmin().put(route()).send({ visible: false })
    const row = await owner.pluginInstallation.findUniqueOrThrow({ where: { id: installationId } })
    expect(row.config).toEqual({ other: 'kept', hiddenWidgets: ['info'] })
  })

  it('keeps the other keys when the hidden list was damaged, and replaces only the list', async () => {
    await owner.pluginInstallation.update({
      where: { id: installationId },
      data: { config: { apiBase: 'x', hiddenWidgets: 'info' } }
    })
    await asAdmin().put(route()).send({ visible: false })
    const row = await owner.pluginInstallation.findUniqueOrThrow({ where: { id: installationId } })
    expect(row.config).toEqual({ apiBase: 'x', hiddenWidgets: ['info'] })
  })

  it('forgets a hidden id the manifest no longer declares', async () => {
    await owner.pluginInstallation.update({
      where: { id: installationId },
      data: { config: { hiddenWidgets: ['gone'] } }
    })
    await asAdmin().put(route()).send({ visible: false })
    const row = await owner.pluginInstallation.findUniqueOrThrow({ where: { id: installationId } })
    expect(row.config).toEqual({ hiddenWidgets: ['info'] })
  })

  it('hides one widget of a plugin and not the other: the session of the hidden one ends, the other keeps working', async () => {
    await owner.plugin.update({
      where: { id: pluginId },
      data: {
        manifest: {
          ui: { widget: 'https://widgets.acme.example/panel' },
          widgets: [
            { id: 'info', name: 'Info panel' },
            { id: 'other', name: 'Other panel' }
          ]
        }
      }
    })
    const open = async (widgetId: string): Promise<string> => {
      const response = await asAgent()
        .post(ApiRoutes.pluginWidgets.sessions)
        .send({ installationId, conversationId, widgetId })
      expect(response.status).toBe(CREATED)
      return (response.body as { token: string }).token
    }
    const ask = (token: string) =>
      asAgent()
        .post(ApiRoutes.pluginWidgets.bridge)
        .send({
          token,
          request: {
            type: PluginBridgeMessages.REQUEST,
            id: 'w',
            operation: PluginBridgeOperations.CONVERSATION_GET
          }
        })
    try {
      const info = await open('info')
      const other = await open('other')
      await asAdmin().put(route()).send({ visible: false })
      expect((await ask(info)).status).toBe(410)
      expect((await ask(other)).status).toBe(OK)
      const again = await asAgent()
        .post(ApiRoutes.pluginWidgets.sessions)
        .send({ installationId, conversationId, widgetId: 'info' })
      expect(again.status).toBe(NOT_FOUND)
    } finally {
      await ensureWidgetPlugin(owner, {
        storeId: ctx.storeA.id,
        pluginId,
        widgetUrl: 'https://widgets.acme.example/panel',
        scopes: [PluginScopes.CONVERSATIONS_READ]
      })
    }
  })

  it('treats a config that is not the expected shape as hiding nothing', async () => {
    await owner.pluginInstallation.update({
      where: { id: installationId },
      data: { config: { hiddenWidgets: 'info' } }
    })
    expect(mine((await asAgent().get(ApiRoutes.pluginWidgets.list)).body)).toHaveLength(1)
  })

  it('needs settings:manage_plugins to change it', async () => {
    const denied = await asAgent().put(route()).send({ visible: false })
    expect(denied.status).toBe(FORBIDDEN)
    const row = await owner.pluginInstallation.findUniqueOrThrow({ where: { id: installationId } })
    expect(row.config).toEqual({})
  })

  it('does not reach an installation of another store, as one that does not exist', async () => {
    const response = await api(app, ctx.adminB, ctx.storeB).put(route()).send({ visible: false })
    expect(response.status).toBe(NOT_FOUND)
    const settings = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.pluginWidgets.settings)
    expect(mine(settings.body)).toHaveLength(0)
  })

  it('refuses a widget the manifest does not declare, and a body that is not a choice', async () => {
    const unknown = await asAdmin()
      .put(ApiRoutes.pluginWidgets.visibility(installationId, 'nope'))
      .send({ visible: false })
    expect(unknown.status).toBe(NOT_FOUND)
    expect((await asAdmin().put(route()).send({ visible: 'no' })).status).toBe(BAD_REQUEST)
    expect((await asAdmin().put(route()).send({ visible: false, extra: 1 })).status).toBe(
      BAD_REQUEST
    )
    expect(
      (
        await asAdmin()
          .put(ApiRoutes.pluginWidgets.visibility(installationId, 'Not A Slug'))
          .send({ visible: false })
      ).status
    ).toBe(BAD_REQUEST)
  })
})
