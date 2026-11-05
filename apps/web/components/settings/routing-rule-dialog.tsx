'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import type { MemberDirectoryEntryView, TagView } from '@platform/api-client'
import {
  ChannelIds,
  isOfficialChannelId,
  RoutingActionTypes,
  RoutingLimits
} from '@platform/core/domain'

import type { RuleView } from '../../lib/settings/routing-requests'
import {
  type ActionType,
  type ChannelChoice,
  channelChoicesOf,
  draftOf,
  emptyDraft,
  inputOf,
  type RuleDraft,
  ruleProblems
} from '../../lib/settings/rule-form'
import { useChannelChoices, useCreateRule, useUpdateRule } from '../../lib/settings/use-routing'
import { useSubmitGuard } from '../../lib/submit-guard'
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
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

// Shown when the store's own channels cannot be read (no CONVERSATIONS_VIEW, or the read failed)
const OFFICIAL_CHOICES: ChannelChoice[] = Object.values(ChannelIds).map(id => ({ id, name: id }))
const ACTION_CHOICES: readonly ActionType[] = Object.values(RoutingActionTypes)

function toggled(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value]
}

// The editor of one routing rule (TDD_09 §13): a name, the conditions that must all hold, and what
// happens to a conversation that matches. Opened on a rule it edits it; opened on none it makes one,
// which goes last. The rule sent holds only these four fields.
export function RuleDialog({
  rule,
  members,
  tags,
  listsAvailable,
  onClose
}: {
  rule: RuleView | null
  members: MemberDirectoryEntryView[]
  tags: TagView[]
  // False when the person may not read the lists of people and tags (CONVERSATIONS_VIEW)
  listsAvailable: boolean
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.routing.dialog')
  const errorText = useErrorText()
  const tChannels = useTranslations('settings.routing.channelNames')
  const tCommon = useTranslations('common')
  const { storeId } = useStore()
  const create = useCreateRule(storeId)
  const update = useUpdateRule(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<RuleDraft>(() =>
    rule === null ? emptyDraft() : draftOf(rule)
  )
  const [showProblems, setShowProblems] = useState(false)
  const problems = ruleProblems(draft)
  const saving = create.isPending || update.isPending
  const failure = create.error ?? update.error
  const set = (patch: Partial<RuleDraft>): void => setDraft(current => ({ ...current, ...patch }))

  const guard = useSubmitGuard()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    const done = (): void => {
      toast.success(t(rule === null ? 'created' : 'saved', { name: draft.name.trim() }))
      onClose()
    }
    const input = inputOf(draft)
    if (!guard.enter()) return
    if (rule === null) create.mutate(input, { onSuccess: done, onSettled: guard.leave })
    else update.mutate({ ruleId: rule.id, input }, { onSuccess: done, onSettled: guard.leave })
  }

  // The channels the store has, not the four official ones: a rule for a channel that is not
  // connected would never match. Where the store's own list cannot be read, the official ones.
  const channels = useChannelChoices(storeId, listsAvailable)
  const channelOptions =
    channels.data === undefined
      ? listsAvailable && !channels.isError
        ? channelChoicesOf([], draft.channelTypes)
        : channelChoicesOf([], draft.channelTypes).concat(
            OFFICIAL_CHOICES.filter(choice => !draft.channelTypes.includes(choice.id))
          )
      : channelChoicesOf(channels.data, draft.channelTypes)
  const needsPeople = draft.actionType !== RoutingActionTypes.UNASSIGNED
  // A person who left the store is still in the rule until it is saved again: shown, so it can be taken out
  const known = new Set(members.map(member => member.id))
  const missing = draft.userIds.filter(id => !known.has(id))

  return (
    <Dialog open onOpenChange={open => (open || saving ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(rule === null ? 'createTitle' : 'editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              value={draft.name}
              maxLength={RoutingLimits.NAME_MAX_LENGTH * 2}
              onChange={event => set({ name: event.target.value })}
              disabled={saving}
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={event => set({ enabled: event.target.checked })}
              disabled={saving}
            />
            {t('enabled')}
          </label>

          <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{t('conditions')}</legend>
            <p className="text-muted-foreground text-xs">{t('conditionsHint')}</p>
            <div role="group" aria-label={t('channels')} className="flex flex-wrap gap-3">
              {channelOptions.map(channel => (
                <label key={channel.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.channelTypes.includes(channel.id)}
                    onChange={() => set({ channelTypes: toggled(draft.channelTypes, channel.id) })}
                    disabled={saving}
                  />
                  {isOfficialChannelId(channel.id) ? tChannels(channel.id) : channel.name}
                </label>
              ))}
              {channelOptions.length === 0 && !channels.isPending ? (
                <p className="text-muted-foreground text-xs">{t('noChannels')}</p>
              ) : null}
            </div>
            {listsAvailable ? null : (
              <p className="text-muted-foreground text-xs">{t('listsUnavailable')}</p>
            )}
            <div
              role="group"
              aria-label={t('tags')}
              hidden={!listsAvailable}
              className="flex flex-wrap gap-3"
            >
              {tags.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t('noTags')}</p>
              ) : (
                tags.map(tag => (
                  <label key={tag.id} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.tagIds.includes(tag.id)}
                      onChange={() => set({ tagIds: toggled(draft.tagIds, tag.id) })}
                      disabled={saving}
                    />
                    {tag.name}
                  </label>
                ))
              )}
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <Label htmlFor={`${idPrefix}-keywords`}>{t('keywords')}</Label>
              <Textarea
                id={`${idPrefix}-keywords`}
                value={draft.keywordsText}
                rows={3}
                onChange={event => set({ keywordsText: event.target.value })}
                disabled={saving}
              />
              <p className="text-muted-foreground text-xs">{t('keywordsHint')}</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.outsideBusinessHours}
                onChange={event => set({ outsideBusinessHours: event.target.checked })}
                disabled={saving}
              />
              {t('outsideHours')}
            </label>
          </fieldset>

          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-action`}>{t('action')}</Label>
            <select
              id={`${idPrefix}-action`}
              className={SELECT_CLASS}
              value={draft.actionType}
              onChange={event =>
                set({
                  actionType: event.target.value as ActionType,
                  // One person is kept when going to "assign"; the others would be refused
                  userIds:
                    event.target.value === RoutingActionTypes.ASSIGN_USER
                      ? draft.userIds.slice(0, 1)
                      : draft.userIds
                })
              }
              disabled={saving}
            >
              {ACTION_CHOICES.map(action => (
                <option key={action} value={action}>
                  {t(`actions.${action}`)}
                </option>
              ))}
            </select>
          </div>
          {needsPeople && listsAvailable ? (
            <div role="group" aria-label={t('people')} className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">{t('people')}</span>
              {members.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t('noMembers')}</p>
              ) : null}
              {[
                // Who can be given a conversation, plus whoever the rule already holds (a person whose
                // role changed since stays visible, so the rule can be fixed)
                ...members
                  .filter(member => member.canBeAssigned || draft.userIds.includes(member.id))
                  .map(member => ({ id: member.id, name: member.name })),
                ...missing.map(id => ({ id, name: t('formerMember') }))
              ].map(person => (
                <label key={person.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type={
                      draft.actionType === RoutingActionTypes.ASSIGN_USER ? 'radio' : 'checkbox'
                    }
                    name={`${idPrefix}-people`}
                    checked={draft.userIds.includes(person.id)}
                    onChange={() =>
                      set({
                        userIds:
                          draft.actionType === RoutingActionTypes.ASSIGN_USER
                            ? [person.id]
                            : toggled(draft.userIds, person.id)
                      })
                    }
                    disabled={saving}
                  />
                  {person.name}
                </label>
              ))}
            </div>
          ) : null}

          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          {failure === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {errorText(failure)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
