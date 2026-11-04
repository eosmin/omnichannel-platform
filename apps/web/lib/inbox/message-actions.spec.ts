import type { MessageView } from '@platform/api-client'
import { type Permission, Permissions } from '@platform/core/auth'
import { ChannelCapability } from '@platform/core/domain'

import { type ActionViewer, hasAnyAction, messageActionsOf } from './message-actions'

const ME = 'user-me'
const OTHER = 'user-other'

const message = (over: Partial<MessageView>): MessageView => ({
  id: 'm1',
  conversationId: 'c1',
  type: 'TEXT',
  content: 'hola',
  authorType: 'agent',
  authorId: ME,
  replyToMessageId: null,
  replyTo: null,
  deliveryStatus: 'sent',
  deliveryError: null,
  system: null,
  attachmentUrl: null,
  location: null,
  reactions: [],
  media: [],
  unavailableFiles: [],
  captionState: null,
  mentions: [],
  version: 1,
  editedAt: null,
  editedByType: null,
  editedById: null,
  pendingEdit: false,
  editStatus: null,
  editError: null,
  deletedAt: null,
  deletedByType: null,
  deletedById: null,
  deleteStatus: null,
  deleteError: null,
  createdAt: '2026-10-30T10:00:00.000Z',
  ...over
})

const viewer = (held: Permission[], capabilities: string[] = []): ActionViewer => ({
  userId: ME,
  can: permission => held.includes(permission),
  capabilities
})

const AGENT = [
  Permissions.MESSAGES_SEND,
  Permissions.MESSAGES_VIEW,
  Permissions.MESSAGES_INTERNAL_NOTE
]
const ALL_CAPABILITIES = [
  ChannelCapability.REACTIONS,
  ChannelCapability.EDIT_MESSAGE,
  ChannelCapability.DELETE_MESSAGE
]

describe('messageActionsOf', () => {
  it('offers no edit and no delete on a channel that declares neither, but still resends', () => {
    const channel = [ChannelCapability.REACTIONS]
    expect(messageActionsOf(message({}), viewer(AGENT, channel))).toMatchObject({
      react: true,
      edit: false,
      remove: false
    })
    expect(
      messageActionsOf(message({ deliveryStatus: 'failed' }), viewer(AGENT, channel)).resend
    ).toBe(true)
  })

  it('offers edit and delete of an own reply when the channel declares them', () => {
    expect(messageActionsOf(message({}), viewer(AGENT, ALL_CAPABILITIES))).toMatchObject({
      react: true,
      edit: true,
      remove: true,
      resend: false
    })
  })

  it('does not offer to edit a reply of another agent, but a manager may delete it', () => {
    const theirs = message({ authorId: OTHER })
    expect(messageActionsOf(theirs, viewer(AGENT, ALL_CAPABILITIES))).toMatchObject({
      edit: false,
      remove: false
    })
    expect(
      messageActionsOf(theirs, viewer([...AGENT, Permissions.MESSAGES_DELETE], ALL_CAPABILITIES))
    ).toMatchObject({ edit: false, remove: true })
  })

  it('offers nothing on a reply the channel has not got yet, or while its edit is on its way', () => {
    expect(
      hasAnyAction(
        messageActionsOf(message({ deliveryStatus: 'queued' }), viewer(AGENT, ALL_CAPABILITIES))
      )
    ).toBe(false)
    expect(
      messageActionsOf(message({ pendingEdit: true }), viewer(AGENT, ALL_CAPABILITIES))
    ).toMatchObject({ edit: false, remove: false })
  })

  it('offers nothing while a deletion is on its way', () => {
    const deleting = message({ deleteStatus: 'queued' })
    expect(hasAnyAction(messageActionsOf(deleting, viewer(AGENT, ALL_CAPABILITIES)))).toBe(false)
  })

  it('lets an agent react to a message of the customer, never to change it', () => {
    const theirs = message({ authorType: 'customer', authorId: null, deliveryStatus: null })
    expect(messageActionsOf(theirs, viewer(AGENT, ALL_CAPABILITIES))).toEqual({
      react: true,
      reply: false,
      edit: false,
      remove: false,
      resend: false,
      resendCaption: false,
      refetchFile: true,
      viewDeleted: false,
      revisions: false
    })
    expect(
      messageActionsOf(theirs, viewer([Permissions.MESSAGES_VIEW], ALL_CAPABILITIES)).react
    ).toBe(false)
  })

  it('offers to download a lost file of the customer only to who may send', () => {
    const theirs = message({ authorType: 'customer', authorId: null, deliveryStatus: null })
    expect(
      messageActionsOf(theirs, viewer([Permissions.MESSAGES_VIEW], ALL_CAPABILITIES)).refetchFile
    ).toBe(false)
    expect(messageActionsOf(theirs, viewer(AGENT, ALL_CAPABILITIES)).refetchFile).toBe(true)
    const ours = message({ type: 'IMAGE' })
    expect(messageActionsOf(ours, viewer(AGENT, ALL_CAPABILITIES)).refetchFile).toBe(false)
    const owners = message({ authorType: 'external', authorId: null, deliveryStatus: null })
    expect(messageActionsOf(owners, viewer(AGENT, ALL_CAPABILITIES)).refetchFile).toBe(false)
  })

  it('does not offer a reaction on a plugin message the channel has not got yet', () => {
    const queued = message({ authorType: 'system', authorId: null, deliveryStatus: 'queued' })
    expect(messageActionsOf(queued, viewer(AGENT, ALL_CAPABILITIES)).react).toBe(false)
    const owner = message({ authorType: 'external', authorId: null, deliveryStatus: null })
    expect(messageActionsOf(owner, viewer(AGENT, ALL_CAPABILITIES)).react).toBe(true)
  })

  it('treats a note as the team own: no capability needed, no reaction, no resend', () => {
    const note = message({ type: 'INTERNAL_NOTE', deliveryStatus: null })
    expect(messageActionsOf(note, viewer(AGENT))).toEqual({
      react: false,
      reply: false,
      edit: true,
      remove: true,
      resend: false,
      resendCaption: false,
      refetchFile: false,
      viewDeleted: false,
      revisions: false
    })
  })

  it('lets only the author or a manager delete a note, and shows the revisions of an edited one', () => {
    const theirs = message({
      type: 'INTERNAL_NOTE',
      authorId: OTHER,
      deliveryStatus: null,
      editedAt: '2026-10-30T11:00:00.000Z'
    })
    expect(messageActionsOf(theirs, viewer(AGENT))).toMatchObject({
      edit: true,
      remove: false,
      revisions: true
    })
    expect(messageActionsOf(theirs, viewer([...AGENT, Permissions.MESSAGES_DELETE])).remove).toBe(
      true
    )
  })

  it('hides notes from who cannot read them', () => {
    const note = message({ type: 'INTERNAL_NOTE', deliveryStatus: null })
    expect(hasAnyAction(messageActionsOf(note, viewer([Permissions.MESSAGES_SEND])))).toBe(false)
  })

  it('offers the kept text of a deleted message only with its permission', () => {
    const deleted = message({
      authorType: 'customer',
      deletedAt: '2026-10-30T11:00:00.000Z',
      deletedByType: 'customer'
    })
    expect(messageActionsOf(deleted, viewer(AGENT)).viewDeleted).toBe(false)
    expect(messageActionsOf(deleted, viewer([Permissions.MESSAGES_VIEW_DELETED])).viewDeleted).toBe(
      true
    )
  })

  it('offers nothing on a line of the system or a type with no bubble', () => {
    expect(
      hasAnyAction(messageActionsOf(message({ type: 'LOCATION' }), viewer(AGENT, ALL_CAPABILITIES)))
    ).toBe(false)
  })

  it('needs the template permission to send a template again', () => {
    const template = message({ type: 'TEMPLATE', deliveryStatus: 'failed' })
    expect(messageActionsOf(template, viewer(AGENT)).resend).toBe(false)
    expect(
      messageActionsOf(template, viewer([...AGENT, Permissions.MESSAGES_SEND_TEMPLATE])).resend
    ).toBe(true)
  })

  describe('the text under a file', () => {
    const file = (captionState: MessageView['captionState']): MessageView =>
      message({ type: 'IMAGE', captionState })

    it.each(['failed', 'unconfirmed'] as const)('can be sent again when it is %s', state => {
      const actions = messageActionsOf(file(state), viewer(AGENT, ALL_CAPABILITIES))
      expect(actions.resendCaption).toBe(true)
      // The button lives in the bubble: it alone does not open the bar
      expect(hasAnyAction({ ...actions, react: false, remove: false })).toBe(false)
      expect(hasAnyAction({ ...actions, react: false, remove: false, resendCaption: true })).toBe(
        false
      )
    })

    it.each([null, 'queued'] as const)('cannot be sent again when it is %j', state => {
      expect(messageActionsOf(file(state), viewer(AGENT, ALL_CAPABILITIES)).resendCaption).toBe(
        false
      )
    })

    it('is not offered to who may not send', () => {
      expect(
        messageActionsOf(file('failed'), viewer([Permissions.MESSAGES_VIEW])).resendCaption
      ).toBe(false)
    })

    it('leaves the message alone from the moment it is queued: it cannot be deleted', () => {
      expect(messageActionsOf(file('queued'), viewer(AGENT, ALL_CAPABILITIES)).remove).toBe(false)
    })
  })
})

describe('messageActionsOf reply', () => {
  const QUOTING = [ChannelCapability.REPLY_TO]
  const customer = (over: Partial<MessageView> = {}): MessageView =>
    message({ authorType: 'customer', authorId: null, deliveryStatus: null, ...over })

  it('offers to answer a message of the customer on a channel that quotes', () => {
    expect(messageActionsOf(customer(), viewer(AGENT, QUOTING)).reply).toBe(true)
  })

  it('offers it for a reply of the team only once it reached the channel', () => {
    expect(messageActionsOf(message({}), viewer(AGENT, QUOTING)).reply).toBe(true)
    expect(
      messageActionsOf(message({ deliveryStatus: 'queued' }), viewer(AGENT, QUOTING)).reply
    ).toBe(false)
    expect(
      messageActionsOf(message({ deliveryStatus: 'failed' }), viewer(AGENT, QUOTING)).reply
    ).toBe(false)
  })

  it('offers it for a file and for a location', () => {
    expect(messageActionsOf(customer({ type: 'IMAGE' }), viewer(AGENT, QUOTING)).reply).toBe(true)
    expect(
      messageActionsOf(
        customer({
          type: 'LOCATION',
          location: { latitude: 1, longitude: 2, name: null, address: null }
        }),
        viewer(AGENT, QUOTING)
      ).reply
    ).toBe(true)
  })

  it.each([
    ['a channel that does not quote', customer(), viewer(AGENT, [])],
    ['a person who may not send', customer(), viewer([Permissions.MESSAGES_VIEW], QUOTING)],
    ['an internal note', message({ type: 'INTERNAL_NOTE' }), viewer(AGENT, QUOTING)],
    [
      'a deleted message',
      customer({ deletedAt: '2026-10-30T11:00:00.000Z' }),
      viewer(AGENT, QUOTING)
    ],
    ['a system line', message({ type: 'SYSTEM' }), viewer(AGENT, QUOTING)]
  ])('does not offer it on %s', (_name, target, who) => {
    expect(messageActionsOf(target, who).reply).toBe(false)
  })

  it('counts as an action of the bar', () => {
    expect(hasAnyAction(messageActionsOf(customer(), viewer(AGENT, QUOTING)))).toBe(true)
  })
})
