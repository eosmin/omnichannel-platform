'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useState } from 'react'

import { charCounterOf } from '../../lib/char-counter'
import { cn } from '../../lib/utils'

// What is left of a field with a limit, from 80% of it, for any field that has one. Seen by everyone; a
// screen reader hears it when the step changes (80, 90, 95 and 100%) and not at every key: the live region
// stays in the page and its text changes only then.
export function CharCounter({
  length,
  max,
  className
}: {
  length: number
  max: number
  className?: string
}): ReactElement {
  const t = useTranslations('common')
  const counter = charCounterOf(length, max)
  const step = counter?.step ?? 0
  const [announced, setAnnounced] = useState('')
  useEffect(() => {
    if (counter === null) setAnnounced('')
    else
      setAnnounced(
        counter.atLimit ? t('charLimitReached') : t('charsLeft', { count: counter.left })
      )
    // Only a new step is announced: `left` changes at every key and is read at that moment
  }, [step])
  return (
    <div className={cn('flex justify-end', className)}>
      {counter === null ? null : (
        <span
          aria-hidden
          className={cn(
            'text-xs tabular-nums',
            counter.atLimit ? 'text-destructive' : 'text-muted-foreground'
          )}
        >
          {t('charsLeft', { count: counter.left })}
        </span>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </div>
  )
}
