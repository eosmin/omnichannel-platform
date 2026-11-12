'use client'

import { useIsMutating } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import { type OrderTemplateView, QueryKeys } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { OrderMessageKind, type OrderMessageKindType } from '@platform/core/domain'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'

import { useStore } from '../../components/providers/store-context'
import { OrderTemplateEditor } from '../../components/settings/order-template-editor'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { useChannelDirectory } from '../../lib/inbox/use-inbox-data'
import { linkableChannels } from '../../lib/settings/order-template-channels'
import {
  type TemplateDraft,
  templateChanged,
  templateDraftOf
} from '../../lib/settings/order-template-form'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useOrderTemplates } from '../../lib/settings/use-order-templates'
import { cn } from '../../lib/utils'

const KINDS = Object.values(OrderMessageKind)

const addressOf = (kind: OrderMessageKindType, locale: Locale): string => `${kind}/${locale}`

// Settings → Order messages (TDD_17 §4.7, §6): the texts the store sends its customers about an order, one per kind and
// language. Only the templates the store wrote exist: a kind and language with none is sent with the platform's own text.
// The page opens with SETTINGS_VIEW and ORDERS_VIEW (the api lists the templates for whoever sees orders); writing,
// deleting and previewing need SETTINGS_MANAGE_ORDER_TEMPLATES.
export function StoreOrderTemplatesPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) && can(ClientPermissions.ORDERS_VIEW) ? (
    <TemplatesLoader />
  ) : (
    <PermissionDenied
      permission={
        can(ClientPermissions.SETTINGS_VIEW)
          ? ClientPermissions.ORDERS_VIEW
          : ClientPermissions.SETTINGS_VIEW
      }
    />
  )
}

function TemplatesLoader(): ReactElement {
  const t = useTranslations('settings.orderMessages')
  const { storeId } = useStore()
  const templates = useOrderTemplates(storeId)
  if (templates.isError) {
    return <LoadFailed error={templates.error} onRetry={() => void templates.refetch()} />
  }
  if (templates.data === undefined) return <PageLoading />
  return (
    <section className="flex flex-col gap-6">
      <header className="flex max-w-3xl flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <TemplatesWorkspace key={storeId} templates={templates.data} />
    </section>
  )
}

function TemplatesWorkspace({ templates }: { templates: OrderTemplateView[] }): ReactElement {
  const t = useTranslations('settings.orderMessages')
  const { can, storeId } = useStore()
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_ORDER_TEMPLATES)
  const [kind, setKind] = useState<OrderMessageKindType>(KINDS[0] ?? OrderMessageKind.ORDER_SUMMARY)
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE)
  // What the person is writing, kept while they look at another kind or language: a draft is dropped when it is saved,
  // deleted or discarded
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>({})
  const directory = useChannelDirectory(storeId)
  // The editor that owns a save or a delete answers it: it stays until the answer is in
  const writing = useIsMutating({ mutationKey: QueryKeys.orderTemplates.writing(storeId) }) > 0
  const channels = useMemo(() => linkableChannels(directory.data ?? []), [directory.data])

  const savedOf = (k: OrderMessageKindType, l: Locale): OrderTemplateView | undefined =>
    templates.find(item => item.kind === k && item.locale === l)
  const draftOf = (k: OrderMessageKindType, l: Locale): TemplateDraft =>
    dirtyOf(k, l)
      ? (drafts[addressOf(k, l)] ?? templateDraftOf(k, savedOf(k, l)))
      : templateDraftOf(k, savedOf(k, l))
  const dirtyOf = (k: OrderMessageKindType, l: Locale): boolean => {
    const draft = drafts[addressOf(k, l)]
    return draft !== undefined && templateChanged(k, savedOf(k, l), draft)
  }
  const anyDirty = KINDS.some(k => SUPPORTED_LOCALES.some(l => dirtyOf(k, l)))
  useUnsavedChanges(canManage && anyDirty)

  const drop = (k: OrderMessageKindType, l: Locale): void =>
    setDrafts(current =>
      Object.fromEntries(Object.entries(current).filter(([key]) => key !== addressOf(k, l)))
    )

  return (
    <div className="grid gap-6 md:grid-cols-[16rem_1fr]">
      <nav aria-label={t('kindsLabel')}>
        <ul className="flex flex-col gap-1">
          {KINDS.map(item => {
            const count = SUPPORTED_LOCALES.filter(l => savedOf(item, l) !== undefined).length
            const unsaved = SUPPORTED_LOCALES.some(l => dirtyOf(item, l))
            return (
              <li key={item}>
                <button
                  type="button"
                  aria-pressed={item === kind}
                  disabled={writing}
                  onClick={() => setKind(item)}
                  className={cn(
                    'hover:bg-accent flex w-full flex-col rounded-md px-3 py-2 text-left text-sm',
                    item === kind && 'bg-accent font-medium'
                  )}
                >
                  <span>{t(`kinds.${item}.label`)}</span>
                  <span className="text-muted-foreground text-xs">
                    {unsaved ? t('unsavedMark') : t('languagesSet', { count })}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="flex max-w-3xl flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t(`kinds.${kind}.label`)}</h2>
          <p className="text-muted-foreground text-sm">{t(`kinds.${kind}.hint`)}</p>
        </div>
        <div role="group" aria-label={t('localesLabel')} className="flex gap-2">
          {SUPPORTED_LOCALES.map(item => (
            <button
              key={item}
              type="button"
              aria-pressed={item === locale}
              disabled={writing}
              onClick={() => setLocale(item)}
              className={cn(
                'hover:bg-accent rounded-md border px-3 py-1.5 text-sm',
                item === locale && 'bg-accent font-medium'
              )}
            >
              {t(`locales.${item}`)}
              {dirtyOf(kind, item) ? ` ${t('unsavedMark')}` : ''}
            </button>
          ))}
        </div>
        <OrderTemplateEditor
          key={addressOf(kind, locale)}
          kind={kind}
          locale={locale}
          saved={savedOf(kind, locale)}
          draft={draftOf(kind, locale)}
          onDraftChange={next =>
            setDrafts(current => ({ ...current, [addressOf(kind, locale)]: next }))
          }
          onDone={() => drop(kind, locale)}
          canManage={canManage}
          channels={channels}
          channelsKnown={directory.data !== undefined}
        />
      </div>
    </div>
  )
}
