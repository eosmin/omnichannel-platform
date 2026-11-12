'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useRef, useState } from 'react'

import type { OrderTemplateView } from '@platform/api-client'
import {
  OrderMessageKind,
  OrderMessageLimits,
  type OrderMessageKindType,
  OrderMessageWarnings
} from '@platform/core/domain'
import type { Locale } from '@platform/core/i18n'

import type { LinkableChannel } from '../../lib/settings/order-template-channels'
import {
  draftWarnings,
  insertVariable,
  KNOWN_VARIABLES,
  showsAutoSend,
  type TemplateDraft,
  type TemplateProblem,
  templateDraftOf,
  templateInput,
  templateProblems,
  TemplateProblems
} from '../../lib/settings/order-template-form'
import {
  useDeleteOrderTemplate,
  useSaveOrderTemplate,
  useTemplatePreview
} from '../../lib/settings/use-order-templates'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button } from '../ui/button'
import { CharCounter } from '../ui/char-counter'
import { Textarea } from '../ui/textarea'

import { OrderTemplateLink } from './order-template-link'

const BODY_PROBLEMS: readonly TemplateProblem[] = [
  TemplateProblems.BODY_BLANK,
  TemplateProblems.BODY_TOO_LONG,
  TemplateProblems.UNKNOWN_VARIABLE
]

// The editor of one template: a kind in a language. The text is written with the variables of the order, the preview shows it
// filled with a sample order by the api (what is rendered there is what is sent), and the switches say how it goes out. The
// draft belongs to the page, which keeps it while the person looks at other kinds or languages; saving and deleting are here.
export function OrderTemplateEditor({
  kind,
  locale,
  saved,
  draft,
  onDraftChange,
  onDone,
  canManage,
  channels,
  channelsKnown
}: {
  kind: OrderMessageKindType
  locale: Locale
  saved: OrderTemplateView | undefined
  draft: TemplateDraft
  onDraftChange: (next: TemplateDraft) => void
  // The draft is saved or the template deleted: the page drops the draft and shows what the api now has
  onDone: () => void
  canManage: boolean
  channels: LinkableChannel[]
  // The channel directory was read: without it the link cannot tell a channel that is gone from one it could not read
  channelsKnown: boolean
}): ReactElement {
  const t = useTranslations('settings.orderMessages')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const idPrefix = useId()
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const save = useSaveOrderTemplate(storeId)
  const remove = useDeleteOrderTemplate(storeId)
  const [showProblems, setShowProblems] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const problems = templateProblems(draft)
  const { preview, settled } = useTemplatePreview(
    storeId,
    draft.body,
    locale,
    canManage && !problems.includes(TemplateProblems.BODY_TOO_LONG)
  )
  const warnings = draftWarnings(kind, draft, preview.data?.variables ?? [])
  const disabled = !canManage || save.isPending || remove.isPending
  const set = (patch: Partial<TemplateDraft>): void => onDraftChange({ ...draft, ...patch })

  const addVariable = (variable: (typeof KNOWN_VARIABLES)[number]): void => {
    const field = bodyRef.current
    const at = field?.selectionStart ?? draft.body.length
    const to = field?.selectionEnd ?? at
    const next = insertVariable(draft.body, at, to, variable)
    set({ body: next.body })
    // The text is controlled: the caret is put back once React has drawn the new text
    setTimeout(() => {
      field?.focus()
      field?.setSelectionRange(next.caret, next.caret)
    }, 0)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    save.mutate(
      { kind, locale, input: templateInput(kind, draft) },
      {
        onSuccess: () => {
          setShowProblems(false)
          onDone()
          toast.success(t('saved'))
        },
        onError: error => toast.error(errorText(error))
      }
    )
  }

  const confirmRemoval = (): void => {
    remove.mutate(
      { kind, locale },
      {
        onSuccess: () => {
          setConfirmDelete(false)
          onDone()
          toast.success(t('deleted'))
        },
        onError: error => {
          setConfirmDelete(false)
          toast.error(errorText(error))
        }
      }
    )
  }

  const previewText =
    draft.body.trim() === ''
      ? null
      : preview.isError && settled
        ? errorText(preview.error)
        : (preview.data?.text ?? null)
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4"
      noValidate
      aria-label={t('editorLabel')}
    >
      <p className="text-muted-foreground text-sm">
        {saved === undefined ? t('notSet') : t('isSet')}
      </p>
      {canManage ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}

      <div className="grid gap-1.5">
        <label htmlFor={`${idPrefix}-body`} className="text-sm font-medium">
          {t('body')}
        </label>
        <Textarea
          id={`${idPrefix}-body`}
          ref={bodyRef}
          value={draft.body}
          rows={8}
          onChange={event => set({ body: event.target.value })}
          disabled={disabled}
          aria-invalid={showProblems && problems.some(item => BODY_PROBLEMS.includes(item))}
          aria-describedby={`${idPrefix}-body-hint`}
        />
        <div className="flex items-start justify-between gap-2">
          <p id={`${idPrefix}-body-hint`} className="text-muted-foreground text-xs">
            {t('bodyHint')}
          </p>
          <CharCounter length={draft.body.length} max={OrderMessageLimits.BODY_MAX_LENGTH} />
        </div>
      </div>

      {canManage ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('variablesTitle')}</p>
          <ul aria-label={t('variablesTitle')} className="flex flex-wrap gap-2">
            {KNOWN_VARIABLES.map(variable => (
              <li key={variable}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  title={t(`variables.${variable}.hint`)}
                  disabled={disabled}
                  onClick={() => addVariable(variable)}
                >
                  {t(`variables.${variable}.label`)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">{t('previewTitle')}</p>
        <div
          role="status"
          aria-label={t('previewTitle')}
          className="bg-muted/40 min-h-16 rounded-md border p-3 text-sm whitespace-pre-wrap"
        >
          {previewText ?? (
            <span className="text-muted-foreground">
              {canManage && draft.body.trim() === '' ? t('previewEmpty') : t('previewUnavailable')}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{t('previewHint')}</p>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('sending.legend')}</legend>
        {showsAutoSend(kind) ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.autoSend}
              onChange={event => set({ autoSend: event.target.checked })}
              disabled={disabled}
              className="mt-1"
            />
            <span>
              {t('sending.auto')}
              <span className="text-muted-foreground block text-xs">{t('sending.autoHint')}</span>
            </span>
          </label>
        ) : (
          <p className="text-muted-foreground text-xs">
            {kind === OrderMessageKind.ORDER_SUMMARY
              ? t('sending.byPreferenceSummary')
              : t('sending.byPreferenceFailedAttempt')}
          </p>
        )}
        {warnings.includes(OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE) ? (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
          >
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{t('warnings.autoSendNeedsScheduledDate')}</span>
          </p>
        ) : null}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.attachSummary}
            onChange={event => set({ attachSummary: event.target.checked })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('sending.attach')}
            <span className="text-muted-foreground block text-xs">{t('sending.attachHint')}</span>
          </span>
        </label>
      </fieldset>

      <OrderTemplateLink
        link={draft.channelTemplate}
        channels={channels}
        channelsKnown={channelsKnown}
        onChange={channelTemplate => set({ channelTemplate })}
        disabled={disabled}
      />

      {showProblems && problems.length > 0 ? (
        <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
          {problems.map(problem => (
            <li key={problem}>{t(`problems.${problem}`)}</li>
          ))}
        </ul>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={disabled} busy={save.isPending}>
            {t('save')}
          </Button>
          {saved === undefined ? null : (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => setConfirmDelete(true)}
            >
              {t('delete.button')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              onDraftChange(templateDraftOf(kind, saved))
              setShowProblems(false)
            }}
          >
            {t('discard')}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('delete.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('delete.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('delete.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemoval}>{t('delete.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}
