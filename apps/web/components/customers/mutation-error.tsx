'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { errorCodeOf } from '../../lib/error-message'

// The reason a change was refused, from the code the api sent (messages `errors.<code>`)
export function MutationError({ error }: { error: Error | null }): ReactElement | null {
  const t = useTranslations('errors')
  if (error === null) return null
  return (
    <p role="alert" className="text-destructive text-sm">
      {t(errorCodeOf(error))}
    </p>
  )
}
