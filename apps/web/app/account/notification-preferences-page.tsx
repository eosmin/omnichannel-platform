'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useMemo } from 'react'
import { toast } from 'sonner'

import type { NotificationSettingsView, TypePreferenceView } from '@platform/api-client'
import { DigestFrequency } from '@platform/core/domain'

import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { readLastStoreId } from '../../lib/last-store'
import {
  groupPreferences,
  hourLabel,
  PREFERENCE_CHANNEL_ORDER,
  type PreferenceChannel,
  timeZoneOptions
} from '../../lib/notifications/preferences-matrix'
import { usePreferences, useSavePreferences } from '../../lib/notifications/use-notification-data'
import { PushSubscribeResult } from '../../lib/push/push-browser'
import { PushSwitchState, usePushSwitch } from '../../lib/push/use-push-switch'
import { useErrorText } from '../../lib/use-error-text'
import { useProfile } from '../../lib/use-profile'

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const DIGEST_OPTIONS = [
  DigestFrequency.IMMEDIATE,
  DigestFrequency.HOURLY,
  DigestFrequency.DAILY,
  DigestFrequency.OFF
] as const

function supportedTimeZones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return []
  }
}

// Settings → My account → Notifications (TDD_06 §9): the matrix of types and channels of one store,
// the push switch of this browser, quiet hours, the email digest and the cross-store switches.
export function NotificationPreferencesPage(): ReactElement | null {
  const t = useTranslations('account.notifications')
  const { data: profile } = useProfile()
  // The account area has no store of its own: the matrix is the one of the store last opened
  const lastStoreId = readLastStoreId()
  if (profile === undefined) return null
  const membership =
    profile.memberships.find(entry => entry.storeId === lastStoreId) ?? profile.memberships[0]
  if (membership === undefined) {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground mt-2 text-sm">{t('noStore')}</p>
      </section>
    )
  }
  return <Preferences storeId={membership.storeId} storeName={membership.storeName} />
}

function Preferences({ storeId, storeName }: { storeId: string; storeName: string }): ReactElement {
  const t = useTranslations('account.notifications')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const prefs = usePreferences(storeId)
  const save = useSavePreferences(storeId, () => toast.error(t('saveFailed')))
  // The type comes from the server: `has` checks it has a label first, and a type this page does not
  // know yet shows as its own name instead of breaking the page
  type MessageKey = Parameters<typeof tAll>[0]
  const typeLabel = (type: string): string => {
    const key = `account.notifications.types.${type}` as MessageKey
    return tAll.has(key) ? tAll(key) : type
  }
  const groups = useMemo(() => groupPreferences(prefs.data?.types ?? []), [prefs.data])
  const settings = prefs.data?.settings

  if (prefs.isError) {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p role="alert" className="text-destructive mt-2 text-sm">
          {errorText(prefs.error)}
        </p>
      </section>
    )
  }
  if (settings === undefined) return <p className="text-muted-foreground text-sm">{t('loading')}</p>

  function setType(row: TypePreferenceView, channel: PreferenceChannel, value: boolean): void {
    save.mutate({
      types: [
        {
          type: row.type,
          inApp: row.inApp,
          push: row.push,
          email: row.email,
          sound: row.sound,
          [channel]: value
        }
      ]
    })
  }
  const setSettings = (patch: Partial<NotificationSettingsView>): void =>
    save.mutate({ settings: patch })

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('forStore', { store: storeName })}</p>
      </header>

      <PushDeviceSwitch storeId={storeId} />

      <div className="flex flex-col gap-6">
        {groups.map(({ group, rows }) => (
          <table key={group} className="w-full text-sm">
            <caption className="text-muted-foreground pb-2 text-left text-xs font-semibold uppercase">
              {t(`groups.${group}`)}
            </caption>
            <thead>
              <tr className="text-muted-foreground text-left">
                <th scope="col" className="py-1 pr-3 font-medium">
                  <span className="sr-only">{t('type')}</span>
                </th>
                {PREFERENCE_CHANNEL_ORDER.map(channel => (
                  <th key={channel} scope="col" className="w-16 py-1 text-center font-medium">
                    {t(`channels.${channel}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.type} className="border-t">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {typeLabel(row.type)}
                  </th>
                  {PREFERENCE_CHANNEL_ORDER.map(channel => (
                    <td key={channel} className="text-center">
                      <input
                        type="checkbox"
                        className="size-4 align-middle"
                        checked={row[channel]}
                        // In-app is how the notification exists at all: it cannot be turned off, but a
                        // stored off can be turned back on
                        disabled={channel === 'inApp' && row.inApp}
                        aria-label={t('cell', {
                          type: typeLabel(row.type),
                          channel: t(`channels.${channel}`)
                        })}
                        onChange={event => setType(row, channel, event.target.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>

      <QuietHours settings={settings} onChange={setSettings} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-base font-semibold">{t('digest.title')}</legend>
        <p className="text-muted-foreground text-sm">{t('digest.hint')}</p>
        <div className="flex flex-wrap gap-4">
          {DIGEST_OPTIONS.map(option => (
            <label key={option} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="digest"
                checked={settings.digestFrequency === option}
                onChange={() => setSettings({ digestFrequency: option })}
              />
              {t(`digest.options.${option}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-base font-semibold">{t('crossStore.title')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.crossStoreEnabled}
            onChange={event => setSettings({ crossStoreEnabled: event.target.checked })}
          />
          {t('crossStore.enabled')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.crossStoreSupervisorOnly}
            disabled={!settings.crossStoreEnabled}
            onChange={event => setSettings({ crossStoreSupervisorOnly: event.target.checked })}
          />
          {t('crossStore.supervisorOnly')}
        </label>
      </fieldset>
    </section>
  )
}

function QuietHours({
  settings,
  onChange
}: {
  settings: NotificationSettingsView
  onChange: (patch: Partial<NotificationSettingsView>) => void
}): ReactElement {
  const t = useTranslations('account.notifications.quietHours')
  const id = useId()
  const zones = useMemo(
    () => timeZoneOptions(settings.timezone, supportedTimeZones()),
    [settings.timezone]
  )
  // With "follow the store" the fixed range is not used, so its fields wait
  const isRangeOff = !settings.quietHoursEnabled || settings.quietHoursFollowStore
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-base font-semibold">{t('title')}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.quietHoursEnabled}
          onChange={event => onChange({ quietHoursEnabled: event.target.checked })}
        />
        {t('enabled')}
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-start`}>{t('from')}</Label>
          <select
            id={`${id}-start`}
            className={SELECT_CLASS}
            disabled={isRangeOff}
            value={settings.quietHoursStart}
            onChange={event => onChange({ quietHoursStart: Number(event.target.value) })}
          >
            {HOURS.map(hour => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-end`}>{t('to')}</Label>
          <select
            id={`${id}-end`}
            className={SELECT_CLASS}
            disabled={isRangeOff}
            value={settings.quietHoursEnd}
            onChange={event => onChange({ quietHoursEnd: Number(event.target.value) })}
          >
            {HOURS.map(hour => (
              <option key={hour} value={hour}>
                {hourLabel(hour)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex min-w-48 flex-col gap-1">
          <Label htmlFor={`${id}-zone`}>{t('timezone')}</Label>
          <select
            id={`${id}-zone`}
            className={SELECT_CLASS}
            disabled={isRangeOff}
            value={settings.timezone}
            onChange={event => onChange({ timezone: event.target.value })}
          >
            {zones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.quietHoursFollowStore}
          disabled={!settings.quietHoursEnabled}
          onChange={event => onChange({ quietHoursFollowStore: event.target.checked })}
        />
        {t('followStore')}
      </label>
      <p className="text-muted-foreground text-xs">{t('hint')}</p>
    </fieldset>
  )
}

// Push on this browser (TDD_06 §7.3). Whether a type sends push is the matrix above; this says whether
// this device receives any.
function PushDeviceSwitch({ storeId }: { storeId: string }): ReactElement {
  const t = useTranslations('account.notifications.push')
  const errorText = useErrorText()
  const { state, isBusy, turnOn, turnOff } = usePushSwitch(storeId)

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      const result = await action()
      if (result === PushSubscribeResult.DENIED) toast.error(t('blocked'))
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border p-4" aria-labelledby="push-title">
      <h2 id="push-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      {state === PushSwitchState.NOT_CONFIGURED && (
        <p className="text-muted-foreground text-sm">{t('notConfigured')}</p>
      )}
      {state === PushSwitchState.UNSUPPORTED && (
        <p className="text-muted-foreground text-sm">{t('unsupported')}</p>
      )}
      {state === PushSwitchState.BLOCKED && (
        <p role="status" className="text-sm">
          {t('blocked')}
        </p>
      )}
      {(state === PushSwitchState.OFF || state === PushSwitchState.ON) && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state === PushSwitchState.ON}
            disabled={isBusy}
            onChange={event => void run(event.target.checked ? turnOn : turnOff)}
          />
          {t('label')}
        </label>
      )}
      <p className="text-muted-foreground text-xs">{t('hint')}</p>
    </section>
  )
}
