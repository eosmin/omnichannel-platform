import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames, TenantHeaders } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChannelIds,
  ConversationStatus,
  DeliveryStatus,
  InvitationStatus,
  MessageType,
  RoutingActionTypes
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  createCustomer,
  createCustomerIdentity,
  createCustomerMerge,
  createChannelConnection,
  createInvitation,
  createMember,
  createBusinessHours,
  conversationOfMessage,
  conversationOfOrigin,
  createConversationOf,
  createConversationOriginOf,
  createMessageOf,
  createMessageReactionOf,
  createMessageRevisionOf,
  messageOfReaction,
  messageOfRevision,
  createRole,
  createRoutingRule,
  ensurePluginInstallation,
  createSnippet,
  createTag,
  resetStoreSettings,
  customerOfIdentity,
  survivorOfMerge
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api, apiWithoutStore } from '../helpers/http'
import {
  type IsolationCheck,
  isolationChecks,
  type IsolationResource,
  type IsolationScene
} from '../helpers/isolation'

// The release gate of the platform (TDD_13 section 6): no user, in no way, reaches the data of a
// store they do not belong to. It runs against the real app, as the api runs: the same AppModule,
// the same guards, and the database role platform_app.
//
// EVERY resource that belongs to a store is described here (a name, how to write one, where to read
// and change it). scripts/check-isolation-coverage.ts compares this list with the models of the
// schema that carry a store_id and fails the build for a model that is neither here nor exempt,
// with the reason and the step that will build it, in scripts/isolation-exemptions.ts.
const prefix = newRunPrefix()
// Set once the context exists: the role a member is moved to in the modification check
let viewerRoleId = ''
let agentRoleId = ''
// A user for the reactions the suite writes as the owner
let reactorId = ''
// A conversation of store A, where the creation check writes its messages
let conversationInA = ''
// A row the suite changes must have been made by createMessageOf: otherwise the check would be
// aimed at a conversation chosen at random and pass for the wrong reason
const conversationOf = (messageId: string): string => {
  const found = conversationOfMessage.get(messageId)
  if (found === undefined)
    throw new Error(`the message ${messageId} was not made by createMessageOf`)
  return found
}

const resources: IsolationResource[] = [
  {
    name: 'customer',
    create: createCustomer,
    readPath: ApiRoutes.customers.byId,
    listPath: ApiRoutes.customers.list,
    modify: { path: ApiRoutes.customers.byId, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.customer.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked',
    creation: {
      path: ApiRoutes.customers.list,
      body: name => ({ name }),
      strict: true,
      countIn: (owner, storeId) => owner.customer.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.customer.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  {
    name: 'customerIdentity',
    create: createCustomerIdentity,
    // An identity is reached through its customer: the route that removes it
    modify: {
      path: id => ApiRoutes.customers.identityById(customerOfIdentity.get(id) ?? '', id),
      method: 'delete',
      body: {}
    },
    untouched: async (owner, id) =>
      (await owner.customerIdentity.findUnique({ where: { id }, select: { id: true } })) !== null
  },
  {
    name: 'customerMerge',
    create: createCustomerMerge,
    // A merge is reached through the unmerge of its survivor
    modify: {
      path: id => ApiRoutes.customers.unmerge(survivorOfMerge.get(id) ?? ''),
      method: 'post',
      body: id => ({ mergeId: id })
    },
    untouched: async (owner, id) =>
      (await owner.customerMerge.findUnique({ where: { id }, select: { unmergedAt: true } }))
        ?.unmergedAt === null
  },
  {
    name: 'channelConnection',
    create: (owner, input) =>
      createChannelConnection(owner, { storeId: input.storeId, channelType: 'test_channel' }),
    readPath: ApiRoutes.channels.connectionById,
    listPath: ApiRoutes.channels.connections,
    modify: { path: ApiRoutes.channels.disconnect, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.channelConnection.findUnique({ where: { id }, select: { status: true } }))
        ?.status === 'active'
  },
  // Uninstalling is the one change a user can make; the installation is reached by its id
  {
    name: 'pluginInstallation',
    create: (owner, input) =>
      ensurePluginInstallation(owner, { storeId: input.storeId, pluginId: 'test_channel' }),
    modify: { path: ApiRoutes.plugins.revoke, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.pluginInstallation.findUnique({ where: { id }, select: { status: true } }))
        ?.status === 'active'
  },
  {
    name: 'tag',
    create: createTag,
    readPath: ApiRoutes.settings.tagById,
    listPath: ApiRoutes.settings.tags,
    modify: { path: ApiRoutes.settings.tagById, body: { name: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.tag.findUnique({ where: { id }, select: { name: true } }))?.name !== 'hacked',
    creation: {
      path: ApiRoutes.settings.tags,
      body: name => ({ name }),
      strict: true,
      countIn: (owner, storeId) => owner.tag.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.tag.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ?? null
    }
  },
  {
    name: 'snippet',
    create: createSnippet,
    readPath: ApiRoutes.settings.snippetById,
    listPath: ApiRoutes.settings.snippets,
    modify: { path: ApiRoutes.settings.snippetById, body: { title: 'hacked' } },
    untouched: async (owner, id) =>
      (await owner.snippet.findUnique({ where: { id }, select: { title: true } }))?.title !==
      'hacked',
    creation: {
      path: ApiRoutes.settings.snippets,
      body: name => ({ shortcut: name, title: name, content: name }),
      strict: true,
      countIn: (owner, storeId) => owner.snippet.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.snippet.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  // One row per store: the id is the store, and the route has none
  {
    name: 'businessHours',
    create: createBusinessHours,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.businessHours.update({
          where: { storeId },
          data: { timezone: marker === 'A' ? 'America/Costa_Rica' : 'Asia/Tokyo' }
        })
      },
      markerIn: body => {
        const timezone = (body as { timezone?: string }).timezone
        return timezone === 'America/Costa_Rica' ? 'A' : timezone === 'Asia/Tokyo' ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.businessHours,
    modify: {
      path: () => ApiRoutes.settings.businessHours,
      method: 'put',
      body: {
        timezone: 'UTC',
        schedule: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
        awayMessageSnippetId: null
      }
    },
    untouched: async (owner, id) =>
      (await owner.businessHours.findUnique({ where: { storeId: id }, select: { timezone: true } }))
        ?.timezone !== 'UTC'
  },
  {
    name: 'storeSettings',
    create: resetStoreSettings,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.storeSettings.update({
          where: { storeId },
          data: { agentLoadThreshold: marker === 'A' ? 11 : 22 }
        })
      },
      markerIn: body => {
        const threshold = (body as { agentLoadThreshold?: number }).agentLoadThreshold
        return threshold === 11 ? 'A' : threshold === 22 ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.inbox,
    modify: { path: () => ApiRoutes.settings.inbox, body: { reopenWindowDays: 99 } },
    untouched: async (owner, id) =>
      (
        await owner.storeSettings.findUnique({
          where: { storeId: id },
          select: { reopenWindowDays: true }
        })
      )?.reopenWindowDays !== 99
  },
  {
    name: 'conversation',
    create: createConversationOf,
    readPath: ApiRoutes.conversations.byId,
    listPath: ApiRoutes.conversations.list,
    modify: {
      path: ApiRoutes.conversations.status,
      body: { status: ConversationStatus.PENDING }
    },
    untouched: async (owner, id) =>
      (await owner.conversation.findUnique({ where: { id }, select: { status: true } }))?.status ===
      ConversationStatus.OPEN
  },
  {
    name: 'message',
    create: createMessageOf,
    // A message is reached through its conversation: the thread that holds it, and the reply to it
    // The check that asks for a message that exists nowhere gets a conversation that exists nowhere
    readPath: id => ApiRoutes.conversations.messages(conversationOfMessage.get(id) ?? randomUUID()),
    modify: {
      path: () => ApiRoutes.messages.create,
      method: 'post',
      body: id => ({
        type: MessageType.TEXT,
        conversationId: conversationOf(id),
        content: 'hacked',
        idempotencyKey: randomUUID()
      })
    },
    // Still the one message it was created with
    untouched: async (owner, id) => {
      const conversationId = conversationOfMessage.get(id)
      return (
        conversationId !== undefined &&
        (await owner.message.count({ where: { conversationId } })) === 1
      )
    },
    creation: {
      path: ApiRoutes.messages.create,
      body: name => ({
        type: MessageType.TEXT,
        conversationId: conversationInA,
        content: name,
        idempotencyKey: randomUUID()
      }),
      strict: true,
      countIn: (owner, storeId) => owner.message.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.message.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
        null
    }
  },
  {
    name: 'messageReaction',
    create: (owner, { storeId }) => createMessageReactionOf(owner, { storeId, userId: reactorId }),
    // Reactions are read inside the thread of their conversation; the one that is changed is reached
    // through its message
    readPath: id => ApiRoutes.conversations.messages(conversationOfMessage.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.messages.reaction(messageOfReaction.get(id) ?? randomUUID()),
      method: 'put',
      body: { emoji: '🔥' }
    },
    // Still the thumbs up it was created with, and not waiting to be sent
    untouched: async (owner, id) => {
      const row = await owner.messageReaction.findUnique({
        where: { id },
        select: { emoji: true, deliveryStatus: true }
      })
      return row?.emoji === '👍' && row.deliveryStatus === DeliveryStatus.SENT.valueOf()
    }
  },
  {
    name: 'conversationOrigin',
    create: createConversationOriginOf,
    // An origin is read through its conversation; the one thing a stranger could try to change is the
    // conversation it hangs from
    readPath: id => ApiRoutes.conversations.origins(conversationOfOrigin.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.conversations.status(conversationOfOrigin.get(id) ?? randomUUID()),
      body: { status: ConversationStatus.PENDING }
    },
    untouched: async (owner, id) => {
      const origin = await owner.conversationOrigin.findUnique({
        where: { id },
        select: { conversation: { select: { status: true } } }
      })
      return origin?.conversation.status === ConversationStatus.OPEN.valueOf()
    }
  },
  {
    name: 'messageRevision',
    create: (owner, { storeId }) => createMessageRevisionOf(owner, { storeId, userId: reactorId }),
    // The revisions of a note are read through the note; a stranger can also try to edit it, and must
    // neither change the note nor add a revision to it
    readPath: id => ApiRoutes.messages.revisions(messageOfRevision.get(id) ?? randomUUID()),
    modify: {
      path: id => ApiRoutes.messages.byId(messageOfRevision.get(id) ?? randomUUID()),
      method: 'patch',
      body: { content: 'hacked', version: 2 }
    },
    untouched: async (owner, id) => {
      const revision = await owner.messageRevision.findUnique({
        where: { id },
        select: { content: true, messageId: true }
      })
      if (revision === null) return false
      const [note, revisions] = await Promise.all([
        owner.message.findUnique({
          where: { id: revision.messageId },
          select: { content: true, version: true }
        }),
        owner.messageRevision.count({ where: { messageId: revision.messageId } })
      ])
      return (
        revision.content === 'note v1' &&
        note?.content === 'note v2' &&
        note.version === 2 &&
        revisions === 1
      )
    }
  },
  {
    name: 'routingRule',
    create: createRoutingRule,
    readPath: ApiRoutes.settings.routingRuleById,
    listPath: ApiRoutes.settings.routing,
    modify: { path: ApiRoutes.settings.routingRuleById, body: { name: 'hacked-rule' } },
    untouched: async (owner, id) =>
      (await owner.routingRule.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked-rule',
    creation: {
      path: ApiRoutes.settings.routing,
      body: name => ({ name, conditions: {}, action: { type: RoutingActionTypes.UNASSIGNED } }),
      strict: true,
      countIn: (owner, storeId) => owner.routingRule.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.routingRule.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  {
    name: 'membership',
    create: (owner, { storeId }) => createMember(owner, { storeId, prefix }),
    listPath: ApiRoutes.settings.members,
    modify: {
      path: ApiRoutes.settings.memberById,
      get body() {
        return { roleId: viewerRoleId }
      }
    },
    untouched: async (owner, id) =>
      (await owner.membership.findUnique({ where: { id }, select: { roleId: true } }))?.roleId !==
      viewerRoleId
  },
  {
    name: 'invitation',
    create: (owner, { storeId }) => createInvitation(owner, { storeId, prefix }),
    listPath: ApiRoutes.settings.invitations,
    // An invitation is revoked, not edited
    modify: { path: ApiRoutes.settings.invitationById, method: 'delete', body: {} },
    untouched: async (owner, id) =>
      (await owner.invitation.findUnique({ where: { id }, select: { status: true } }))?.status ===
      InvitationStatus.PENDING,
    creation: {
      path: ApiRoutes.settings.members,
      body: name => ({ email: `${prefix}-${name}@example.com`, roleId: agentRoleId }),
      strict: true,
      countIn: (owner, storeId) => owner.invitation.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.invitation.findUnique({ where: { id }, select: { storeId: true } }))
          ?.storeId ?? null
    }
  },
  {
    name: 'role',
    create: createRole,
    listPath: ApiRoutes.settings.roles,
    modify: { path: ApiRoutes.settings.roleById, body: { name: 'hacked-role' } },
    untouched: async (owner, id) =>
      (await owner.role.findUnique({ where: { id }, select: { name: true } }))?.name !==
      'hacked-role',
    creation: {
      path: ApiRoutes.settings.roles,
      body: name => ({ name, permissions: [] }),
      strict: true,
      countIn: (owner, storeId) => owner.role.count({ where: { storeId } }),
      storeOf: async (owner, id) =>
        (await owner.role.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ?? null
    }
  }
]

// Every check has a sentence: the type makes the build fail for one that does not
const CHECKS = Object.keys(isolationChecks) as IsolationCheck[]
const SENTENCES: Record<IsolationCheck, string> = {
  otherOrganization: 'cannot be read by a user of another organization',
  claimingOwnStore: 'cannot be read by claiming the own store while asking for a row of another',
  siblingStore: 'cannot be read from a sibling store of the same organization',
  modification: 'cannot be changed across stores, and the row does not change',
  ownRow: 'gets the row of its own store, whatever other stores hold',
  listing: 'lists only the rows of the store of the request',
  creation: 'is created in the store of the header, whatever store the body names'
}

describe('Tenant isolation', () => {
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let scene: IsolationScene

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    viewerRoleId = ctx.roleIds[RoleNames.VIEWER]
    agentRoleId = ctx.roleIds[RoleNames.AGENT]
    reactorId = ctx.adminA.id
    conversationInA = (await createConversationOf(owner, { storeId: ctx.storeA.id })).id
    scene = { app, owner, ctx }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  describe.each(resources)('$name', resource => {
    for (const check of CHECKS) {
      it(SENTENCES[check], async () => {
        await isolationChecks[check](scene, resource)
      })
    }
  })

  // TDD_13 section 6: the widget is public, so the key it carries is all that says which store it is
  // talking to. The case was waiting for the step that builds it (Step 2.8)
  describe('a widget site key', () => {
    const SITE_A = 'https://shop-a.example'
    const SITE_B = 'https://shop-b.example'
    const siteKey = (letter: string): string => `pk_widget_${letter.repeat(24)}`
    const widget = async (storeId: string, key: string, origin: string): Promise<void> => {
      const installation = await ensurePluginInstallation(owner, {
        storeId,
        pluginId: ChannelIds.WEB_WIDGET
      })
      await owner.channelConnection.create({
        data: {
          storeId,
          pluginId: ChannelIds.WEB_WIDGET,
          installationId: installation.id,
          connectionId: key,
          displayName: origin,
          credentials: Buffer.from('{}'),
          metadata: { allowedOrigins: [origin] }
        }
      })
    }
    const bootstrap = (key: string, visitorId: string, origin: string) =>
      anonymousApi(app)
        .post(ApiRoutes.widget.bootstrap)
        .set('origin', origin)
        .send({ siteKey: key, visitorId })

    beforeAll(async () => {
      await widget(ctx.storeA.id, siteKey('A'), SITE_A)
      await widget(ctx.storeB.id, siteKey('B'), SITE_B)
    })

    it('is not accepted from the site of another store', async () => {
      const response = await bootstrap(siteKey('A'), randomUUID(), SITE_B)

      expect(response.status).toBe(403)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED
      )
    })

    it('is neither read nor changed through the settings of another store', async () => {
      const connection = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: siteKey('A') },
        select: { id: true }
      })

      const read = await api(app, ctx.adminB, ctx.storeB).get(
        ApiRoutes.channels.widgetEmbed(connection.id)
      )
      const write = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.widgetOrigins(connection.id))
        .send({ siteOrigins: [SITE_B] })

      expect(read.status).toBe(404)
      expect(write.status).toBe(404)
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connection.id } })
      expect(row.metadata).toEqual({ allowedOrigins: [SITE_A] })
    })

    it('shows a visitor only the conversation they had with the store of the key', async () => {
      const visitorId = randomUUID()
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WEB_WIDGET,
        handle: visitorId
      })
      const connection = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: siteKey('A') },
        select: { id: true }
      })
      const conversation = await owner.conversation.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: identity.customerId,
          customerIdentityId: identity.id,
          channelConnectionId: connection.id,
          channelType: ChannelIds.WEB_WIDGET
        },
        select: { id: true }
      })
      await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: 'SecretOfStoreA',
          authorType: 'customer'
        }
      })

      const own = await bootstrap(siteKey('A'), visitorId, SITE_A)
      const other = await bootstrap(siteKey('B'), visitorId, SITE_B)

      expect(JSON.stringify(own.body)).toContain('SecretOfStoreA')
      expect(other.status).toBe(200)
      expect(JSON.stringify(other.body)).not.toContain('SecretOfStoreA')
    })
  })

  describe('the store of a request', () => {
    it('is required: a request with a token and no X-Store-Id is refused', async () => {
      const response = await apiWithoutStore(app, ctx.adminA).get(ApiRoutes.settings.tags)

      expect(response.status).toBe(400)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.TENANT_HEADER_MISSING
      )
    })

    it('is never taken from the query: a storeId there does not stand in for the header', async () => {
      const response = await apiWithoutStore(app, ctx.adminA)
        .get(ApiRoutes.settings.tags)
        .query({ storeId: ctx.storeA.id })

      expect(response.status).toBe(400)
    })

    it('is useless without a token', async () => {
      const response = await anonymousApi(app).get(ApiRoutes.settings.tags)

      expect(response.status).toBe(401)
    })

    it('is not the one of another user: a token and the header of a store the user lacks', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.settings.tags)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  // GET /auth/me belongs to a person and takes no store: what it lists is decided by whose token it is
  describe('the memberships of the account', () => {
    it('are the ones of the caller: a user never reads the stores of another organization', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.auth.me)
        .set('authorization', `Bearer ${ctx.adminA.token}`)

      const stores = (response.body as { memberships: { storeId: string }[] }).memberships.map(
        membership => membership.storeId
      )
      expect(response.status).toBe(200)
      expect(stores).toContain(ctx.storeA.id)
      expect(stores).not.toContain(ctx.storeB.id)
    })

    it('are the ones of the caller from the other side too', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.auth.me)
        .set('authorization', `Bearer ${ctx.adminB.token}`)

      const stores = (response.body as { memberships: { storeId: string }[] }).memberships.map(
        membership => membership.storeId
      )
      expect(stores).toContain(ctx.storeB.id)
      expect(stores).not.toContain(ctx.storeA.id)
    })
  })

  describe('the directory of members', () => {
    it('lists the members of the store of the caller, with nobody of another store in it', async () => {
      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.members.directory)

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).toContain(ctx.adminA.id)
      expect(JSON.stringify(response.body)).not.toContain(ctx.adminB.id)
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.members.directory)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  describe('the behavior of the inbox', () => {
    it('is the timezone and the settings of the store of the caller, never those of another', async () => {
      const before = await owner.store.findMany({
        where: { id: { in: [ctx.storeA.id, ctx.storeB.id] } },
        select: { id: true, timezone: true }
      })
      const zoneA = 'Asia/Tokyo'
      const zoneB = 'Europe/Madrid'
      await owner.store.update({ where: { id: ctx.storeA.id }, data: { timezone: zoneA } })
      await owner.store.update({ where: { id: ctx.storeB.id }, data: { timezone: zoneB } })
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { resolveShowOptions: false }
      })
      await owner.storeSettings.update({
        where: { storeId: ctx.storeB.id },
        data: { resolveShowOptions: true }
      })
      try {
        const a = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.settings.inboxBehavior)
        const b = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.settings.inboxBehavior)

        expect(a.body).toMatchObject({ timezone: zoneA, resolveShowOptions: false })
        expect(b.body).toMatchObject({ timezone: zoneB, resolveShowOptions: true })
      } finally {
        for (const store of before) {
          await owner.store.update({ where: { id: store.id }, data: { timezone: store.timezone } })
        }
        await owner.storeSettings.updateMany({
          where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] } },
          data: { resolveShowOptions: true }
        })
      }
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.settings.inboxBehavior)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  describe('the directory of channels', () => {
    it('lists the connections of the store of the caller, with none of another store in it', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: 'test_channel'
      })
      const connectionB = await createChannelConnection(owner, {
        storeId: ctx.storeB.id,
        channelType: 'test_channel'
      })

      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.channels.directory)

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).toContain(connectionA.id)
      expect(JSON.stringify(response.body)).not.toContain(connectionB.id)
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.channels.directory)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })

  // The profile of a customer reads from several tables at once; none of them may reach across stores
  describe('the activity of a customer', () => {
    it('is not read, nor previewed for a merge, through a customer of another store', async () => {
      const mine = await createCustomer(owner, { storeId: ctx.storeA.id })
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })
      await owner.customerNote.create({
        data: { customerId: theirs.id, authorId: ctx.adminB.id, content: 'secret note' }
      })
      const asA = () => api(app, ctx.adminA, ctx.storeA)

      const responses = await Promise.all([
        asA().get(ApiRoutes.customers.timeline(theirs.id)),
        asA().get(ApiRoutes.customers.conversations(theirs.id)),
        asA().get(ApiRoutes.customers.mergePreview(mine.id)).query({ absorbedId: theirs.id }),
        asA().get(ApiRoutes.customers.mergePreview(theirs.id)).query({ absorbedId: mine.id })
      ])

      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(JSON.stringify(response.body)).not.toContain('secret note')
      }
    })
  })

  // Who of the team is online comes from Redis, keyed by the store of the request
  describe('the presence of the team', () => {
    it('is answered for the store of the caller, with nobody of another store in it', async () => {
      const response = await api(app, ctx.adminA, ctx.storeA).get(ApiRoutes.presence.team)

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).not.toContain(ctx.adminB.id)
    })

    it('is refused for a store the user does not belong to', async () => {
      const response = await anonymousApi(app)
        .get(ApiRoutes.presence.team)
        .set('authorization', `Bearer ${ctx.adminB.token}`)
        .set(TenantHeaders.STORE_ID, ctx.storeA.id)

      expect(response.status).toBe(403)
    })
  })
})
