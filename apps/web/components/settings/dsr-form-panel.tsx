'use client'

import { KeyRound, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import type { DsrFormChange } from '../../lib/compliance/use-dsr-form'
import { useDsrForm, useDsrFormChange } from '../../lib/compliance/use-dsr-form'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

// Settings → Data requests → "Public form" (TDD_05 §10.2, Step 7.2-H2b, C1a): the key the store gives to the public form of data requests.
// The api asks `customers:dsr_manage_form` for every call, and the panel draws nothing for who does not hold it. The key is public by design
// (it travels in the address of the form), so it is shown whole; replacing or switching it off asks to be confirmed, because every link
// that carries the old key stops taking requests at once.
export function DsrFormPanel(): ReactElement | null {
  const t = useTranslations('settings.dsrForm')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const run = useDestructiveAction()
  const guard = useSubmitGuard()
  const allowed = can(ClientPermissions.CUSTOMERS_DSR_MANAGE_FORM)
  const form = useDsrForm(storeId, allowed)
  const make = useDsrFormChange(storeId, 'make')
  const revoke = useDsrFormChange(storeId, 'revoke')
  if (!allowed) return null

  const key = form.data?.key ?? null
  const busy = make.isPending || revoke.isPending

  const change = async (kind: DsrFormChange): Promise<void> => {
    if (!guard.enter()) return
    try {
      await (kind === 'make' ? make : revoke).mutateAsync({ current: key })
      toast.success(t(`done.${kind === 'make' && key !== null ? 'replace' : kind}`))
    } catch (error) {
      // Someone changed the key first: the key is read again (the mutation did it) and the person is told in the api's words
      toast.error(errorText(error))
    } finally {
      guard.leave()
    }
  }

  const askToReplace = (): void =>
    run('ROTATE_DSR_FORM_KEY', {
      title: t('replace.title'),
      description: t('replace.description'),
      confirmLabel: t('replace.confirm'),
      onConfirm: () => change('make')
    })
  const askToSwitchOff = (): void =>
    run('REVOKE_DSR_FORM_KEY', {
      title: t('off.title'),
      description: t('off.description'),
      confirmLabel: t('off.confirm'),
      onConfirm: () => change('revoke')
    })

  return (
    <section aria-labelledby="dsr-form-title" className="flex flex-col gap-3 rounded-md border p-4">
      <header className="flex flex-col gap-1">
        <h2 id="dsr-form-title" className="flex items-center gap-2 text-lg font-semibold">
          <KeyRound aria-hidden className="size-4" />
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>

      {form.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : form.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
          <TriangleAlert aria-hidden className="text-destructive size-4" />
          <span>{errorText(form.error)}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void form.refetch()}>
            {t('retry')}
          </Button>
        </div>
      ) : key === null ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm">{t('none')}</p>
          <Button type="button" size="sm" disabled={busy} onClick={() => void change('make')}>
            {t('make')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t('keyLabel')}</span>
            <code className="bg-muted w-fit rounded px-2 py-1 font-mono text-sm break-all select-all">
              {key}
            </code>
          </div>
          <p className="text-muted-foreground text-sm">
            {form.data?.open ? t('state.open') : t('state.shut')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={askToReplace}
            >
              {t('replace.action')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={askToSwitchOff}
            >
              {t('off.action')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}
