'use client'

import { Trash2, Upload } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ChangeEvent, type ReactElement, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { ApiError } from '@platform/api-client'
import { ClientErrorCodes } from '@platform/core/errors'
import { AvatarUpload, MediaPurpose } from '@platform/core/storage'

import { MutationError } from '../../components/customers/mutation-error'
import { Button } from '../../components/ui/button'
import { refuseAttachment, refusalCode } from '../../lib/media/attachment-rules'
import { useRemoveAvatar, useUploadAvatar } from '../../lib/settings/use-avatar'

const ACCEPT = AvatarUpload.CONTENT_TYPES.join(',')
const MEGABYTE = 1024 * 1024

// The first letters of the name, for a person with no picture
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(word => word.length > 0)
    .slice(0, 2)
    .map(word => Array.from(word)[0]?.toUpperCase() ?? '')
    .join('')
}

interface AvatarPickerProps {
  name: string
  avatarMediaId: string | null
  avatarUrl: string | null
}

// Account → Profile: choose, see and remove the picture. A Viewer can too: it belongs to the person
// and uses routes with no store. The file is checked here before a byte leaves (the api checks again),
// then scanned and re-encoded on the server, which takes a moment: the picture appears when it is ready.
export function AvatarPicker({ name, avatarMediaId, avatarUrl }: AvatarPickerProps): ReactElement {
  const t = useTranslations('account.profile.avatar')
  const tError = useTranslations('errors')
  const upload = useUploadAvatar()
  const remove = useRemoveAvatar()
  const input = useRef<HTMLInputElement>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  // True from a successful upload until the picture shows or the scan refuses it
  const [expecting, setExpecting] = useState(false)
  // Once the picture shows, a later null pointer is not a refusal of this upload
  useEffect(() => {
    if (avatarUrl !== null) setExpecting(false)
  }, [avatarUrl])
  const processing = avatarMediaId !== null && avatarUrl === null
  const refused = expecting && avatarMediaId === null && !upload.isPending
  // The api bounds the pictures one person holds at once: waiting is the answer, not retrying
  const isTooMany =
    upload.error instanceof ApiError && upload.error.code === ClientErrorCodes.RATE_LIMIT_EXCEEDED

  const choose = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    // So that choosing the same file again fires a change
    event.target.value = ''
    if (file === undefined) return
    const problem = refuseAttachment({ type: file.type, size: file.size }, MediaPurpose.AVATAR)
    if (problem !== null) {
      setRefusal(tError(refusalCode(problem)))
      return
    }
    setRefusal(null)
    upload.mutate(file, {
      onSuccess: () => {
        setExpecting(true)
        toast.success(t('uploaded'))
      }
    })
  }

  const take = (): void => {
    setRefusal(null)
    setExpecting(false)
    remove.mutate(undefined, { onSuccess: () => toast.success(t('removed')) })
  }

  const busy = upload.isPending || remove.isPending

  return (
    <div className="flex items-center gap-4">
      <div
        className="bg-muted text-muted-foreground flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full text-xl font-semibold"
        data-testid="avatar-preview"
      >
        {avatarUrl === null ? (
          <span aria-hidden="true">{initialsOf(name)}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed link on the bucket: next/image cannot optimise it
          <img src={avatarUrl} alt={t('alt')} className="size-full object-cover" />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-label={t('choose')}
            data-testid="avatar-input"
            onChange={choose}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Upload aria-hidden="true" />
            {upload.isPending ? t('uploading') : avatarMediaId === null ? t('choose') : t('change')}
          </Button>
          {avatarMediaId === null ? null : (
            <Button type="button" variant="ghost" disabled={busy} onClick={take}>
              <Trash2 aria-hidden="true" />
              {t('remove')}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">
          {t('hint', { size: AvatarUpload.MAX_SIZE_BYTES / MEGABYTE })}
        </p>
        {processing ? (
          <p role="status" className="text-muted-foreground text-sm">
            {t('processing')}
          </p>
        ) : null}
        {refused ? (
          <p role="alert" className="text-destructive text-sm">
            {t('refused')}
          </p>
        ) : null}
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        {isTooMany ? (
          <p role="alert" className="text-destructive text-sm">
            {t('tooMany')}
          </p>
        ) : (
          <MutationError error={upload.error} />
        )}
        <MutationError error={remove.error} />
      </div>
    </div>
  )
}
