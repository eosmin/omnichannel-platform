'use client'

import type { ReactElement } from 'react'

import { useErrorText } from '../../lib/use-error-text'

// The reason a change was refused, from the code the api sent (messages `errors.<code>`)
export function MutationError({ error }: { error: Error | null }): ReactElement | null {
  const errorText = useErrorText()
  if (error === null) return null
  return (
    <p role="alert" className="text-destructive text-sm">
      {errorText(error)}
    </p>
  )
}
