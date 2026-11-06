'use client'

import { LogIn } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useId, useState } from 'react'

import { isFacebookDialogUrl } from '../../lib/settings/oauth-return'
import { useStartFacebookLogin } from '../../lib/settings/use-channels'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { ConnectError } from './connect-error'

// How long the button waits for the window to leave before it lets the person try again
const LEAVE_WAIT_MS = 10_000

// "Connect with Facebook" (Step 7.8): asks the api to start the login and takes the whole window to the dialog of
// Facebook (a popup is blocked on a phone and loses the page). It goes only to the address that the api gave if
// that is exactly the dialog of Facebook, over https. One click makes one login (the guard), and the button
// stays "opening" once the window is leaving, because the page is about to be gone.
export function FacebookLoginButton({
  pluginId,
  variant = 'default',
  size = 'default',
  idleLabel,
  accessibleSuffix,
  className
}: {
  pluginId: string
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm'
  idleLabel: string
  // What tells this button from the others of its row for a screen reader (the name of the connection)
  accessibleSuffix?: string
  className?: string
}): ReactElement {
  const t = useTranslations('settings.channels.oauth')
  const { storeId } = useStore()
  const start = useStartFacebookLogin(storeId, pluginId)
  const guard = useSubmitGuard()
  const errorId = useId()
  const [leaving, setLeaving] = useState(false)
  const [refused, setRefused] = useState(false)

  // Back from Facebook the browser may bring this very page back as it was left (the back-forward cache), with
  // the button still "opening": it is made ready again, or there would be no way to try once more
  useEffect(() => {
    const restored = (event: PageTransitionEvent): void => {
      if (!event.persisted) return
      setLeaving(false)
      guard.leave()
    }
    window.addEventListener('pageshow', restored)
    return () => window.removeEventListener('pageshow', restored)
  }, [guard])

  const click = (): void => {
    if (!guard.enter()) return
    setRefused(false)
    start.mutate(undefined, {
      onSuccess: ({ authorizeUrl }) => {
        if (!isFacebookDialogUrl(authorizeUrl)) {
          setRefused(true)
          guard.leave()
          return
        }
        setLeaving(true)
        // If the window is still here after a while (the person stopped the navigation), the button is ready
        // again; when it does leave, this timer goes with the page
        setTimeout(() => {
          setLeaving(false)
          guard.leave()
        }, LEAVE_WAIT_MS)
        window.location.assign(authorizeUrl)
      },
      onError: guard.leave
    })
  }

  const busy = start.isPending || leaving
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        aria-busy={busy}
        aria-describedby={start.isError || refused ? errorId : undefined}
        disabled={busy}
        onClick={click}
      >
        <LogIn aria-hidden />
        {busy ? t('opening') : idleLabel}
        {accessibleSuffix === undefined ? null : (
          <span className="sr-only"> {accessibleSuffix}</span>
        )}
      </Button>
      {refused ? (
        <p id={errorId} role="alert" className="text-destructive text-sm">
          {t('badAddress')}
        </p>
      ) : (
        <ConnectError error={start.error} id={errorId} />
      )}
    </div>
  )
}
