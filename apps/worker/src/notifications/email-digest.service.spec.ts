import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
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
const NOW = new Date('2026-11-02T14:10:00.000Z') // 08:10 in El Salvador (UTC-6)
const HOUR = 3_600_000

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
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
          membership: { findMany: findMemberships }
        }
      } as unknown as PrismaService,
      { addBulk } as unknown as Queue<SendEmailDigestJob>,
      { add: addEmail } as unknown as Queue<SendEmailJob>,
      { frontendUrl: 'https://app.example.com' },
      { setContext: jest.fn(), warn } as unknown as PinoLogger
    )

  beforeEach(() => {
    jest.resetAllMocks()
    updateNotifications.mockResolvedValue({ count: 1 })
    findMemberships.mockImplementation((args: unknown) => {
      const ids = (args as { where: { storeId: { in: string[] } } }).where.storeId.in
      return Promise.resolve(ids.map(storeId => ({ storeId })))
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
      const report = await service().scan(DigestFrequency.HOURLY, NOW)
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

    it('drops the marks older than the limit on every run', async () => {
      findNotifications.mockResolvedValue([])
      await service().scan(DigestFrequency.HOURLY, NOW)
      expect(updateNotifications).toHaveBeenCalledWith({
        where: { emailPendingAt: { not: null, lt: new Date(NOW.getTime() - 48 * HOUR) } },
        data: { emailPendingAt: null }
      })
      updateNotifications.mockClear()
      await service().scan(DigestFrequency.DAILY, NOW)
      expect(updateNotifications).toHaveBeenCalledTimes(1)
    })

    it('sends the daily digest only to who reads 08:00 on their own clock', async () => {
      findNotifications.mockResolvedValue([{ userId: USER }, { userId: OTHER }])
      findSettings.mockResolvedValue([
        { userId: USER, digestFrequency: 'daily', timezone: 'America/El_Salvador' },
        { userId: OTHER, digestFrequency: 'daily', timezone: 'UTC' }
      ])
      const report = await service().scan(DigestFrequency.DAILY, NOW)
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
      const report = await service().scan(DigestFrequency.HOURLY, NOW)
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
      const report = await service().scan(DigestFrequency.DAILY, NOW)
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
          items: [{ storeName: 'Shop', url: 'https://app.example.com/s/s1/inbox/c1' }]
        },
        headers: { 'List-Unsubscribe': '<https://app.example.com/account/notifications>' }
      })
      // What the service queues is what the template accepts, in both languages
      const queued = data as { template: typeof EmailTemplates.NOTIFICATION_DIGEST; data: unknown }
      const email = await new TemplateRenderer().render(queued.template, Locales.EN, queued.data)
      expect(email.text).toContain('Conversation assigned')
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
          row('c1', { messageKey: reopened }),
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
