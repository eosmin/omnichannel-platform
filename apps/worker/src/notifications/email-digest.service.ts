import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { AppPaths, DigestFrequency, MembershipStatus } from '@platform/core/domain'
import type { Locale } from '@platform/core/i18n'
import { createTranslator, hasTranslation } from '@platform/core/i18n-server'
import {
  bodyVariantOf,
  reasonNameOf,
  DIGEST_LINKS,
  DigestLimits,
  type DigestLinkKind,
  digestLinkKindOf,
  type DigestLinks,
  isDailyDigestHour,
  NotificationSettingsDefaults
} from '@platform/core/notifications'
import {
  EmailTemplates,
  JobNames,
  QueueNames,
  type SendEmailDigestJob,
  type SendEmailJob
} from '@platform/core/queues'

import { messageParams, pushLocale } from './push-payload'

const HOUR_MS = 3_600_000
// Rows one run reads for one person; what is left waits for the next run
const READ_BATCH = 200

// The column is a string; a value this code does not know reads as the default
function frequencyFrom(value: string | undefined): DigestFrequency {
  return (
    Object.values(DigestFrequency).find(known => known === value) ??
    NotificationSettingsDefaults.digestFrequency
  )
}

export interface ScanReport {
  queued: number
  full: boolean
}

interface DigestItem {
  storeName: string
  title: string
  body: string
  url: string | null
  // How many notifications this block stands for (1 when it is alone)
  count: number
  // The body already says how many they are
  saysCount: boolean
  // Where the link goes, which decides its words
  linkKind: DigestLinkKind
  // When the newest of the block happened, on the clock of the person
  at: string
}

// Notifications that say the same thing about the same place: one block with a count
interface DigestGroup {
  row: DigestRow // The newest of them
  count: number
}

interface DigestRow {
  id: string
  messageKey: string
  params: unknown
  actionPath: string | null
  resourceId?: string | null
  readAt: Date | null
  createdAt: Date
  storeId: string
  store: { name: string }
}

// The email of the notifications (TDD_06 §6.4). `Notification.emailPendingAt` says which rows the
// person asked to get by email; this service sends them and clears the mark. Immediate sends one
// email per notification, hourly and daily batch what is marked, off drops it.
@Injectable()
export class EmailDigestService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QueueNames.NOTIFICATIONS) private readonly digestQueue: Queue<SendEmailDigestJob>,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DIGEST_LINKS) private readonly links: DigestLinks,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(EmailDigestService.name)
  }

  // The scheduler: queues one job for each person whose digest is due now
  async scan(
    frequency: DigestFrequency.HOURLY | DigestFrequency.DAILY,
    now: Date
  ): Promise<ScanReport> {
    await this.dropStale(now)

    const waiting = await this.prisma.client.notification.findMany({
      // Only the people this pass can serve: the others would fill the batch and starve the rest
      where: {
        emailPendingAt: { not: null },
        user: {
          OR: [
            { notificationSettings: { digestFrequency: frequency } },
            ...(frequency === NotificationSettingsDefaults.digestFrequency
              ? [{ notificationSettings: { is: null } }]
              : [])
          ]
        }
      },
      distinct: ['userId'],
      select: { userId: true },
      take: DigestLimits.SCAN_BATCH
    })
    const userIds = waiting.map(row => row.userId)
    if (userIds.length === 0) return { queued: 0, full: false }

    const settings = await this.prisma.client.userNotificationSettings.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, digestFrequency: true, timezone: true }
    })
    const byUser = new Map(settings.map(row => [row.userId, row]))

    const bucket = Math.floor(now.getTime() / HOUR_MS)
    const due = userIds.filter(userId => {
      const own = byUser.get(userId)
      if (frequencyFrom(own?.digestFrequency) !== frequency) return false
      if (frequency === DigestFrequency.HOURLY) return true
      return this.isDailyHour(own?.timezone, now)
    })
    if (due.length > 0) {
      await this.digestQueue.addBulk(
        due.map(userId => ({
          name: JobNames.SEND_EMAIL_DIGEST,
          data: { userId, frequency },
          // One per person and hour: a second run of the same hour queues nothing new
          opts: { jobId: `${JobNames.SEND_EMAIL_DIGEST}-${frequency}-${userId}-${bucket}` }
        }))
      )
    }
    return { queued: due.length, full: waiting.length >= DigestLimits.SCAN_BATCH }
  }

  // A batch for one person. The frequency is read again: they may have changed it since the scan.
  async sendDigest(userId: string, frequency: DigestFrequency, now: Date): Promise<void> {
    if ((await this.frequencyOf(userId)) !== frequency) return
    await this.deliver(userId, {}, now, true)
  }

  // The job each notification queues when it is saved: only immediate and off act on it
  async handleQueued(userId: string, notificationId: string, now: Date): Promise<void> {
    const frequency = await this.frequencyOf(userId)
    if (frequency === DigestFrequency.IMMEDIATE) {
      await this.deliver(userId, { id: notificationId }, now, false)
    } else if (frequency === DigestFrequency.OFF) {
      await this.clear(userId, [notificationId])
    }
  }

  // The zone the person set for their notifications; the default one when none is known
  private async timezoneOf(userId: string): Promise<string> {
    const settings = await this.prisma.client.userNotificationSettings.findUnique({
      where: { userId },
      select: { timezone: true }
    })
    return settings?.timezone ?? NotificationSettingsDefaults.timezone
  }

  private async frequencyOf(userId: string): Promise<DigestFrequency> {
    const settings = await this.prisma.client.userNotificationSettings.findUnique({
      where: { userId },
      select: { digestFrequency: true }
    })
    return frequencyFrom(settings?.digestFrequency)
  }

  // Marks too old to be worth an email are cleared without sending (DigestLimits.MAX_AGE_HOURS)
  private async dropStale(now: Date): Promise<void> {
    await this.prisma.client.notification.updateMany({
      where: { emailPendingAt: { not: null, lt: this.cutoff(now) } },
      data: { emailPendingAt: null }
    })
  }

  // A time zone the runtime does not know is read as the default one: it must not stop the scan of everyone
  private isDailyHour(timezone: string | undefined, now: Date): boolean {
    try {
      return isDailyDigestHour(timezone ?? NotificationSettingsDefaults.timezone, now)
    } catch {
      return isDailyDigestHour(NotificationSettingsDefaults.timezone, now)
    }
  }

  private cutoff(now: Date): Date {
    return new Date(now.getTime() - DigestLimits.MAX_AGE_HOURS * HOUR_MS)
  }

  private async clear(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.prisma.client.notification.updateMany({
      where: { id: { in: ids }, userId, emailPendingAt: { not: null } },
      data: { emailPendingAt: null }
    })
  }

  private async deliver(
    userId: string,
    only: { id?: string },
    now: Date,
    countsAsDigest: boolean
  ): Promise<void> {
    const pending = await this.prisma.client.notification.findMany({
      where: { userId, emailPendingAt: { not: null }, ...only },
      orderBy: { createdAt: 'desc' },
      take: READ_BATCH,
      select: {
        id: true,
        messageKey: true,
        params: true,
        actionPath: true,
        resourceId: true,
        readAt: true,
        createdAt: true,
        storeId: true,
        store: { select: { name: true } }
      }
    })
    if (pending.length === 0) return
    const pendingIds = pending.map(row => row.id)

    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true, locale: true, emailValid: true }
    })
    // Read in the app, too old, or an address that bounces: the mark goes and no email does
    const cutoff = this.cutoff(now)
    // A store the person has left no longer gets its text into their mailbox
    const memberships = await this.prisma.client.membership.findMany({
      where: {
        userId,
        status: MembershipStatus.ACTIVE,
        storeId: { in: pending.map(r => r.storeId) }
      },
      select: { storeId: true }
    })
    const stores = new Set(memberships.map(row => row.storeId))
    const unread = pending.filter(
      row => row.readAt === null && row.createdAt >= cutoff && stores.has(row.storeId)
    )
    if (user === null || !user.emailValid || unread.length === 0) {
      await this.clear(userId, pendingIds)
      return
    }

    const locale = pushLocale(user.locale)
    const timezone = await this.timezoneOf(userId)
    // Ten messages of one customer are one block saying so, not ten identical ones; the limit counts blocks
    const groups = this.groupRows(unread)
    const shown = groups.slice(0, DigestLimits.MAX_ITEMS)
    const { items, firstStoreId } = this.itemsOf(shown, locale, timezone)
    if (items.length > 0) {
      const moreCount = unread.length - shown.reduce((sum, group) => sum + group.count, 0)
      const settingsUrl = new URL(AppPaths.account.notifications, this.links.frontendUrl).toString()
      // The newest store the email speaks of: the button opens its inbox, not the root of the app
      const newestStore = firstStoreId
      await this.emailQueue.add(
        JobNames.SEND_EMAIL,
        {
          template: EmailTemplates.NOTIFICATION_DIGEST,
          to: user.email,
          locale,
          data: {
            items,
            moreCount,
            appUrl: new URL(
              newestStore === undefined ? AppPaths.home : AppPaths.store.inbox(newestStore),
              this.links.frontendUrl
            ).toString(),
            settingsUrl
          },
          // The mailbox's own "unsubscribe" opens the page where the digest is switched off. There is
          // no one-click POST (RFC 8058): that needs a signed token endpoint, written in the plan
          headers: { 'List-Unsubscribe': `<${settingsUrl}>` },
          tags: { template: EmailTemplates.NOTIFICATION_DIGEST }
        },
        // The newest row names the batch: a run repeated after a crash queues the same email once
        { jobId: `${EmailTemplates.NOTIFICATION_DIGEST}-${userId}-${pending[0]?.id ?? ''}` }
      )
    }
    // After the email is queued: a failure between the two repeats the email, never loses it
    await this.clear(userId, pendingIds)
    if (countsAsDigest) {
      await this.prisma.client.userNotificationSettings.upsert({
        where: { userId },
        create: { userId, lastDigestSentAt: now },
        update: { lastDigestSentAt: now }
      })
    }
  }

  // The same store, the same kind of notification, the same place it points to and the same text
  // parameters are one group. Rows come newest first, so the first of a group is its newest and the
  // groups keep the order of their newest row. Two conversations are two groups: each has its own link.
  private groupRows(rows: DigestRow[]): DigestGroup[] {
    const groups = new Map<string, DigestGroup>()
    for (const row of rows) {
      const key = JSON.stringify([
        row.storeId,
        row.messageKey,
        // The place it points to; a notification with no link is told apart by what it is about
        row.actionPath ?? row.resourceId ?? null,
        messageParams(row.params)
      ])
      const group = groups.get(key)
      if (group === undefined) groups.set(key, { row, count: 1 })
      else group.count += 1
    }
    return [...groups.values()]
  }

  // `firstStoreId` is the store of the first row that got a text: the button must not open a store the email omits
  private itemsOf(
    groups: DigestGroup[],
    locale: Locale,
    timezone: string
  ): { items: DigestItem[]; firstStoreId: string | undefined } {
    const items: DigestItem[] = []
    let firstStoreId: string | undefined
    for (const { row, count } of groups) {
      try {
        const t = createTranslator(locale, row.messageKey)
        const params = messageParams(row.params)
        // The text that names the people (or the customer) is used where the notification carries
        // them and the message exists: older rows, and the types without that text, keep the plain one
        const has = (name: string): boolean => hasTranslation(locale, `${row.messageKey}.${name}`)
        const variant = reasonNameOf(params, has) ?? bodyVariantOf(params, count, has)
        items.push({
          storeName: row.store.name,
          title: t('title', params),
          body: t(variant, { ...params, count }),
          url: row.actionPath === null ? null : this.urlOf(row.actionPath),
          count,
          saysCount: variant === 'bodyRepeated',
          linkKind: digestLinkKindOf(row.messageKey),
          at: this.timeOf(row.createdAt, locale, timezone)
        })
        firstStoreId ??= row.storeId
      } catch (error) {
        // A type with no message will not have one when the row is tried again: left out of the email
        this.logger.warn(
          { notificationId: row.id, err: String(error) },
          'a notification has no text for the email'
        )
      }
    }
    return { items, firstStoreId }
  }

  // The date and time of the event on the clock of the person, such as "Nov 2, 08:05"; a zone the
  // runtime does not know is read as the default one, like the daily hour
  private timeOf(at: Date, locale: Locale, timezone: string): string {
    const options: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(at)
    } catch {
      return new Intl.DateTimeFormat(locale, {
        ...options,
        timeZone: NotificationSettingsDefaults.timezone
      }).format(at)
    }
  }

  // Only a path of the app becomes a link: what is stored in the row never sets the host
  private urlOf(path: string): string | null {
    const base = new URL(this.links.frontendUrl)
    const url = new URL(path, base)
    return url.origin === base.origin ? url.toString() : null
  }
}
