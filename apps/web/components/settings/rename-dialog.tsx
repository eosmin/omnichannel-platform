'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { ChannelConnectionLimits } from '@platform/core/domain'

import type { ChannelConnectionView } from '../../lib/settings/channels-requests'
import { useRenameConnection } from '../../lib/settings/use-channels'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The name the owner gives to one connection ("Instagram principal"). Empty goes back to the name of the
// account at the provider, which the hint says. The api checks and cleans the text; nothing else of the
// connection can be written from here.
export function RenameDialog({
  connection,
  onClose
}: {
  connection: ChannelConnectionView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.rename')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const rename = useRenameConnection(storeId, connection.id)
  const [value, setValue] = useState(connection.label ?? '')
  // The title keeps the name the dialog was opened with: the list is read again when the name is saved,
  // and the dialog must not rename itself while it closes
  const [openedAs] = useState(connection.displayName)
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const input = useRef<HTMLInputElement>(null)
  // Back to the field when the api refuses the name, which was disabled while the request ran
  useEffect(() => {
    if (rename.error !== null) input.current?.focus()
  }, [rename.error])
  const label = value.trim()
  const unchanged = label === (connection.label ?? '')

  const guard = useSubmitGuard()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (unchanged || rename.isPending || !guard.enter()) return
    rename.mutate(label === '' ? null : label, {
      onSuccess: renamed => {
        toast.success(t('done', { name: renamed.displayName }))
        onClose()
      },
      onSettled: guard.leave
    })
  }

  // The request is not abandoned half way: its answer (the toast, the error) needs this dialog open
  return (
    <Dialog open onOpenChange={open => (open || rename.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name: openedAs })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={id}>{t('label')}</Label>
            <Input
              id={id}
              ref={input}
              aria-invalid={rename.error === null ? undefined : true}
              value={value}
              onChange={event => setValue(event.target.value)}
              maxLength={ChannelConnectionLimits.LABEL_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              disabled={rename.isPending}
              aria-describedby={rename.error === null ? hintId : `${hintId} ${errorId}`}
              autoFocus
            />
            <p id={hintId} className="text-muted-foreground text-xs break-words">
              {t('hint', { name: connection.accountName })}
            </p>
          </div>
          <div id={errorId}>
            <MutationError error={rename.error} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={rename.isPending}>
              {tAll('common.cancel')}
            </Button>
            <Button type="submit" disabled={unchanged || rename.isPending}>
              {rename.isPending ? t('submitting') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
