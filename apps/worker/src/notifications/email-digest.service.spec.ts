import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { JobContext, PrismaService } from '@platform/core/database'
import { DigestFrequency, MembershipStatus } from '@platform/core/domain'
import { TemplateRenderer } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import {
  DigestLimits,
  NotificationTypes,
  notificationMessageKey
} from '@platform/core/notifications'
import {
  EmailTemplates,
  JobNames,
  type SendEmailDigestJob,
  type SendEmailJob
} from '@platform/core/queues'

import { EmailDigestService } from './email-digest.service'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '33333333-3333-4333-8333-333333333333'
const STORE = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-11-02T14:10:00.000Z') // 08:10 in El Salvador (UTC-6)
const HOUR = 3_600_000

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: NotificationTypes.CONVERSATION_ASSIGNED,
  messageKey: notificationMessageKey(NotificationTypes.CONVERSATION_ASSIGNED),
  params: {},
  actionPath: '/s/s1/inbox/c1',
  readAt: null,
  createdAt: new Date(NOW.getTime() - HOUR),
  storeId: 's1',
  store: { name: 'Shop' },
  ...overrides
})

describe('EmailDigestService', () => {
  const findNotifications = jest.fn<Promise<unknown>, [unknown]>()
  const updateNotifications = jest.fn()
  const findSettings = jest.fn<Promise<unknown>, [unknown]>()
  const findOneSettings = jest.fn<Promise<unknown>, [unknown]>()
  const upsertSettings = jest.fn()
  const findUser = jest.fn<Promise<unknown>, [unknown]>()
  const addBulk = jest.fn()
  const addEmail = jest.fn<Promise<unknown>, [string, Record<string, unknown>, { jobId: string }]>()
  const warn = jest.fn()
  const findMemberships = jest.fn<Promise<unknown>, [unknown]>()
  const findPreferences = jest.fn<Promise<unknown>, [unknown]>()
  const forStore = jest.fn((_storeId: string, work: () => Promise<unknown>) => work())
  const forUser = jest.fn((_userId: string, work: () => Promise<unknown>) => work())
  // What the signed links are is checked in unsubscribe-links.spec.ts: here only that the person of the email is the one they are made for
  const unsubscribeFor = jest.fn((userId: string) => ({
    pageUrl: `https://app.example.com/unsubscribe#token=for-${userId}`,
    postUrl: `https://api.example.com/api/v1/notifications/unsubscribe?token=for-${userId}`
  }))

  const service = (): EmailDigestService =>
    new EmailDigestService(
      {
        client: {
          notification: { findMany: findNotifications, updateMany: updateNotifications },
          userNotificationSettings: {
            findMany: findSettings,
            findUnique: findOneSettings,
            upsert: upsertSettings
          },
          user: { findUnique: findUser },
          membership: { findMany: findMemberships },
          notificationPreference: { findMany: findPreferences },
          // The one store the sweeps of the digest walk
          store: { findMany: () => Promise.resolve([{ id: STORE }]) }
        }
      } as unknown as PrismaService,
      // The contexts only run the work here; that the work opens the right one is checked against a real database
      { forStore: forStore, forUser: forUser } as unknown as JobContext,
      { addBulk } as unknown as Queue<SendEmailDigestJob>,
      { add: addEmail } as unknown as Queue<SendEmailJob>,
      { frontendUrl: 'https://app.example.com' },
      { forUser: unsubscribeFor },
      { setContext: jest.fn(), warn } as unknown as PinoLogger
    )

  beforeEach(() => {
    jest.resetAllMocks()
    unsubscribeFor.mockImplementation(userId => ({
      pageUrl: `https://app.example.com/unsubscribe#token=for-${userId}`,
      postUrl: `https://api.example.com/api/v1/notifications/unsubscribe?token=for-${userId}`
    }))
    forStore.mockImplementation((_storeId, work) => work())
    forUser.mockImplementation((_userId, work) => work())
    updateNotifications.mockResolvedValue({ count: 1 })
    findMemberships.mockImplementation((args: unknown) => {
      const ids = (args as { where: { storeId: { in: string[] } } }).where.storeId.in
      return Promise.resolve(ids.map(storeId => ({ storeId })))
    })
    // By default the person has the email on for the two types the rows of these tests are about, in every store asked
    findPreferences.mockImplementation((args: unknown) => {
      const ids = (args as { where: { storeId: { in: string[] } } }).where.storeId.in
      return Promise.resolve(
        ids.flatMap(storeId =>
          [NotificationTypes.CONVERSATION_ASSIGNED, NotificationTypes.CONVERSATION_REOPENED].map(
            type => ({ storeId, type, email: true })
          )
        )
      )
    })
    addBulk.mockResolvedValue([])
    addEmail.mockResolvedValue({})
    upsertSettings.mockResolvedValue({})
    findOneSettings.mockResolvedValue({ digestFrequency: DigestFrequency.HOURLY })
    findUser.mockResolvedValue({ email: 'ana@example.com', locale: 'en', emailValid: true })
  })

  describe('scan', () => {
    it('queues one job for each person who chose the frequency, once per hour', async () => {
      findNotifications.mockResolvedValue([{ userId: USER }, { userId: OTHER }])
      findSettings.mockResolvedValue([{ userId: OTHER, digestFrequency: 'daily', timezone: 'UTC' }])
      const report = await service().scan(NOW)
      expect(report).toEqual({ queued: 1, full: false })
      const jobs = (addBulk.mock.calls as unknown[][])[0]?.[0] as {
        data: unknown
        opts: { jobId: string }
      }[]
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.data).toEqual({ userId: USER, frequency: DigestFrequency.HOURLY })
      expect(jobs[0]?.opts.jobId).toBe(
        `${JobNames.SEND_EMAIL_DIGEST}-hourly-${USER}-${Math.floor(NOW.getTime() / HOUR)}`
      )
    })

    it('reads the waiting notifications in the context of each store, never outside one', async () => {
      findNotifications.mockResolvedValue([])
      await service().scan(NOW)
      expect(forStore).toHaveBeenCalledWith(STORE, expect.any(Function))
      const asked = findNotifications.mock.calls[0]?.[0] as { where: { storeId: string } }
      expect(asked.where.storeId).toBe(STORE)
    })

    it('drops the marks older than the limit on every run', async () => {
      findNotifications.mockResolvedValue([])
      await service().scan(NOW)
      expect(updateNotifications).toHaveBeenCalledWith({
        where: {
          storeId: STORE,
          emailPendingAt: { not: null, lt: new Date(NOW.getTime() - 48 * HOUR) }
        },
        data: { emailPendingAt: null }
      })
    })

    it('clears the marks of a person who is on immediate or off, once they are six hours old', async () => {
      findNotifications.mockResolvedValue([])
      await service().scan(NOW)
      expect(updateNotifications).toHaveBeenCalledWith({
        where: {
          storeId: STORE,
          // Hours, not minutes: the job of an immediate mark and its retries end well before
          emailPendingAt: { not: null, lt: new Date(NOW.getTime() - 6 * HOUR) },
          user: {
            OR: [
              {
                notificationSettings: {
                  digestFrequency: { in: [DigestFrequency.IMMEDIATE, DigestFrequency.OFF] }
                }
              }
            ]
          }
        },
        data: { emailPendingAt: null }
      })
    })

    it('serves the hourly and the daily people with ONE read of the waiting marks', async () => {
      findNotifications.mockResolvedValue([{ userId: USER }, { userId: OTHER }])
      findSettings.mockResolvedValue([
        { userId: USER, digestFrequency: 'hourly', timezone: 'UTC' },
        { userId: OTHER, digestFrequency: 'daily', timezone: 'America/El_Salvador' }
      ])
      const report = await service().scan(NOW)
      expect(report.queued).toBe(2)
      // The read that decides who is waiting is made once per store, not once per frequency
      expect(findNotifications).toHaveBeenCalledTimes(1)
      const jobs = (addBulk.mock.calls as unknown[][])[0]?.[0] as {
        data: { userId: string; frequency: string }
      }[]
      expect(jobs.map(job => job.data)).toEqual([
        { userId: USER, frequency: DigestFrequency.HOURLY },
        { userId: OTHER, frequency: DigestFrequency.DAILY }
      ])
    })

    it('asks only for the hourly people, the daily ones whose clock reads the digest hour, and who chose nothing', async () => {
      findNotifications.mockResolvedValue([])
      await service().scan(NOW)
      const asked = findNotifications.mock.calls[0]?.[0] as {
        where: { user: { OR: { notificationSettings: { timezone?: { in: string[] } } }[] } }
      }
      const [hourly, daily, nothing] = asked.where.user.OR
      expect(hourly).toEqual({ notificationSettings: { digestFrequency: DigestFrequency.HOURLY } })
      expect(nothing).toEqual({ notificationSettings: { is: null } })
      // 14:10 UTC is 08:10 in El Salvador and not on the clock of UTC or Tokyo
      const zones = daily?.notificationSettings.timezone?.in ?? []
      expect(zones).toContain('America/El_Salvador')
      expect(zones).not.toContain('UTC')
      expect(zones).not.toContain('Asia/Tokyo')
    })

    it('does not queue a person whose settings turned immediate or off since the read', async () => {
      findNotifications.mockResolvedValue([{ userId: USER }, { userId: OTHER }])
      findSettings.mockResolvedValue([
        { userId: USER, digestFrequency: 'immediate', timezone: 'UTC' },
        { userId: OTHER, digestFrequency: 'off', timezone: 'UTC' }
      ])
      expect((await service().scan(NOW)).queued).toBe(0)
      expect(addBulk).not.toHaveBeenCalled()
    })

    it('sends the daily digest only to who reads 08:00 on their own clock', async () => {
      findNotifications.mockResolvedValue([{ userId: USER }, { userId: OTHER }])
      findSettings.mockResolvedValue([
        { userId: USER, digestFrequency: 'daily', timezone: 'America/El_Salvador' },
        { userId: OTHER, digestFrequency: 'daily', timezone: 'UTC' }
      ])
      const report = await service().scan(NOW)
      expect(report.queued).toBe(1)
      const jobs = (addBulk.mock.calls as unknown[][])[0]?.[0] as { data: { userId: string } }[]
      expect(jobs.map(job => job.data.userId)).toEqual([USER])
    })

    it('treats a person with no settings as hourly and reports a full scan', async () => {
      const waiting = Array.from({ length: DigestLimits.SCAN_BATCH }, (_, i) => ({
        userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      }))
      findNotifications.mockResolvedValue(waiting)
      findSettings.mockResolvedValue([])
      const report = await service().scan(NOW)
      expect(report).toEqual({ queued: DigestLimits.SCAN_BATCH, full: true })
    })
  })

  describe('scan, hardening', () => {
    it('reads a time zone it does not know as the default one and still serves the others', async () => {
      findNotifications.mockResolvedValue([{ userId: USER }, { userId: OTHER }])
      findSettings.mockResolvedValue([
        { userId: USER, digestFrequency: 'daily', timezone: 'Mars/Olympus' },
        { userId: OTHER, digestFrequency: 'daily', timezone: 'America/El_Salvador' }
      ])
      const report = await service().scan(NOW)
      expect(report.queued).toBe(2)
    })
  })

  describe('sendDigest', () => {
    it('leaves out a store the person no longer belongs to, and counts only what it left for the app', async () => {
      findNotifications.mockResolvedValue([
        { ...row('n1'), storeId: 's-left' },
        { ...row('n2', { actionPath: '/s/s-in/inbox/n2' }), storeId: 's-in' },
        ...Array.from({ length: DigestLimits.MAX_ITEMS }, (_, i) => ({
          ...row(`m${i}`, { actionPath: `/s/s-in/inbox/m${i}` }),
          storeId: 's-in'
        }))
      ])
      findMemberships.mockResolvedValue([{ storeId: 's-in' }])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      const data = addEmail.mock.calls[0]?.[1] as { data: { items: unknown[]; moreCount: number } }
      expect(data.data.items).toHaveLength(DigestLimits.MAX_ITEMS)
      expect(data.data.moreCount).toBe(1)
    })

    it('leaves out the store of a member who is suspended: their text does not reach the mailbox', async () => {
      findNotifications.mockResolvedValue([
        { ...row('n1'), storeId: 's-suspended' },
        { ...row('n2', { actionPath: '/s/s-in/inbox/n2' }), storeId: 's-in' }
      ])
      // A table, not a canned answer: what comes back depends on the status the query asks for
      const table = [
        { storeId: 's-in', status: MembershipStatus.ACTIVE },
        { storeId: 's-suspended', status: MembershipStatus.SUSPENDED }
      ]
      findMemberships.mockImplementation((args: unknown) => {
        const { status, storeId } = (
          args as { where: { status: MembershipStatus; storeId: { in: string[] } } }
        ).where
        return Promise.resolve(
          table.filter(member => member.status === status && storeId.in.includes(member.storeId))
        )
      })

      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

      const data = addEmail.mock.calls[0]?.[1] as { data: { items: unknown[]; moreCount: number } }
      expect(data.data.items).toHaveLength(1)
    })

    it('queues one email with the unread rows, then clears every mark it read', async () => {
      findNotifications.mockResolvedValue([
        row('n2'),
        row('n1', { readAt: new Date(NOW.getTime() - 60_000) })
      ])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

      expect(addEmail).toHaveBeenCalledTimes(1)
      const [name, data, options] = addEmail.mock.calls[0] ?? []
      expect(name).toBe(JobNames.SEND_EMAIL)
      expect(data).toMatchObject({
        template: EmailTemplates.NOTIFICATION_DIGEST,
        to: 'ana@example.com',
        locale: 'en',
        data: {
          moreCount: 0,
          appUrl: 'https://app.example.com/s/s1/inbox',
          settingsUrl: 'https://app.example.com/account/notifications',
          // The footer link opens the page of the one-click unsubscribe made for THIS person
          unsubscribeUrl: `https://app.example.com/unsubscribe#token=for-${USER}`,
          items: [{ storeName: 'Shop', url: 'https://app.example.com/s/s1/inbox/c1' }]
        },
        // RFC 8058: the url of the header is the signed POST url of this person, and the second header names the one-click form
        headers: {
          'List-Unsubscribe': `<https://api.example.com/api/v1/notifications/unsubscribe?token=for-${USER}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
      expect(unsubscribeFor).toHaveBeenCalledWith(USER)
      expect(unsubscribeFor).not.toHaveBeenCalledWith(OTHER)
      // What the service queues is what the template accepts, in both languages
      const queued = data as { template: typeof EmailTemplates.NOTIFICATION_DIGEST; data: unknown }
      const email = await new TemplateRenderer().render(queued.template, Locales.EN, queued.data)
      expect(email.text).toContain('Conversation assigned')
      // The footer says it, in the language of the person, with the link
      expect(email.html).toContain(`https://app.example.com/unsubscribe#token=for-${USER}`)
      expect(options?.jobId).toBe(`${EmailTemplates.NOTIFICATION_DIGEST}-${USER}-n2`)
      // The read one is cleared too, so it is not looked at again
      expect(updateNotifications).toHaveBeenCalledWith({
        where: { id: { in: ['n2', 'n1'] }, userId: USER, emailPendingAt: { not: null } },
        data: { emailPendingAt: null }
      })
      expect(upsertSettings).toHaveBeenCalledWith(
        expect.objectContaining({ update: { lastDigestSentAt: NOW } })
      )
    })

    it('still sends the digest, without the unsubscribe link, when the link cannot be signed', async () => {
      findNotifications.mockResolvedValue([row('n1')])
      unsubscribeFor.mockImplementation(() => {
        throw new Error('invalid id')
      })

      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

      expect(addEmail).toHaveBeenCalledTimes(1)
      const job = addEmail.mock.calls[0]?.[1] as {
        headers?: unknown
        data: Record<string, unknown>
      }
      expect(job.headers).toBeUndefined()
      expect(job.data['unsubscribeUrl']).toBeUndefined()
    })

    it('lists at most the limit and counts the rest', async () => {
      const rows = Array.from({ length: DigestLimits.MAX_ITEMS + 5 }, (_, i) =>
        row(`n${i}`, { actionPath: `/s/s1/inbox/c${i}` })
      )
      findNotifications.mockResolvedValue(rows)
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      const data = addEmail.mock.calls[0]?.[1] as { data: { items: unknown[]; moreCount: number } }
      expect(data.data.items).toHaveLength(DigestLimits.MAX_ITEMS)
      expect(data.data.moreCount).toBe(5)
    })

    describe('the choice of the person for each type, read when the email is made', () => {
      const sentItems = () =>
        (addEmail.mock.calls[0]?.[1] as { data: { items: unknown[] } } | undefined)?.data.items

      it('does not mail a type the person switched off after the mark was made, and clears its mark', async () => {
        findNotifications.mockResolvedValue([
          row('n2', {
            type: NotificationTypes.CONVERSATION_REOPENED,
            actionPath: '/s/s1/inbox/c2'
          }),
          row('n1')
        ])
        findPreferences.mockResolvedValue([
          { storeId: 's1', type: NotificationTypes.CONVERSATION_REOPENED, email: false },
          { storeId: 's1', type: NotificationTypes.CONVERSATION_ASSIGNED, email: true }
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        expect(sentItems()).toHaveLength(1)
        expect(updateNotifications).toHaveBeenCalledWith({
          where: { id: { in: ['n2', 'n1'] }, userId: USER, emailPendingAt: { not: null } },
          data: { emailPendingAt: null }
        })
      })

      it('sends no email at all when every type was switched off, but still clears the marks', async () => {
        findNotifications.mockResolvedValue([row('n1')])
        findPreferences.mockResolvedValue([
          { storeId: 's1', type: NotificationTypes.CONVERSATION_ASSIGNED, email: false }
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        expect(addEmail).not.toHaveBeenCalled()
        expect(updateNotifications).toHaveBeenCalledTimes(1)
      })

      it('reads the choice of a store apart from the same type in another store', async () => {
        findNotifications.mockResolvedValue([
          row('a', { storeId: 's1' }),
          row('b', { storeId: 's2', actionPath: '/s/s2/inbox/c1', store: { name: 'Other' } })
        ])
        findPreferences.mockResolvedValue([
          { storeId: 's1', type: NotificationTypes.CONVERSATION_ASSIGNED, email: false },
          { storeId: 's2', type: NotificationTypes.CONVERSATION_ASSIGNED, email: true }
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        expect(sentItems()).toHaveLength(1)
      })

      it('uses the factory choice of a type the person never touched, and no choice for a type it does not know', async () => {
        findNotifications.mockResolvedValue([
          // No row of theirs: this type has the email on in the factory matrix
          row('m', { type: NotificationTypes.CONVERSATION_MENTIONED }),
          // The factory matrix has no email for it
          row('a', { actionPath: '/s/s1/inbox/c2' }),
          row('x', { type: 'something.removed', actionPath: '/s/s1/inbox/c3' })
        ])
        findPreferences.mockResolvedValue([])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        expect(sentItems()).toHaveLength(1)
      })

      it('reads the choices in the context of the person, with the notifications', async () => {
        findNotifications.mockResolvedValue([row('n1')])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        expect(forUser).toHaveBeenCalledTimes(3)
        const asked = findPreferences.mock.calls[0]?.[0] as { where: { userId: string } }
        expect(asked.where.userId).toBe(USER)
      })
    })

    describe('grouping', () => {
      const sent = () =>
        addEmail.mock.calls[0]?.[1] as {
          data: {
            items: { count: number; url: string | null; storeName: string }[]
            moreCount: number
          }
        }

      it('turns the same notification about the same conversation into one block with a count', async () => {
        findNotifications.mockResolvedValue([row('n3'), row('n2'), row('n1')])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(sent().data.items).toHaveLength(1)
        expect(sent().data.items[0]).toMatchObject({ count: 3 })
        expect(sent().data.moreCount).toBe(0)
        // Every mark is cleared, the grouped rows too: none is mailed again
        expect(updateNotifications).toHaveBeenCalledWith({
          where: { id: { in: ['n3', 'n2', 'n1'] }, userId: USER, emailPendingAt: { not: null } },
          data: { emailPendingAt: null }
        })
      })

      it('keeps two conversations, two types and two stores apart, in the order of their newest row', async () => {
        const reopened = notificationMessageKey(NotificationTypes.CONVERSATION_REOPENED)
        findNotifications.mockResolvedValue([
          row('a1', { actionPath: '/s/s1/inbox/c1' }),
          row('b1', { actionPath: '/s/s1/inbox/c2' }),
          row('c1', { type: NotificationTypes.CONVERSATION_REOPENED, messageKey: reopened }),
          row('a2', { actionPath: '/s/s1/inbox/c1' }),
          { ...row('d1'), storeId: 's2', store: { name: 'Other shop' } }
        ])
        findMemberships.mockResolvedValue([{ storeId: 's1' }, { storeId: 's2' }])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(sent().data.items.map(item => [item.storeName, item.url, item.count])).toEqual([
          ['Shop', 'https://app.example.com/s/s1/inbox/c1', 2],
          ['Shop', 'https://app.example.com/s/s1/inbox/c2', 1],
          ['Shop', 'https://app.example.com/s/s1/inbox/c1', 1],
          ['Other shop', 'https://app.example.com/s/s1/inbox/c1', 1]
        ])
      })

      it('keeps apart notifications with no link by what they are about', async () => {
        findNotifications.mockResolvedValue([
          row('e3', { actionPath: null, resourceId: 'exp-2' }),
          row('e2', { actionPath: null, resourceId: 'exp-1' }),
          row('e1', { actionPath: null, resourceId: 'exp-1' })
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(sent().data.items.map(item => item.count)).toEqual([1, 2])
      })

      it('counts the limit in blocks and what is left out in notifications', async () => {
        const many = Array.from({ length: DigestLimits.MAX_ITEMS }, (_, i) =>
          row(`n${i}`, { actionPath: `/s/s1/inbox/c${i}` })
        )
        // Three more of the last block, and two of one block that does not fit
        findNotifications.mockResolvedValue([
          ...many,
          row('x1', { actionPath: `/s/s1/inbox/c${DigestLimits.MAX_ITEMS - 1}` }),
          row('x2', { actionPath: '/s/s1/inbox/late' }),
          row('x3', { actionPath: '/s/s1/inbox/late' })
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(sent().data.items).toHaveLength(DigestLimits.MAX_ITEMS)
        expect(sent().data.items.at(-1)).toMatchObject({ count: 2 })
        expect(sent().data.moreCount).toBe(2)
      })

      it('says in the email how many a block stands for, in both languages, and nothing for a lone one', async () => {
        findNotifications.mockResolvedValue([row('n2'), row('n1')])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        const queued = addEmail.mock.calls[0]?.[1] as {
          template: typeof EmailTemplates.NOTIFICATION_DIGEST
          data: unknown
        }

        const en = await new TemplateRenderer().render(queued.template, Locales.EN, queued.data)
        const es = await new TemplateRenderer().render(queued.template, Locales.ES, queued.data)
        expect(en.text).toContain('2 notifications like this')
        expect(en.text).toContain('(2)')
        expect(es.text).toContain('2 notificaciones como esta')

        addEmail.mockClear()
        findNotifications.mockResolvedValue([row('n1')])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        const lone = addEmail.mock.calls[0]?.[1] as typeof queued
        const text = (await new TemplateRenderer().render(lone.template, Locales.EN, lone.data))
          .text
        expect(text).not.toContain('like this')
      })
    })

    describe('what each block says', () => {
      const queue = (id: string, customer: string, overrides: Record<string, unknown> = {}) =>
        row(id, {
          messageKey: notificationMessageKey(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE),
          params: { customer },
          actionPath: `/s/s1/inbox/${id}`,
          ...overrides
        })
      const textIn = async (locale: typeof Locales.EN | typeof Locales.ES) => {
        const queued = addEmail.mock.calls[0]?.[1] as {
          template: typeof EmailTemplates.NOTIFICATION_DIGEST
          data: unknown
        }
        return (await new TemplateRenderer().render(queued.template, locale, queued.data)).text
      }

      it('tells two conversations of the queue apart by customer and by time', async () => {
        findNotifications.mockResolvedValue([
          queue('c2', 'Marco Díaz', { createdAt: new Date(NOW.getTime() - 5 * 60_000) }),
          queue('c1', 'Lucia Prechat', { createdAt: new Date(NOW.getTime() - HOUR) })
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        const en = await textIn(Locales.EN)
        expect(en).toContain('The conversation with Marco Díaz is waiting for someone to take it.')
        expect(en).toContain(
          'The conversation with Lucia Prechat is waiting for someone to take it.'
        )
        // Times on the clock of the person (the default zone, El Salvador, UTC-6 here): 08:05 and 07:10
        expect(en).toContain('08:05')
        expect(en).toContain('07:10')

        // The texts and the times are written in the language of the person when the email is made
        addEmail.mockClear()
        findUser.mockResolvedValue({ email: 'ana@example.com', locale: 'es', emailValid: true })
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
        const es = await textIn(Locales.ES)
        expect(es).toContain('2 nov, 08:05')
        expect(es).toContain('La conversación con Marco Díaz está esperando que alguien la tome.')
      })

      it('says why an export failed when the row carries a reason with a sentence', async () => {
        findNotifications.mockResolvedValue([
          row('x1', {
            messageKey: notificationMessageKey(NotificationTypes.EXPORT_FAILED),
            params: { type: 'media_zip', reason: 'EXPORT_TOO_LARGE' },
            actionPath: '/s/s1/exports'
          })
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(await textIn(Locales.EN)).toContain('The export is too large.')
      })

      it('uses the time zone the person chose for the time', async () => {
        findOneSettings.mockResolvedValue({
          digestFrequency: DigestFrequency.HOURLY,
          timezone: 'Asia/Dubai'
        })
        findNotifications.mockResolvedValue([queue('c1', 'Lucia Prechat')])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        // 13:10Z is 17:10 in Dubai
        expect(await textIn(Locales.EN)).toContain('17:10')
      })

      it('says when the newest of a repeated block happened', async () => {
        findNotifications.mockResolvedValue([
          queue('c1', 'Lucia Prechat', { createdAt: new Date(NOW.getTime() - 5 * 60_000) }),
          queue('c1', 'Lucia Prechat', { createdAt: new Date(NOW.getTime() - HOUR) })
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(await textIn(Locales.EN)).toContain(
          '2 notifications like this; the latest: Nov 2, 08:05'
        )
      })

      it('keeps the plain text for a queue notification saved before the customer was named', async () => {
        findNotifications.mockResolvedValue([queue('c1', 'x', { params: {} })])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(await textIn(Locales.EN)).toContain(
          'There are conversations waiting for someone to take them.'
        )
      })

      it('words the link by where it goes: a conversation, the channels, the team, the exports', async () => {
        const kinds: [string, string, string][] = [
          [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, '/s/s1/inbox/c1', 'Open conversation'],
          [NotificationTypes.CHANNEL_DISCONNECTED, '/s/s1/settings/channels', 'Review channels'],
          [NotificationTypes.INVITATION_ACCEPTED, '/s/s1/settings/team', 'Open the team'],
          [NotificationTypes.EXPORT_READY, '/s/s1/exports', 'Open exports']
        ]
        for (const [type, actionPath, link] of kinds) {
          addEmail.mockClear()
          findNotifications.mockResolvedValue([
            row('n1', { messageKey: notificationMessageKey(type as never), actionPath })
          ])
          await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

          const text = await textIn(Locales.EN)
          expect(text).toContain(link)
          for (const [, , other] of kinds) {
            if (other !== link) expect(text).not.toContain(other)
          }
        }
      })
    })

    describe('a mention', () => {
      const mention = (id: string, params: Record<string, unknown>) =>
        row(id, {
          messageKey: notificationMessageKey(NotificationTypes.CONVERSATION_MENTIONED),
          params
        })
      const render = async (locale: typeof Locales.EN | typeof Locales.ES) => {
        const queued = addEmail.mock.calls[0]?.[1] as {
          template: typeof EmailTemplates.NOTIFICATION_DIGEST
          data: unknown
        }
        return (await new TemplateRenderer().render(queued.template, locale, queued.data)).text
      }
      const people = { author: 'Ana Pérez', customer: 'Lucia Prechat' }

      it('names who wrote the note and whose conversation it is', async () => {
        findNotifications.mockResolvedValue([mention('n1', people)])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        expect(await render(Locales.EN)).toContain(
          'Ana Pérez mentioned you in a note on the conversation with Lucia Prechat.'
        )
      })

      it('says once how many times, with no line that repeats it', async () => {
        findNotifications.mockResolvedValue([
          mention('n3', people),
          mention('n2', people),
          mention('n1', people)
        ])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        const en = await render(Locales.EN)
        expect(en).toContain(
          'Ana Pérez mentioned you 3 times in a note (conversation with Lucia Prechat).'
        )
        expect(en).not.toContain('like this')
      })

      it('keeps the plain text for a mention saved before the names, and links the preferences by words', async () => {
        findNotifications.mockResolvedValue([mention('n1', {})])
        await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)

        const en = await render(Locales.EN)
        expect(en).toContain('A teammate mentioned you in an internal note.')
        expect(en).toContain('Change it in your notification preferences')
        expect(en).toContain('Open conversation')
        // A mention carries no time of its own in the params: the time comes from the row
        expect(en).toContain('07:10')
      })
    })

    it('sends nothing when all is read, too old, or the address bounces, but clears the marks', async () => {
      findNotifications.mockResolvedValue([
        row('n1', { readAt: NOW }),
        row('n2', { createdAt: new Date(NOW.getTime() - 49 * HOUR) })
      ])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      expect(addEmail).not.toHaveBeenCalled()
      expect(updateNotifications).toHaveBeenCalledTimes(1)

      findNotifications.mockResolvedValue([row('n3')])
      findUser.mockResolvedValue({ email: 'x@example.com', locale: 'en', emailValid: false })
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      expect(addEmail).not.toHaveBeenCalled()
    })

    it('does nothing when the person changed the frequency since the scan', async () => {
      findOneSettings.mockResolvedValue({ digestFrequency: DigestFrequency.OFF })
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      expect(findNotifications).not.toHaveBeenCalled()
      expect(addEmail).not.toHaveBeenCalled()
    })

    it('leaves a row with no message text out of the email and keeps the others', async () => {
      findNotifications.mockResolvedValue([
        row('n1', { messageKey: 'notifications.nope' }),
        row('n2')
      ])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      const data = addEmail.mock.calls[0]?.[1] as { data: { items: unknown[]; moreCount: number } }
      expect(data.data.items).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
    })

    it('opens the inbox of a store the email speaks of, not of one whose row it dropped', async () => {
      findNotifications.mockResolvedValue([
        { ...row('n1', { messageKey: 'notifications.nope' }), storeId: 's-dropped' },
        { ...row('n2'), storeId: 's-shown' }
      ])
      findMemberships.mockResolvedValue([{ storeId: 's-dropped' }, { storeId: 's-shown' }])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      const data = addEmail.mock.calls[0]?.[1] as { data: { appUrl: string } }
      expect(data.data.appUrl).toBe('https://app.example.com/s/s-shown/inbox')
    })

    it('never makes a link out of a path that names another host', async () => {
      findNotifications.mockResolvedValue([row('n1', { actionPath: '//evil.example/x' })])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      const data = addEmail.mock.calls[0]?.[1] as { data: { items: { url: string | null }[] } }
      expect(data.data.items[0]?.url).toBeNull()
    })

    it('speaks the language of the person, Spanish included', async () => {
      findUser.mockResolvedValue({ email: 'ana@example.com', locale: 'es', emailValid: true })
      findNotifications.mockResolvedValue([row('n1')])
      await service().sendDigest(USER, DigestFrequency.HOURLY, NOW)
      expect(addEmail.mock.calls[0]?.[1]).toMatchObject({ locale: 'es' })
    })
  })

  describe('handleQueued', () => {
    it('sends one email at once for the immediate kind, and does not touch the digest time', async () => {
      findOneSettings.mockResolvedValue({ digestFrequency: DigestFrequency.IMMEDIATE })
      findNotifications.mockResolvedValue([row('n1')])
      await service().handleQueued(USER, 'n1', NOW)
      expect(findNotifications).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, emailPendingAt: { not: null }, id: 'n1' }
        })
      )
      expect(addEmail).toHaveBeenCalledTimes(1)
      expect(upsertSettings).not.toHaveBeenCalled()
    })

    it('drops the mark for the off kind and sends nothing', async () => {
      findOneSettings.mockResolvedValue({ digestFrequency: DigestFrequency.OFF })
      await service().handleQueued(USER, 'n1', NOW)
      expect(addEmail).not.toHaveBeenCalled()
      expect(updateNotifications).toHaveBeenCalledWith({
        where: { id: { in: ['n1'] }, userId: USER, emailPendingAt: { not: null } },
        data: { emailPendingAt: null }
      })
    })

    it('leaves the mark alone for hourly and daily: the scheduler owns it', async () => {
      await service().handleQueued(USER, 'n1', NOW)
      expect(addEmail).not.toHaveBeenCalled()
      expect(updateNotifications).not.toHaveBeenCalled()
    })

    it('uses the settings default when the person never opened the preferences', async () => {
      findOneSettings.mockResolvedValue(null)
      await service().handleQueued(USER, 'n1', NOW)
      expect(addEmail).not.toHaveBeenCalled()
    })
  })
})
