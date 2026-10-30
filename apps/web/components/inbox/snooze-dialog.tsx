'use client'

import { useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { ConversationLimits } from '@platform/core/domain'

import { errorCodeOf } from '../../lib/error-message'
import {
  DAY_MS,
  parseLocalDateTime,
  type SnoozePreset,
  snoozePresets,
  toLocalDateTimeValue
} from '../../lib/inbox/snooze-presets'
import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useInboxBehavior } from '../../lib/inbox/use-inbox-data'
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

export interface SnoozeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string
}

// Hides the conversation until a moment, counted in the timezone of the store: the
// presets and the date field both mean the wall clock of the store, wherever the agent is.
export function SnoozeDialog(props: SnoozeDialogProps): ReactElement {
  const t = useTranslations('inbox.snooze')
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: the presets are counted from the moment it opens */}
        {props.open ? <SnoozeForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function SnoozeForm({ onOpenChange, conversationId }: SnoozeDialogProps): ReactElement {
  const t = useTranslations('inbox.snooze')
  const tAll = useTranslations()
  const locale = useLocale()
  const { storeId } = useStore()
  const behavior = useInboxBehavior(storeId)
  const { snooze } = useConversationActions(storeId, conversationId)
  const [now] = useState(() => new Date())
  const [custom, setCustom] = useState('')

  if (behavior.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {tAll('common.loading')}
      </p>
    )
  }
  if (behavior.isError) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-destructive text-sm">
          {tAll(`errors.${errorCodeOf(behavior.error)}`)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void behavior.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </div>
    )
  }

  const { timezone } = behavior.data
  const format = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short'
  })
  const customUntil = parseLocalDateTime(custom, timezone)
  const maxUntil = new Date(now.getTime() + ConversationLimits.MAX_SNOOZE_DAYS * DAY_MS)
  const isCustomValid =
    customUntil !== null &&
    customUntil.getTime() > now.getTime() &&
    customUntil.getTime() <= maxUntil.getTime()

  const run = (until: Date): void => {
    // A promise, not the callbacks of mutate: those do not run if the agent moves to another
    // conversation before the answer
    snooze
      .mutateAsync(until)
      .then(() => {
        toast.success(t('done', { time: format.format(until) }))
        onOpenChange(false)
      })
      // The error shows in the dialog, from the state of the mutation
      .catch(() => undefined)
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {snoozePresets(now, timezone).map((preset: SnoozePreset) => (
          <li key={preset.id}>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-between"
              disabled={snooze.isPending}
              onClick={() => run(preset.until)}
            >
              <span>{t(`presets.${preset.id}`)}</span>
              <span className="text-muted-foreground text-xs">{format.format(preset.until)}</span>
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={event => {
          event.preventDefault()
          if (customUntil !== null && isCustomValid && !snooze.isPending) run(customUntil)
        }}
      >
        <Label htmlFor="snooze-custom">{t('custom')}</Label>
        <Input
          id="snooze-custom"
          type="datetime-local"
          value={custom}
          min={toLocalDateTimeValue(now, timezone)}
          max={toLocalDateTimeValue(maxUntil, timezone)}
          disabled={snooze.isPending}
          onChange={event => setCustom(event.target.value)}
          aria-describedby="snooze-timezone"
        />
        <p id="snooze-timezone" className="text-muted-foreground text-xs">
          {t('timezone', { timezone })}
        </p>
        <DialogFooter>
          <Button type="submit" disabled={!isCustomValid || snooze.isPending}>
            {snooze.isPending ? t('snoozing') : t('confirm')}
          </Button>
        </DialogFooter>
      </form>
      {snooze.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {tAll(`errors.${errorCodeOf(snooze.error)}`)}
        </p>
      ) : null}
    </div>
  )
}
