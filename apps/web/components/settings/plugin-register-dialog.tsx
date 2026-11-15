'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { firstIssueOf } from '../../lib/error-message'
import { useSubmitGuard } from '../../lib/submit-guard'
import { useRegisterPlugin } from '../../lib/settings/use-plugins'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
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
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

// The owner pastes the manifest of a plugin their organization runs (D10). Only the shape is read here, to say at once that it is not
// JSON; the api validates everything else and says which field it refuses. Nothing is trusted from the text: it is sent as it is.
export function PluginRegisterDialog({ onClose }: { onClose: () => void }): ReactElement {
  const t = useTranslations('settings.plugins.register')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const register = useRegisterPlugin(storeId)
  const guard = useSubmitGuard()
  const fieldId = useId()
  const [text, setText] = useState('')
  const [notJson, setNotJson] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (text.trim() === '' || !guard.enter()) return
    let manifest: unknown
    try {
      manifest = JSON.parse(text)
    } catch {
      setNotJson(true)
      guard.leave()
      return
    }
    setNotJson(false)
    register.mutate(manifest, {
      onSuccess: result => {
        toast.success(t(`done.${result.outcome}` as Parameters<typeof t>[0], { name: result.name }))
        onClose()
      },
      onSettled: guard.leave
    })
  }

  const issue = firstIssueOf(register.error)
  const errorId = `${fieldId}-error`
  return (
    <Dialog open onOpenChange={open => (open || register.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={fieldId}>{t('manifest')}</Label>
            <Textarea
              id={fieldId}
              value={text}
              rows={10}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              aria-invalid={notJson || register.isError}
              aria-describedby={notJson || register.isError ? errorId : undefined}
              placeholder={t('placeholder')}
              onChange={event => setText(event.target.value)}
            />
          </div>
          {notJson || register.isError ? (
            <p id={errorId} role="alert" className="text-destructive text-sm break-words">
              {notJson ? t('notJson') : errorText(register.error)}
              {issue === null ? null : ` ${t('checkField', { field: issue.field })}`}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={register.isPending} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={text.trim() === '' || register.isPending}
              busy={register.isPending}
            >
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
