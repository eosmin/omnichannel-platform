'use client'

import { Lock, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { permissionNameKey } from '../../lib/permission-name'
import { useErrorText } from '../../lib/use-error-text'
import { Button } from '../ui/button'

// "You do not have access to this" (TDD_09 §18): a page reached by a link, or by a role that changed
// `permission` is the one the page needs, said by the name the team settings give it ("Gestionar el
// equipo"); `body` is a line of its own for a page that has a better one
export function PermissionDenied({
  body,
  permission
}: {
  body?: string
  permission?: string
}): ReactElement {
  const t = useTranslations('emptyStates.permissionDenied')
  const tAll = useTranslations()
  const key = permission === undefined ? null : permissionNameKey(permission)
  const named =
    key !== null && tAll.has(key as 'errors.INTERNAL_ERROR')
      ? tAll('permissionDenied.named', { permission: tAll(key as 'errors.INTERNAL_ERROR') })
      : null
  return (
    <section className="flex flex-col items-center gap-2 py-12 text-center">
      <Lock aria-hidden className="text-muted-foreground size-8" />
      <h1 className="text-lg font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">{body ?? named ?? t('body')}</p>
    </section>
  )
}

// A page whose data could not be read: the reason from the code of the api, and a way to try again
export function LoadFailed({
  error,
  onRetry
}: {
  error: unknown
  onRetry: () => void
}): ReactElement {
  const t = useTranslations()
  const errorText = useErrorText()
  return (
    <section role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
      <TriangleAlert aria-hidden className="text-destructive size-8" />
      <p className="text-sm">{errorText(error)}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('common.tryAgain')}
      </Button>
    </section>
  )
}

export function PageLoading(): ReactElement {
  const t = useTranslations('common')
  return (
    <p role="status" className="text-muted-foreground py-12 text-center text-sm">
      {t('loading')}
    </p>
  )
}
