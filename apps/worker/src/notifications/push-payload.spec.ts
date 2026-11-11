import { Locales } from '@platform/core/i18n'
import {
  NotificationSeverity,
  NotificationTypes,
  notificationMessageKey,
  PushLimits
} from '@platform/core/notifications'

import { buildPushPayload, pushLocale, type PushNotificationRow } from './push-payload'

const row = (overrides: Partial<PushNotificationRow> = {}): PushNotificationRow => ({
  id: 'n1',
  type: NotificationTypes.CONVERSATION_ASSIGNED,
  severity: NotificationSeverity.INFO,
  messageKey: notificationMessageKey(NotificationTypes.CONVERSATION_ASSIGNED),
  params: {},
  resourceId: 'c1',
  actionPath: '/s/store-1/inbox/c1',
  ...overrides
})

describe('buildPushPayload', () => {
  it('writes the text in the language of the person', () => {
    expect(buildPushPayload(row(), Locales.EN)).toMatchObject({
      title: 'Conversation assigned to you',
      body: 'A conversation is waiting for you.'
    })
    expect(buildPushPayload(row(), Locales.ES).title).toBe('Conversación asignada a ti')
  })

  it('says why a reply failed when the notification carries a reason that has a sentence', () => {
    const failed = row({
      type: NotificationTypes.MESSAGE_FAILED,
      messageKey: notificationMessageKey(NotificationTypes.MESSAGE_FAILED),
      params: { reason: 'CHANNEL_WINDOW_EXPIRED' }
    })

    expect(buildPushPayload(failed, Locales.EN).body).toContain('reply window')
    expect(buildPushPayload(failed, Locales.ES).body).toContain('ventana')
    // A reason with no sentence keeps the plain text
    expect(
      buildPushPayload({ ...failed, params: { reason: 'SOMETHING_NEW' } }, Locales.EN).body
    ).toBe('The channel did not accept a message you sent.')
  })

  it('carries what the service worker needs to open it and to replace an older one', () => {
    expect(buildPushPayload(row(), Locales.EN)).toMatchObject({
      notificationId: 'n1',
      tag: 'conversation.assigned:c1',
      severity: 'info',
      actionPath: '/s/store-1/inbox/c1'
    })
  })

  it('has a message for every type that can be pushed, in both languages', () => {
    for (const type of Object.values(NotificationTypes)) {
      for (const locale of [Locales.EN, Locales.ES]) {
        // The parameters a message may ask for (the day a token stops, the number of a count); a type that asks for none
        // ignores them
        const payload = buildPushPayload(
          row({
            type,
            messageKey: notificationMessageKey(type),
            params: { date: '2026-11-14', number: 'CT-0001' }
          }),
          locale
        )
        expect(payload.title.length).toBeGreaterThan(0)
        expect(payload.body.length).toBeGreaterThan(0)
      }
    }
  })

  it('stays under the size a push message may have', () => {
    const payload = buildPushPayload(row(), Locales.EN)
    expect([...payload.title].length).toBeLessThanOrEqual(PushLimits.MAX_TITLE_LENGTH)
    expect([...payload.body].length).toBeLessThanOrEqual(PushLimits.MAX_BODY_LENGTH)
  })

  it('never puts the name of a customer in the push, whose text the lock screen shows', () => {
    const generic = {
      [Locales.EN]: {
        [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE]:
          'There are conversations waiting for someone to take them.',
        [NotificationTypes.MESSAGE_RECEIVED]: 'A customer wrote to you.'
      },
      [Locales.ES]: {
        [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE]:
          'Hay conversaciones esperando que alguien las tome.',
        [NotificationTypes.MESSAGE_RECEIVED]: 'Un cliente te escribió.'
      }
    }
    for (const locale of [Locales.EN, Locales.ES]) {
      for (const type of [
        NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE,
        NotificationTypes.MESSAGE_RECEIVED
      ] as const) {
        const payload = buildPushPayload(
          row({
            type,
            messageKey: notificationMessageKey(type),
            params: { customer: 'Lucia Prechat', author: 'Lucia', text: 'my secret order' }
          }),
          locale
        )
        expect(payload.body).toBe(generic[locale][type])
        expect(JSON.stringify(payload)).not.toMatch(/Lucia|secret/)
      }
    }
  })

  it('throws for a type with no message: it will not have one when tried again', () => {
    expect(() => buildPushPayload(row({ messageKey: 'notifications.nope' }), Locales.EN)).toThrow(
      'missing translation'
    )
  })
})

describe('pushLocale', () => {
  it('keeps a language that has a catalog and falls back to the default for any other', () => {
    expect(pushLocale('en')).toBe(Locales.EN)
    expect(pushLocale('es')).toBe(Locales.ES)
    expect(pushLocale('pt-BR')).toBe(Locales.ES)
    expect(pushLocale('xx')).toBe(Locales.ES)
  })
})
