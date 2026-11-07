'use client'

import { Check, Copy } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { toast } from '../../lib/toast'
import { Button } from '../ui/button'

const COPIED_MS = 2000

// Puts a text on the clipboard. `label` names what is copied, for the screen reader.
export function CopyButton({ text, label }: { text: string; label: string }): ReactElement {
  const t = useTranslations('settings.channels')
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      // The clipboard is refused on a page without permission: the text is still on screen to select
      toast.error(t('copyFailed'))
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? t('copied') : t('copy')}
      <span className="sr-only">{label}</span>
      <span role="status" className="sr-only">
        {copied ? t('copied') : ''}
      </span>
    </Button>
  )
}
