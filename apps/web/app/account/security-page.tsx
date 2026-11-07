'use client'

import { LogOut, Monitor } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { ActiveSession } from '@platform/api-client'

import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { deviceLabel, rawDeviceText } from '../../lib/account/device-label'
import { relativeTime } from '../../lib/inbox/relative-time'
import { useActiveSessions, useRevokeSession } from '../../lib/settings/use-settings-data'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Account → Security: where the person is signed in, with a way to close each of the other devices.
// The device in use has no button: leaving it is "Sign out" in the account menu.
export function SecurityPage(): ReactElement {
  const t = useTranslations('account.security')
  const sessions = useActiveSessions()
  return (
    <section className="flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {sessions.isError ? (
        <LoadFailed error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : sessions.data === undefined ? (
        <PageLoading />
      ) : sessions.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {sessions.data.map(session => (
            <SessionRow key={session.id} session={session} />
          ))}
        </ul>
      )}
    </section>
  )
}

function SessionRow({ session }: { session: ActiveSession }): ReactElement {
  const t = useTranslations('account.security')
  const errorText = useErrorText()
  const locale = useLocale()
  const revoke = useRevokeSession()
  const label = deviceLabel(session.userAgent)
  const title =
    label === null
      ? (rawDeviceText(session.userAgent) ?? t('unknownDevice'))
      : `${label.browser} · ${label.system}`
  const lastActive = relativeTime(new Date(session.lastActiveAt), new Date(), locale)

  const close = (): void => {
    revoke.mutate(session.id, {
      onSuccess: () => toast.success(t('revoked')),
      onError: error => toast.error(errorText(error))
    })
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Monitor aria-hidden className="text-muted-foreground mt-0.5 size-5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">
            {title}
            {session.current ? (
              <span className="bg-accent ml-2 rounded-md px-1.5 py-0.5 text-xs font-normal">
                {t('thisDevice')}
              </span>
            ) : null}
          </span>
          <span className="text-muted-foreground text-sm">
            {session.ipAddress ?? t('unknownAddress')} · {t('lastActive', { when: lastActive })}
          </span>
        </div>
      </div>
      {session.current ? null : (
        <Button
          variant="outline"
          size="sm"
          disabled={revoke.isPending}
          aria-label={`${t('revoke')} ${title}`}
          onClick={close}
        >
          <LogOut aria-hidden />
          {t('revoke')}
        </Button>
      )}
    </li>
  )
}
