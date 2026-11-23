import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { JobContext, JobContextGoneError, PrismaService } from '@platform/core/database'
import {
  AppPaths,
  DigestFrequency,
  MembershipStatus,
  NotificationChannel
} from '@platform/core/domain'
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
  NotificationDefaults,
  NotificationSettingsDefaults,
  UNSUBSCRIBE_LINKS,
  type UnsubscribeLinkSet,
  type UnsubscribeLinks
} from '@platform/core/notifications'
import {
  EmailTemplates,
  JobNames,
  QueueNames,
  type SendEmailDigestJob,
  type SendEmailJob
} from '@platform/core/queues'

import { readInEachStore } from '../schedulers/store-sweep'

import { messageParams, pushLocale } from './push-payload'

// rls-context: the notifications are read inside JobContext.forStore (the scan and the stale marks) or JobContext.forUser (a person's batch)

const HOUR_MS = 3_600_000
// A mark of an immediate or off person older than this is a leftover: the job of an immediate mark runs within moments, and its retries end well before
const LEFTOVER_MARK_HOURS = 6
// Rows one run reads for one person; what is left waits for the next run
const READ_BATCH = 200

// The column is a string; a value this code does not know reads as the default
function frequencyFrom(value: string | undefined): DigestFrequency {
  return (
    Object.values(DigestFrequency).find(known => known === value) ??
    NotificationSettingsDefaults.digestFrequency
  )
}

type BatchFrequency = DigestFrequency.HOURLY | DigestFrequency.DAILY
const BATCH_FREQUENCIES: ReadonlySet<DigestFrequency> = new Set([
  DigestFrequency.HOURLY,
  DigestFrequency.DAILY
])

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
  type: string
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
    private readonly jobContext: JobContext,
    @InjectQueue(QueueNames.NOTIFICATIONS) private readonly digestQueue: Queue<SendEmailDigestJob>,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(DIGEST_LINKS) private readonly links: DigestLinks,
    @Inject(UNSUBSCRIBE_LINKS) private readonly unsubscribeLinks: UnsubscribeLinks,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(EmailDigestService.name)
  }

  // The scheduler: queues one job for each person whose digest is due now, hourly and daily in ONE pass. The two used to be two scans of the
  // same marks (the same `distinct` read in every store, twice an hour); one read now serves both and the frequency of each person
  // decides which of the two they are in
  async scan(now: Date): Promise<ScanReport> {
    await this.dropStale(now)

    // The notifications are rows of a store: each store is read in its own context, and the people are joined. A store that cannot be read
    // is logged and left to the next run (queueing a digest is additive and each job is idempotent); a pool that is down throws.
    const dueZones = this.dueDailyZones(now)
    let anyStoreFull = false
    const waiting = await readInEachStore(
      this.prisma,
      this.jobContext,
      async storeId => {
        const rows = await this.prisma.client.notification.findMany({
          // Only the people a batch can serve: the others would fill the read and starve the rest
          where: {
            storeId,
            emailPendingAt: { not: null },
            // Only a person who can still read the store: the batch of a person is read in their own context, which does not see the
            // marks of a store they left (they are dropped as stale)
            user: {
              memberships: { some: { storeId, status: MembershipStatus.ACTIVE } },
              OR: [
                { notificationSettings: { digestFrequency: DigestFrequency.HOURLY } },
                // A daily person takes a place in the read only in the hour their own clock reads the digest hour: marks that wait
                // all day would otherwise fill the read every hour and starve the hourly people behind them
                {
                  notificationSettings: {
                    digestFrequency: DigestFrequency.DAILY,
                    timezone: { in: dueZones }
                  }
                },
                ...(NotificationSettingsDefaults.digestFrequency === DigestFrequency.HOURLY
                  ? [{ notificationSettings: { is: null } }]
                  : [])
              ]
            }
          },
          distinct: ['userId'],
          select: { userId: true },
          take: DigestLimits.SCAN_BATCH
        })
        if (rows.length >= DigestLimits.SCAN_BATCH) anyStoreFull = true
        return rows
      },
      (storeId, error) =>
        this.logger.error(
          { storeId, err: String(error) },
          'the notifications of a store could not be read for the digest'
        )
    )
    const everyone = [...new Set(waiting.map(row => row.userId))]
    const userIds = everyone.slice(0, DigestLimits.SCAN_BATCH)
    if (userIds.length === 0) return { queued: 0, full: false }

    const settings = await this.prisma.client.userNotificationSettings.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, digestFrequency: true, timezone: true }
    })
    const byUser = new Map(settings.map(row => [row.userId, row]))

    const bucket = Math.floor(now.getTime() / HOUR_MS)
    const due: { userId: string; frequency: BatchFrequency }[] = []
    for (const userId of userIds) {
      const own = byUser.get(userId)
      const frequency = frequencyFrom(own?.digestFrequency)
      if (frequency === DigestFrequency.HOURLY) due.push({ userId, frequency })
      else if (frequency === DigestFrequency.DAILY && this.isDailyHour(own?.timezone, now)) {
        due.push({ userId, frequency })
      }
    }
    if (due.length > 0) {
      await this.digestQueue.addBulk(
        due.map(({ userId, frequency }) => ({
          name: JobNames.SEND_EMAIL_DIGEST,
          data: { userId, frequency },
          // One per person and hour: a second run of the same hour queues nothing new
          opts: { jobId: `${JobNames.SEND_EMAIL_DIGEST}-${frequency}-${userId}-${bucket}` }
        }))
      )
    }
    return { queued: due.length, full: anyStoreFull || everyone.length > DigestLimits.SCAN_BATCH }
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
    const cutoff = this.cutoff(now)
    // Per store, in its own context. A store that fails is logged and left to the next run: a stale mark that stays one more hour only
    // delays its removal (the delivery drops it anyway when it is older than the limit)
    await readInEachStore(
      this.prisma,
      this.jobContext,
      async storeId => {
        await this.prisma.client.notification.updateMany({
          where: { storeId, emailPendingAt: { not: null, lt: cutoff } },
          data: { emailPendingAt: null }
        })
        // The marks of a person who is now on immediate or off: no batch reads them any more, and the request that changed the choice only
        // cleared those of its own store. An immediate mark is read by its own job within moments, so only one older than
        // `LEFTOVER_MARK_HOURS` (6 h) is taken as left over
        await this.prisma.client.notification.updateMany({
          where: {
            storeId,
            emailPendingAt: {
              not: null,
              lt: new Date(now.getTime() - LEFTOVER_MARK_HOURS * HOUR_MS)
            },
            user: {
              OR: [
                {
                  notificationSettings: {
                    digestFrequency: { in: [DigestFrequency.IMMEDIATE, DigestFrequency.OFF] }
                  }
                },
                // A person with no row has the default frequency, which a batch does not serve if it is one of these two
                ...(BATCH_FREQUENCIES.has(NotificationSettingsDefaults.digestFrequency)
                  ? []
                  : [{ notificationSettings: { is: null } }])
              ]
            }
          },
          data: { emailPendingAt: null }
        })
        return []
      },
      (storeId, error) =>
        this.logger.error(
          { storeId, err: String(error) },
          'the stale marks of a store could not be cleared'
        )
    )
  }

  // The time zones whose clock reads the daily digest hour right now. A zone that is stored is a canonical IANA name (the preferences
  // route checks it), so the list of the runtime covers it; the default zone and UTC are added because the list may leave them out
  private dueDailyZones(now: Date): string[] {
    const known = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])
    known.add(NotificationSettingsDefaults.timezone)
    return [...known].filter(zone => this.isDailyHour(zone, now))
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

  private async unlessUserGone<T>(work: Promise<T>): Promise<T | null> {
    try {
      return await work
    } catch (error) {
      if (error instanceof JobContextGoneError) return null
      throw error
    }
  }

  private async clear(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    // A person deleted while the job waited has no marks left to clear
    await this.unlessUserGone(
      this.jobContext.forUser(userId, () =>
        this.prisma.client.notification.updateMany({
          where: { id: { in: ids }, userId, emailPendingAt: { not: null } },
          data: { emailPendingAt: null }
        })
      )
    )
  }

  private async deliver(
    userId: string,
    only: { id?: string },
    now: Date,
    countsAsDigest: boolean
  ): Promise<void> {
    // The notifications of the person, across the stores they belong to: one context of theirs for the read, and none while the email is built
    const pending = await this.unlessUserGone(
      this.jobContext.forUser(userId, () =>
        this.prisma.client.notification.findMany({
          where: { userId, emailPendingAt: { not: null }, ...only },
          orderBy: { createdAt: 'desc' },
          take: READ_BATCH,
          select: {
            id: true,
            type: true,
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
      )
    )
    if (pending === null || pending.length === 0) return
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
    // The choice of the person for each type, read now and not when the mark was made: they may have turned the email of that type off
    // since. A type with no row of theirs has the factory choice
    const choices = await this.emailChoicesOf(userId, [...stores])
    const unread = pending.filter(
      row =>
        row.readAt === null &&
        row.createdAt >= cutoff &&
        stores.has(row.storeId) &&
        this.emailStillWanted(row, choices)
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
      // Signed for this person: the page the footer opens, and the POST url the mail client of the header calls (RFC 8058)
      // A link that cannot be signed (an id of a shape the token refuses) must not hold back the person's whole digest: it goes without the link
      const unsubscribe = this.unsubscribeOf(userId)
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
            settingsUrl,
            ...(unsubscribe === null ? {} : { unsubscribeUrl: unsubscribe.pageUrl })
          },
          // One click (RFC 8058): the mailbox POSTs `List-Unsubscribe=One-Click` to the signed url, which switches the person's notification
          // email off and nothing else. The url carries the token, so it is only here and in the footer; the job holds it as it holds the address
          ...(unsubscribe === null
            ? {}
            : {
                headers: {
                  'List-Unsubscribe': `<${unsubscribe.postUrl}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
                }
              }),
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

  private unsubscribeOf(userId: string): UnsubscribeLinkSet | null {
    try {
      return this.unsubscribeLinks.forUser(userId)
    } catch {
      // Never the error text or the id's value beyond what a log already holds; the digest itself is not lost
      this.logger.warn('the unsubscribe link of a digest could not be signed; it goes without it')
      return null
    }
  }

  // `email` of the rows of the person, by store and type
  private async emailChoicesOf(userId: string, storeIds: string[]): Promise<Map<string, boolean>> {
    if (storeIds.length === 0) return new Map()
    const rows =
      (await this.unlessUserGone(
        this.jobContext.forUser(userId, () =>
          this.prisma.client.notificationPreference.findMany({
            where: { userId, storeId: { in: storeIds } },
            select: { storeId: true, type: true, email: true }
          })
        )
      )) ?? []
    return new Map(rows.map(row => [`${row.storeId}:${row.type}`, row.email]))
  }

  private emailStillWanted(row: DigestRow, choices: ReadonlyMap<string, boolean>): boolean {
    const chosen = choices.get(`${row.storeId}:${row.type}`)
    if (chosen !== undefined) return chosen
    const known = (
      NotificationDefaults as Record<
        string,
        { channels: readonly NotificationChannel[] } | undefined
      >
    )[row.type]
    // A type this code does not know has no factory choice and no text: it is not mailed
    return known?.channels.includes(NotificationChannel.EMAIL) ?? false
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
