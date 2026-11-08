'use client'

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

function ResolveFormLoading(): ReactElement {
  const t = useTranslations('common')
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {t('loading')}
    </p>
  )
}

const ResolveForm = dynamic(() => import('./resolve-form').then(module => module.ResolveForm), {
  loading: () => <ResolveFormLoading />
})

// The dialog with the options of resolving, downloaded the first time it is opened (`useResolveFlow`): the
// dialog primitive, its focus trap and the form are not part of the first load of the inbox
export default function ResolveDialog({
  open,
  onOpenChange,
  conversationId,
  settings,
  canSendClosing
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string
  settings: { sendClosingMessage: boolean; closingSnippetId: string | null } | undefined
  canSendClosing: boolean
}): ReactElement {
  const t = useTranslations('inbox.resolve')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: the choices start from the settings each time */}
        {open && settings !== undefined ? (
          <ResolveForm
            conversationId={conversationId}
            defaults={settings}
            canSendClosing={canSendClosing}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
