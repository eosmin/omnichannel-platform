'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { BulkOperation } from '@platform/api-client'
import { BulkActions, RoutingLimits } from '@platform/core/domain'

import { useMemberDirectory, useTags } from '../../lib/inbox/use-inbox-data'
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

import { type BulkPick, BulkPicks } from './bulk-picks'

interface Choice {
  id: string
  label: string
}

// The actions that need a person or a tag chosen first. Nothing is sent from here: the choice goes back
// to the bar, which decides whether to ask for confirmation.
export function BulkPickDialog({
  pick,
  onOpenChange,
  onPick
}: {
  pick: BulkPick | null
  onOpenChange: (open: boolean) => void
  // `label` names what was chosen, for the confirmation ("Ana", "VIP", "3 people")
  onPick: (operation: BulkOperation, label: string) => void
}): ReactElement {
  return (
    <Dialog open={pick !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {pick === null ? null : <PickForm key={pick} pick={pick} onPick={onPick} />}
      </DialogContent>
    </Dialog>
  )
}

function PickForm({
  pick,
  onPick
}: {
  pick: BulkPick
  onPick: (operation: BulkOperation, label: string) => void
}): ReactElement {
  const t = useTranslations('inbox.bulk.pick')
  const { storeId } = useStore()
  const members = useMemberDirectory(storeId)
  const tags = useTags(storeId)
  const [chosen, setChosen] = useState<readonly string[]>([])

  const isTeam = pick === BulkPicks.TEAM
  const isTag = pick === BulkPicks.ADD_TAG || pick === BulkPicks.REMOVE_TAG
  const choices: Choice[] = isTag
    ? (tags.data ?? []).map(tag => ({ id: tag.id, label: tag.name }))
    : (members.data ?? []).map(member => ({ id: member.id, label: member.name }))
  const isLoading = isTag ? tags.isPending : members.isPending
  const isFailed = isTag ? tags.isError : members.isError

  const minimum = isTeam ? RoutingLimits.MIN_USERS_FOR_ROUND_ROBIN : 1
  const maximum = isTeam ? RoutingLimits.MAX_USERS_PER_ACTION : 1
  // A person or a tag that left the list while the dialog was open is no longer a choice
  const valid = chosen.filter(id => choices.some(choice => choice.id === id))
  const canSubmit = valid.length >= minimum && valid.length <= maximum

  function toggle(id: string): void {
    if (!isTeam) {
      setChosen([id])
      return
    }
    setChosen(current =>
      current.includes(id) ? current.filter(other => other !== id) : [...current, id]
    )
  }

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!canSubmit) return
    const [first] = valid
    if (first === undefined) return
    const labelOf = (id: string): string => choices.find(choice => choice.id === id)?.label ?? id
    switch (pick) {
      case BulkPicks.AGENT:
        onPick({ action: BulkActions.ASSIGN_TO_AGENT, params: { userId: first } }, labelOf(first))
        return
      case BulkPicks.TEAM:
        onPick(
          { action: BulkActions.ROUND_ROBIN_TO_TEAM, params: { userIds: [...valid] } },
          t('teamLabel', { count: valid.length })
        )
        return
      case BulkPicks.ADD_TAG:
        onPick({ action: BulkActions.ADD_TAG, params: { tagId: first } }, labelOf(first))
        return
      case BulkPicks.REMOVE_TAG:
        onPick({ action: BulkActions.REMOVE_TAG, params: { tagId: first } }, labelOf(first))
        return
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{t(`${pick}.title`)}</DialogTitle>
        <DialogDescription>
          {isTeam
            ? t('team.description', { min: minimum, max: maximum })
            : t(`${pick}.description`)}
        </DialogDescription>
      </DialogHeader>
      {isLoading ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('loading')}
        </p>
      ) : isFailed ? (
        <p role="alert" className="text-destructive text-sm">
          {t('failed')}
        </p>
      ) : choices.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t(isTag ? 'noTags' : 'noMembers')}</p>
      ) : (
        <fieldset className="grid max-h-64 gap-1 overflow-y-auto">
          <legend className="sr-only">{t(`${pick}.title`)}</legend>
          {choices.map(choice => (
            <label
              key={choice.id}
              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
            >
              <input
                type={isTeam ? 'checkbox' : 'radio'}
                name="bulk-pick"
                className="accent-primary size-4"
                checked={chosen.includes(choice.id)}
                onChange={() => toggle(choice.id)}
              />
              <span className="truncate">{choice.label}</span>
            </label>
          ))}
        </fieldset>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!canSubmit}>
          {t('continue')}
        </Button>
      </DialogFooter>
    </form>
  )
}
