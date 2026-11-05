'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { connectFailureReasonOf } from '../../lib/settings/connect-failure'
import { MutationError } from '../customers/mutation-error'

// Why a channel did not connect: what happened and what to do, from the reason the api names (messages
// `settings.channels.connectFailure.<reason>`); when it names none, or one this page does not know, the
// generic message of the code shows. `role="alert"` announces it when it appears.
export function ConnectError({
  error,
  id
}: {
  error: Error | null
  // The id the token field points to with `aria-describedby`, so the reason is read with the field
  id?: string
}): ReactElement | null {
  const t = useTranslations('settings.channels.connectFailure')
  const reason = connectFailureReasonOf(error)
  if (error === null) return null
  if (reason === null) return <MutationError error={error} />
  return (
    <p id={id} role="alert" className="text-destructive text-sm">
      {t(reason)}
    </p>
  )
}
