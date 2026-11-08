import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ChannelOAuthConfig } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import { RoleNames, TenantHeaders } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChannelIds,
  ConversationStatus,
  DeliveryStatus,
  InvitationStatus,
  MembershipStatus,
  MessageType,
  RoutingActionTypes
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  NotificationSeverity,
  notificationMessageKey,
  NotificationTypes
} from '@platform/core/notifications'
import { ExportFormats, ExportTypes } from '@platform/core/queues'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { ChannelOAuthStore } from '../../apps/api/src/modules/channels/oauth/channel-oauth.store'
import {
  buildChannelPlugin,
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
  createDiscardableReplyOf,
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

const PREFERENCE_TYPE = NotificationTypes.CONVERSATION_ASSIGNED
const adminOf = async (owner: OwnerClient, storeId: string): Promise<string> =>
  (
    await owner.membership.findFirstOrThrow({
      where: { storeId, role: { name: RoleNames.ADMIN } },
      select: { userId: true }
    })
  ).userId
const setPreferencePush = async (
  owner: OwnerClient,
  storeId: string,
  push: boolean
): Promise<void> => {
  const userId = await adminOf(owner, storeId)
  await owner.notificationPreference.upsert({
    where: { userId_storeId_type: { userId, storeId, type: PREFERENCE_TYPE } },
    create: {
      userId,
      storeId,
      type: PREFERENCE_TYPE,
      inApp: true,
      push,
      email: false,
      sound: true
    },
    update: { push }
  })
}

const LOGIN_REDIRECT_URI = 'https://api.example.com/api/v1/channels/oauth/callback'

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
    // The same row as above, read and changed through its preferences (one key of the Json column)
    name: 'storePreferences',
    create: resetStoreSettings,
    own: {
      set: async (owner, storeId, marker) => {
        await owner.storeSettings.update({
          where: { storeId },
          data: { preferences: { sendReadReceipts: marker === 'A' } }
        })
      },
      markerIn: body => {
        const receipts = (body as { sendReadReceipts?: boolean }).sendReadReceipts
        return receipts === true ? 'A' : receipts === false ? 'B' : null
      }
    },
    readPath: () => ApiRoutes.settings.preferences,
    modify: {
      path: () => ApiRoutes.settings.preferences,
      method: 'put',
      body: { sendReadReceipts: false }
    },
    // The factory state is an empty column: a change would have written the key
    untouched: async (owner, id) =>
      JSON.stringify(
        (
          await owner.storeSettings.findUnique({
            where: { storeId: id },
            select: { preferences: true }
          })
        )?.preferences
      ) === '{}'
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
    // The same model, for the route that throws away a reply that failed: a stranger gets the answer of a
    // reply that does not exist, and the reply is as it was
    name: 'message',
    create: (owner, { storeId }) => createDiscardableReplyOf(owner, { storeId, userId: reactorId }),
    readPath: id => ApiRoutes.conversations.messages(conversationOfMessage.get(id) ?? randomUUID()),
    modify: { path: id => ApiRoutes.messages.discard(id), method: 'post', body: {} },
    untouched: async (owner, id) => {
      const reply = await owner.message.findUnique({
        where: { id },
        select: { discardedAt: true, deletedAt: true, failureDefinitive: true }
      })
      return (
        reply?.discardedAt === null && reply.deletedAt === null && reply.failureDefinitive === true
      )
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
    // Suspending is another way to act on a membership by its id: a stranger's gets a 404 and the
    // member of the other store keeps their access
    name: 'membershipSuspend',
    create: (owner, { storeId }) => createMember(owner, { storeId, prefix }),
    modify: { path: ApiRoutes.settings.memberSuspend, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.membership.findUnique({ where: { id }, select: { status: true } }))?.status ===
      MembershipStatus.ACTIVE
  },
  {
    // And so is reactivating: it must not give the access back to a member of another store
    name: 'membershipReactivate',
    create: async (owner, { storeId }) => {
      const made = await createMember(owner, { storeId, prefix })
      await owner.membership.update({
        where: { id: made.id },
        data: { status: MembershipStatus.SUSPENDED }
      })
      return made
    },
    modify: { path: ApiRoutes.settings.memberReactivate, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.membership.findUnique({ where: { id }, select: { status: true } }))?.status ===
      MembershipStatus.SUSPENDED
  },
  {
    // Resending is a second way to act on an invitation by its id: a stranger's gets a 404 and no mail
    name: 'invitationResend',
    create: (owner, { storeId }) => createInvitation(owner, { storeId, prefix }),
    modify: { path: ApiRoutes.settings.invitationResend, method: 'post', body: {} },
    untouched: async (owner, id) =>
      (await owner.invitation.findUnique({ where: { id }, select: { status: true } }))?.status ===
      InvitationStatus.PENDING
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
  },
  // The signed download of a clean file. No route changes it (a file is replaced by uploading
  // another), so it has no `modify`. The upload routes have their own cases (describe "media upload").
  {
    name: 'media',
    create: (owner, { storeId }) =>
      owner.media.create({
        data: {
          storeId,
          purpose: 'message',
          key: StorageKeys.message(storeId, randomUUID(), 'photo.png'),
          filename: 'photo.png',
          contentType: 'image/png',
          fileSize: 68,
          status: 'clean'
        },
        select: { id: true }
      }),
    readPath: ApiRoutes.media.byId,
    untouched: async (owner, id) =>
      (await owner.media.findUnique({ where: { id }, select: { id: true } })) !== null
  },
  // The exports center shows a member only the exports they asked for, so the row is made by the
  // Admin of its store (the one the suite acts as). No route changes an export, so it has no `modify`.
  {
    name: 'export',
    create: async (owner, { storeId }) => {
      const admin = await owner.membership.findFirstOrThrow({
        where: { storeId, role: { name: RoleNames.ADMIN } },
        select: { userId: true }
      })
      return owner.export.create({
        data: {
          storeId,
          requestedBy: admin.userId,
          type: ExportTypes.CUSTOMERS,
          format: ExportFormats.CSV,
          expiresAt: new Date(Date.now() + 86_400_000)
        },
        select: { id: true }
      })
    },
    readPath: ApiRoutes.exports.byId,
    listPath: ApiRoutes.exports.list,
    untouched: async (owner, id) =>
      (await owner.export.findUnique({ where: { id }, select: { id: true } })) !== null
  },
  // Notifications are a person's own: the row is made for the Admin of its store (the one the suite
  // acts as) and the only way to change one is to mark it read, naming it in the body. There is no
  // route that reads one by id, so a stranger is only ever answered by the 404 of that route.
  {
    name: 'notification',
    create: async (owner, { storeId }) => {
      const admin = await owner.membership.findFirstOrThrow({
        where: { storeId, role: { name: RoleNames.ADMIN } },
        select: { userId: true }
      })
      return owner.notification.create({
        data: {
          userId: admin.userId,
          storeId,
          type: NotificationTypes.EXPORT_READY,
          severity: NotificationSeverity.SUCCESS,
          messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY)
        },
        select: { id: true }
      })
    },
    listPath: ApiRoutes.notifications.list,
    modify: {
      path: () => ApiRoutes.notifications.markRead,
      method: 'post',
      body: id => ({ ids: [id] })
    },
    untouched: async (owner, id) =>
      (await owner.notification.findUnique({ where: { id }, select: { readAt: true } }))?.readAt ===
      null
  },
  // The choices of a member for one type, in one store: one row per store for the Admin the suite acts
  // as, reached through the store of the request (GET and PUT preferences). The marker is the `push`
  // flag: true for store A ('A'), false for store B ('B').
  {
    name: 'notificationPreference',
    create: async (owner, { storeId }) => {
      await setPreferencePush(owner, storeId, true)
      return { id: storeId }
    },
    readPath: () => ApiRoutes.notifications.preferences,
    own: {
      set: (owner, storeId, marker) => setPreferencePush(owner, storeId, marker === 'A'),
      markerIn: body => {
        const row = (body as { types: { type: string; push: boolean }[] }).types.find(
          candidate => candidate.type === PREFERENCE_TYPE
        )
        return row === undefined ? null : row.push ? 'A' : 'B'
      }
    },
    modify: {
      path: () => ApiRoutes.notifications.preferences,
      method: 'put',
      body: {
        types: [{ type: PREFERENCE_TYPE, inApp: true, push: false, email: false, sound: true }]
      }
    },
    untouched: async (owner, storeId) => {
      const admin = await adminOf(owner, storeId)
      return (
        (
          await owner.notificationPreference.findUnique({
            where: {
              userId_storeId_type: { userId: admin, storeId, type: PREFERENCE_TYPE }
            },
            select: { push: true }
          })
        )?.push === true
      )
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
    // The login of the channels is on for the suite, so that its sessions can be tried against another store
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(ChannelOAuthConfig)
        .useValue({ redirectUri: LOGIN_REDIRECT_URI, frontendUrl: 'https://app.example.com' })
    )
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

  // The read of a media is in the list of resources above. The upload routes are proven here: the
  // store of a signed URL and of a confirmation is the one of the header, and a key of another store
  // is never accepted.
  describe('media upload', () => {
    const uploadBody = {
      purpose: 'message',
      filename: 'photo.png',
      contentType: 'image/png',
      fileSizeBytes: 68
    }

    it('signs a key inside the store of the header, never one the body names', async () => {
      const own = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send(uploadBody)
      expect(own.status).toBe(200)
      expect((own.body as { key: string }).key).toMatch(
        new RegExp(`^${StorageKeys.storePrefix(ctx.storeA.id)}uploads/`)
      )
      const named = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.uploadUrl)
        .send({ ...uploadBody, storeId: ctx.storeB.id })
      expect(named.status).toBe(400)
      expect((named.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.VALIDATION_FAILED
      )
    })

    it('is refused in a store the user does not belong to, on both routes', async () => {
      for (const path of [ApiRoutes.media.uploadUrl, ApiRoutes.media.confirmUpload]) {
        const response = await api(app, ctx.adminA, ctx.storeB).post(path).send(uploadBody)
        expect(response.status).toBe(403)
        expect((response.body as { error: { code: string } }).error.code).toBe(
          ErrorCodes.TENANT_ACCESS_DENIED
        )
      }
    })

    it('does not confirm the object of another store, and writes no row in either', async () => {
      const mediaId = randomUUID()
      const foreignKey = StorageKeys.messageUpload(ctx.storeB.id, mediaId, 'photo.png')
      const response = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...uploadBody, mediaId, key: foreignKey })
      expect(response.status).toBe(403)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FILE_KEY_OUT_OF_SCOPE
      )
      expect(await owner.media.count({ where: { id: mediaId } })).toBe(0)
    })

    it('does not let the id of a media of another store be taken over from this one', async () => {
      const row = await owner.media.create({
        data: {
          storeId: ctx.storeB.id,
          purpose: 'message',
          key: StorageKeys.message(ctx.storeB.id, randomUUID(), 'photo.png'),
          filename: 'photo.png',
          contentType: 'image/png',
          fileSize: 68
        }
      })
      // The object is really there at the key store A would use for that id: the only thing left to
      // refuse the confirmation is that the id belongs to a row of store B
      const storage = app.get(StorageService, { strict: false })
      const stagingKey = StorageKeys.messageUpload(ctx.storeA.id, row.id, 'photo.png')
      const url = await storage.uploadUrl({
        key: stagingKey,
        contentType: 'image/png',
        contentLength: 68
      })
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'image/png', 'content-length': '68' },
        body: new Uint8Array(68)
      })
      expect(put.status).toBe(200)

      const response = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.confirmUpload)
        .send({ ...uploadBody, mediaId: row.id, key: stagingKey })

      expect(response.status).toBe(400)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.FILE_UPLOAD_FAILED
      )
      // The row of store B is as it was, and store A got none
      expect(
        await owner.media.findUniqueOrThrow({
          where: { id: row.id },
          select: { storeId: true, key: true, uploadedBy: true, status: true }
        })
      ).toEqual({ storeId: ctx.storeB.id, key: row.key, uploadedBy: null, status: 'pending' })
      expect(await owner.media.count({ where: { id: row.id, storeId: ctx.storeA.id } })).toBe(0)
      await storage.delete(stagingKey)
    })
  })

  // The gallery of a customer and "Download all" name the customer in the path or the body, so the
  // store that decides is the one of the header: a customer of another store is a 404 on both, and
  // a file of another store is never listed or zipped, even if its row names this customer.
  describe('media gallery', () => {
    it('answers 404 for a customer of another store, on the gallery and on "Download all"', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
      await owner.media.create({
        data: {
          storeId: ctx.storeB.id,
          purpose: 'message',
          customerId: foreign.id,
          key: StorageKeys.message(ctx.storeB.id, randomUUID(), 'theirs.png'),
          filename: 'theirs.png',
          contentType: 'image/png',
          fileSize: 10,
          status: 'clean'
        }
      })
      const exportsBefore = await owner.export.count({ where: { storeId: ctx.storeA.id } })

      const gallery = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.customers.media(foreign.id)
      )
      const zip = await api(app, ctx.adminA, ctx.storeA)
        .post(ApiRoutes.media.downloadAll)
        .send({ customerId: foreign.id })

      expect(gallery.status).toBe(404)
      expect(zip.status).toBe(404)
      expect(await owner.export.count({ where: { storeId: ctx.storeA.id } })).toBe(exportsBefore)
    })

    it('is refused in a store the user does not belong to', async () => {
      const own = await createCustomer(owner, { storeId: ctx.storeA.id })
      const gallery = await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.customers.media(own.id))
      const zip = await api(app, ctx.adminA, ctx.storeB)
        .post(ApiRoutes.media.downloadAll)
        .send({ customerId: own.id })
      expect(gallery.status).toBe(403)
      expect(zip.status).toBe(403)
    })
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

      const preChat = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.widgetPreChat(connection.id))
        .send({ enabled: true })

      expect(read.status).toBe(404)
      expect(write.status).toBe(404)
      expect(preChat.status).toBe(404)
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

  describe('naming a connection', () => {
    it('is answered as a connection that does not exist when it belongs to another store, and changes nothing', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: 'test_channel'
      })

      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.label(connectionA.id))
        .send({ label: 'Taken by the other store' })
      const missing = await api(app, ctx.adminB, ctx.storeB)
        .put(ApiRoutes.channels.label(randomUUID()))
        .send({ label: 'Taken by the other store' })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect((foreign.body as { error: unknown }).error).toEqual(
        (missing.body as { error: unknown }).error
      )
      const after = await owner.channelConnection.findUniqueOrThrow({
        where: { id: connectionA.id }
      })
      expect(after.label).toBeNull()
    })
  })

  describe('replacing the token of a connection', () => {
    it('is answered as a connection that does not exist when it belongs to another store, and leaves its credentials alone', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: 'test_channel'
      })
      const before = await owner.channelConnection.findUniqueOrThrow({
        where: { id: connectionA.id }
      })

      const foreign = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.channels.updateToken(connectionA.id))
        .send({ credentials: { token: 'EAAB-from-the-other-store' } })
      const missing = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.channels.updateToken(randomUUID()))
        .send({ credentials: { token: 'EAAB-from-the-other-store' } })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect((foreign.body as { error: unknown }).error).toEqual(
        (missing.body as { error: unknown }).error
      )
      const after = await owner.channelConnection.findUniqueOrThrow({
        where: { id: connectionA.id }
      })
      expect(Buffer.from(after.credentials).equals(Buffer.from(before.credentials))).toBe(true)
    })
  })

  // Step 7.8, rule 3 of CLAUDE.md: a login session is not a table but it is tenant data (it holds the token of
  // a person for one store), so it has its case here. The callback is public and knows no store: the store is
  // in the state that the authenticated start made, and every later step compares it with the store of the call.
  describe('the login session of a channel', () => {
    const LOGIN_PLUGIN = 'iso_login'
    let registry: PluginRegistry

    beforeAll(async () => {
      registry = app.get(PluginRegistry, { strict: false })
      registry.register(
        buildChannelPlugin({
          id: LOGIN_PLUGIN,
          oauth: {
            kind: 'meta-facebook-login',
            scopes: ['pages_show_list'],
            authorizationUrl: ({ state, redirectUri }) =>
              `https://dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
            exchangeCode: () => Promise.resolve('USER-TOKEN-OF-A'),
            grantedScopes: () => Promise.resolve(['pages_show_list']),
            listAssets: () =>
              Promise.resolve([{ id: '1100', name: 'Page of A', linkedAccount: null }]),
            credentialsFor: ({ assetId }) => Promise.resolve({ token: `PAGE-${assetId}` })
          }
        })
      )
      for (const store of [ctx.storeA, ctx.storeB]) {
        await ensurePluginInstallation(owner, { storeId: store.id, pluginId: LOGIN_PLUGIN })
      }
    })
    afterAll(() => {
      registry.unregister(LOGIN_PLUGIN)
    })

    it('is answered as a session that does not exist when it belongs to another store, and makes no connection there', async () => {
      const started = await api(app, ctx.adminA, ctx.storeA).post(
        ApiRoutes.channels.oauthStart(LOGIN_PLUGIN)
      )
      const state = new URL(
        (started.body as { authorizeUrl: string }).authorizeUrl
      ).searchParams.get('state')
      const back = await anonymousApi(app)
        .get(ApiRoutes.channels.oauthCallback)
        .query({ code: 'a-code', state })
        .redirects(0)
      const session = new URL(String(back.headers['location'])).searchParams.get('oauth') ?? ''
      const never = 'z'.repeat(43)
      const before = await owner.channelConnection.count({ where: { pluginId: LOGIN_PLUGIN } })

      const asB = (): ReturnType<typeof api> => api(app, ctx.adminB, ctx.storeB)
      const answers = [
        [
          await asB().get(ApiRoutes.channels.oauthAssets(session)),
          await asB().get(ApiRoutes.channels.oauthAssets(never))
        ],
        [
          await asB().post(ApiRoutes.channels.oauthComplete(session)).send({ assetId: '1100' }),
          await asB().post(ApiRoutes.channels.oauthComplete(never)).send({ assetId: '1100' })
        ],
        [
          await asB().delete(ApiRoutes.channels.oauthSession(session)),
          await asB().delete(ApiRoutes.channels.oauthSession(never))
        ]
      ]
      for (const [foreign, missing] of answers) {
        expect(foreign?.status).toBe(404)
        expect(missing?.status).toBe(404)
        expect((foreign?.body as { error: unknown }).error).toEqual(
          (missing?.body as { error: unknown }).error
        )
      }
      expect(await owner.channelConnection.count({ where: { pluginId: LOGIN_PLUGIN } })).toBe(
        before
      )
      // The owner of the session still has it: the other store changed nothing
      const own = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.channels.oauthAssets(session)
      )
      expect(own.status).toBe(200)
    })

    it('cannot repair a connection of another store: it is answered as one that does not exist, and no state is kept', async () => {
      const connectionA = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: LOGIN_PLUGIN
      })
      const saved = jest.spyOn(app.get(ChannelOAuthStore, { strict: false }), 'saveState')
      try {
        // The same call from the store that owns the connection is accepted: the 404 below is the store, not the plugin
        const own = await api(app, ctx.adminA, ctx.storeA)
          .post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
          .send({ connectionId: connectionA.id })
        expect(own.status).toBe(200)
        saved.mockClear()
        const foreign = await api(app, ctx.adminB, ctx.storeB)
          .post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
          .send({ connectionId: connectionA.id })
        const missing = await api(app, ctx.adminB, ctx.storeB)
          .post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
          .send({ connectionId: randomUUID() })
        expect(foreign.status).toBe(404)
        expect(missing.status).toBe(404)
        expect((foreign.body as { error: unknown }).error).toEqual(
          (missing.body as { error: unknown }).error
        )
        expect(saved).not.toHaveBeenCalled()
      } finally {
        saved.mockRestore()
      }
      // The connection of the other store is as it was
      const row = await owner.channelConnection.findUniqueOrThrow({ where: { id: connectionA.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
    })

    it('cannot be started or finished for a store the person does not belong to', async () => {
      const intruder = api(app, ctx.adminA, ctx.storeB)
      const start = await intruder.post(ApiRoutes.channels.oauthStart(LOGIN_PLUGIN))
      expect(start.status).toBe(403)
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

  // The mark of attention and the reminder of a snooze belong to the conversation: another store neither
  // clears the mark by opening it, nor sets a reminder, nor sees the conversation in its list
  describe('the mark of attention of a conversation', () => {
    it('is not cleared, set or listed through another store', async () => {
      const { id } = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await owner.conversation.update({
        where: { id },
        data: {
          attentionReason: 'snooze_woke',
          attentionAt: new Date(),
          attentionNote: 'private reminder'
        }
      })
      const asB = () => api(app, ctx.adminB, ctx.storeB)

      const opened = await asB().post(ApiRoutes.conversations.read(id))
      const snoozed = await asB()
        .post(ApiRoutes.conversations.snooze(id))
        .send({ until: new Date(Date.now() + 3_600_000).toISOString(), note: 'not mine' })
      const listed = await asB().get(ApiRoutes.conversations.list)

      expect(opened.status).toBe(404)
      expect(snoozed.status).toBe(404)
      expect(JSON.stringify(listed.body)).not.toContain('private reminder')
      const after = await owner.conversation.findUniqueOrThrow({
        where: { id },
        select: { status: true, snoozeNote: true, attentionReason: true, attentionNote: true }
      })
      expect(after).toEqual({
        status: ConversationStatus.OPEN,
        snoozeNote: null,
        attentionReason: 'snooze_woke',
        attentionNote: 'private reminder'
      })
    })
  })

  // The text under a file belongs to the message of its conversation: another store neither reads it from
  // the thread, nor finds it in a list, nor sends one of its own under a file of this store
  describe('the text under the files of a message', () => {
    it('is not read, listed or written through another store', async () => {
      const { id: conversationId } = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const message = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId,
          type: MessageType.IMAGE,
          content: 'private text under a file',
          authorType: 'agent'
        },
        select: { id: true }
      })
      const mediaId = randomUUID()
      await owner.media.create({
        data: {
          id: mediaId,
          storeId: ctx.storeA.id,
          messageId: message.id,
          purpose: 'message',
          key: `stores/${ctx.storeA.id}/messages/${mediaId}/a.png`,
          filename: 'a.png',
          contentType: 'image/png',
          fileSize: 10,
          status: 'clean',
          position: 0,
          caption: 'private text under a file'
        }
      })
      const asB = () => api(app, ctx.adminB, ctx.storeB)

      const thread = await asB().get(ApiRoutes.conversations.messages(conversationId))
      const list = await asB().get(ApiRoutes.conversations.list)
      const write = await asB()
        .post(ApiRoutes.messages.create)
        .send({
          type: MessageType.IMAGE,
          conversationId,
          mediaIds: [mediaId],
          captions: ['hijacked'],
          idempotencyKey: randomUUID()
        })

      // Even a text that failed and could be sent again is not reachable from another store
      await owner.message.update({
        where: { id: message.id },
        data: { deliveryStatus: 'sent', captionState: 'failed' }
      })
      const resend = await asB().post(ApiRoutes.messages.resendCaption(message.id))
      expect(resend.status).toBe(404)
      expect(
        (
          await owner.message.findUniqueOrThrow({
            where: { id: message.id },
            select: { captionState: true }
          })
        ).captionState
      ).toBe('failed')
      expect(thread.status).toBe(404)
      expect(JSON.stringify([thread.body, list.body])).not.toContain('private text under a file')
      expect(write.status).toBe(404)
      const after = await owner.media.findUniqueOrThrow({
        where: { id: mediaId },
        select: { caption: true, messageId: true }
      })
      expect(after).toEqual({ caption: 'private text under a file', messageId: message.id })
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
