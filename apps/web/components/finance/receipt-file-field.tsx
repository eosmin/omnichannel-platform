'use client'

import { Paperclip, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ChangeEvent, type ReactElement, useRef, useState } from 'react'

import { FinanceDocumentUpload, MediaPurpose } from '@platform/core/storage'

import { refuseAttachment, refusalCode } from '../../lib/media/attachment-rules'
import { useCodeText } from '../../lib/use-error-text'
import { Button } from '../ui/button'

const BYTES_PER_MB = 1024 * 1024

// Chooses the file of a receipt (a photo or a PDF) and refuses, before any byte leaves the browser, one that the api would refuse. The
// file is held, not sent: it travels once the transaction exists (`useFinanceReceiptUpload`).
export function ReceiptFileField({
  file,
  onChange,
  busy = false,
  disabled = false
}: {
  file: File | null
  onChange: (file: File | null) => void
  busy?: boolean
  disabled?: boolean
}): ReactElement {
  const t = useTranslations('finance.transactions.receipt')
  const codeText = useCodeText()
  const input = useRef<HTMLInputElement>(null)
  const [refused, setRefused] = useState<string | null>(null)

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.target.files?.[0]
    event.target.value = ''
    if (chosen === undefined) return
    const refusal = refuseAttachment(chosen, MediaPurpose.FINANCE_DOCUMENT)
    if (refusal !== null) {
      setRefused(codeText(refusalCode(refusal)))
      return
    }
    setRefused(null)
    onChange(chosen)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{t('title')}</span>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        disabled={disabled || busy}
        aria-label={t('title')}
        accept={FinanceDocumentUpload.CONTENT_TYPES.join(',')}
        onChange={pick}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          busy={busy}
          onClick={() => input.current?.click()}
        >
          <Paperclip aria-hidden />
          {busy ? t('checking') : t('choose')}
        </Button>
        {file === null ? null : (
          <span className="flex items-center gap-1 text-sm">
            <span className="max-w-48 truncate">{file.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled || busy}
              aria-label={t('remove', { name: file.name })}
              onClick={() => onChange(null)}
            >
              <X aria-hidden />
            </Button>
          </span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        {t('hint', { size: FinanceDocumentUpload.MAX_SIZE_BYTES / BYTES_PER_MB })}
      </p>
      {refused === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {refused}
        </p>
      )}
    </div>
  )
}
