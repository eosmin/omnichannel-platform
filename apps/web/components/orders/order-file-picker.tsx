'use client'

import { Paperclip, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ChangeEvent, type ReactElement, useRef, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { MediaPurpose, OrderFileUpload } from '@platform/core/storage'

import { refuseAttachment, refusalCode } from '../../lib/media/attachment-rules'
import { type UploadedOrderFile, useOrderFileUpload } from '../../lib/orders/use-order'
import { useCodeText, useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

const BYTES_PER_MB = 1024 * 1024

// A file for an order (the receipt of a payment, the proof of a delivery): the one flow of every upload, then a wait for the
// scan, since the api only takes a file that is clean. `value` is the file once it is clean and ready to be sent with the form;
// one that is still being checked is not handed up, so a form cannot send what the api would refuse.
export function OrderFilePicker({
  orderId,
  label,
  value,
  onChange,
  onBusyChange
}: {
  orderId: string
  label: string
  value: UploadedOrderFile | null
  onChange: (file: UploadedOrderFile | null) => void
  // True while the file uploads and is scanned: the form must not be sent then, it would go without the file
  onBusyChange?: (busy: boolean) => void
}): ReactElement | null {
  const t = useTranslations('orders.detail.file')
  const { storeId, can } = useStore()
  const codeText = useCodeText()
  const errorText = useErrorText()
  const upload = useOrderFileUpload(storeId, orderId)
  const input = useRef<HTMLInputElement>(null)
  const [refused, setRefused] = useState<string | null>(null)

  // The api asks for the permission to upload; without it there is nothing to offer and the form works without the file
  if (!can(ClientPermissions.MEDIA_UPLOAD)) return null

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    upload.reset()
    const refusal = refuseAttachment(file, MediaPurpose.ORDER)
    if (refusal !== null) {
      setRefused(codeText(refusalCode(refusal)))
      return
    }
    setRefused(null)
    onChange(null)
    onBusyChange?.(true)
    upload.mutate(file, {
      onSuccess: onChange,
      onSettled: () => onBusyChange?.(false)
    })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        disabled={upload.isPending}
        aria-label={label}
        accept={OrderFileUpload.CONTENT_TYPES.join(',')}
        onChange={pick}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={upload.isPending}
          busy={upload.isPending}
          onClick={() => input.current?.click()}
        >
          <Paperclip aria-hidden />
          {upload.isPending ? t('checking') : value === null ? t('choose') : t('replace')}
        </Button>
        {value !== null ? (
          <span className="flex items-center gap-1 text-sm">
            <span className="max-w-56 truncate">{value.filename}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('remove', { name: value.filename })}
              onClick={() => onChange(null)}
            >
              <X aria-hidden />
            </Button>
          </span>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        {t('hint', { size: OrderFileUpload.MAX_SIZE_BYTES / BYTES_PER_MB })}
      </p>
      {refused !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {refused}
        </p>
      ) : null}
      {upload.error !== null ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(upload.error)}
        </p>
      ) : null}
    </div>
  )
}
