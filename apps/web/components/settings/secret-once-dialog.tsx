'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

import { CopyButton } from './copy-button'

// A credential the api made and will never say again (the secret of a webhook, an API key): shown here once. It lives only in
// the props of this dialog, which the page takes from the state of the call that made it; closing the dialog drops it. Only
// the button closes it, not a stray click, Escape or the Back of the browser (the Dialog closes on Back through
// `onOpenChange`, which is ignored here), because after that the person can only make a new one. A second Back leaves the
// page like any other navigation; leaving through the browser's tab or the settings links is asked first.
export function SecretOnceDialog({
  title,
  description,
  label,
  secret,
  testId,
  children,
  onClose
}: {
  title: string
  description: string
  // What the secret is called, for the field and for the screen reader of the copy button
  label: string
  secret: string
  testId: string
  // What goes under the secret: how to use it
  children?: ReactNode
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.secretOnce')
  const tCommon = useTranslations('common')
  // The secret is gone with the page: the browser asks before the tab is closed, and the settings navigation before it leaves
  useUnsavedChanges(true)
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{t('once')}</span>
        </p>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">{label}</span>
          <div className="flex items-center gap-2">
            <code
              data-testid={testId}
              className="bg-muted min-w-0 flex-1 rounded-md px-2 py-1.5 font-mono text-sm break-all"
            >
              {secret}
            </code>
            <CopyButton text={secret} label={label} />
          </div>
        </div>
        {children}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
