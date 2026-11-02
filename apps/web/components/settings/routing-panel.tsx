'use client'

import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, Route, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type DragEvent, type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import type { MemberDirectoryEntryView, TagView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import {
  isOfficialChannelId,
  type OfficialChannelId,
  RoutingActionTypes
} from '@platform/core/domain'

import { errorCodeOf } from '../../lib/error-message'
import { moveBy, moveItem, sameOrder } from '../../lib/settings/routing-order'
import type { RuleView } from '../../lib/settings/routing-requests'
import { useDeleteRule, useReorderRules, useUpdateRule } from '../../lib/settings/use-routing'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { RuleDialog } from './routing-rule-dialog'

type Editing = { kind: 'new' } | { kind: 'rule'; rule: RuleView } | null

// Settings → Routing: the rules of the store in the order they are tried (TDD_09 §13). The order is
// changed by dragging a rule or with the two buttons on each row, which is what the keyboard uses;
// both send the whole new order. Who may see the page can read it, `SETTINGS_MANAGE_ROUTING` changes it.
export function RoutingPanel({
  rules,
  members,
  tags
}: {
  rules: RuleView[]
  members: MemberDirectoryEntryView[]
  tags: TagView[]
}): ReactElement {
  const t = useTranslations('settings.routing')
  const tErrors = useTranslations('errors')
  const { storeId, can } = useStore()
  const canManage = can(Permissions.SETTINGS_MANAGE_ROUTING)
  const listsAvailable = can(Permissions.CONVERSATIONS_VIEW)
  const reorder = useReorderRules(storeId)
  const [editing, setEditing] = useState<Editing>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')

  // While the new order is on its way the list already shows it
  const byId = new Map(rules.map(rule => [rule.id, rule]))
  const shown =
    reorder.isPending && reorder.variables !== undefined
      ? [
          ...reorder.variables.flatMap(id => byId.get(id) ?? []),
          // A rule that arrived meanwhile is not dropped from the page
          ...rules.filter(rule => !reorder.variables.includes(rule.id))
        ]
      : rules
  const ids = shown.map(rule => rule.id)

  const send = (next: string[], moved: RuleView): void => {
    if (sameOrder(ids, next) || reorder.isPending) return
    reorder.mutate(next, {
      onSuccess: () =>
        setAnnouncement(
          t('reorder.moved', { name: moved.name, position: next.indexOf(moved.id) + 1 })
        ),
      onError: error => toast.error(tErrors(errorCodeOf(error)))
    })
  }

  const drop = (event: DragEvent, target: RuleView): void => {
    event.preventDefault()
    const from = dragging === null ? -1 : ids.indexOf(dragging)
    const moved = byId.get(dragging ?? '')
    setDragging(null)
    if (from === -1 || moved === undefined) return
    send(moveItem(ids, from, ids.indexOf(target.id)), moved)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        {canManage ? (
          <Button type="button" size="sm" onClick={() => setEditing({ kind: 'new' })}>
            <Plus aria-hidden className="size-4" />
            {t('create')}
          </Button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Route aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ol aria-label={t('listLabel')} className="flex flex-col gap-3">
          {shown.map((rule, index) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              position={index + 1}
              total={shown.length}
              members={members}
              tags={tags}
              canManage={canManage}
              busy={reorder.isPending}
              dragging={dragging === rule.id}
              onDragStart={() => setDragging(rule.id)}
              onDragEnd={() => setDragging(null)}
              onDrop={event => drop(event, rule)}
              onMove={delta => send(moveBy(ids, rule.id, delta), rule)}
              onEdit={() => setEditing({ kind: 'rule', rule })}
            />
          ))}
        </ol>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {editing === null ? null : (
        <RuleDialog
          // A fresh form for each rule: nothing typed for one carries to the next
          key={editing.kind === 'rule' ? editing.rule.id : 'new'}
          rule={editing.kind === 'rule' ? editing.rule : null}
          members={members}
          tags={tags}
          listsAvailable={listsAvailable}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function RuleRow({
  rule,
  position,
  total,
  members,
  tags,
  canManage,
  busy,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  onEdit
}: {
  rule: RuleView
  position: number
  total: number
  members: MemberDirectoryEntryView[]
  tags: TagView[]
  canManage: boolean
  busy: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: (event: DragEvent) => void
  onMove: (delta: -1 | 1) => void
  onEdit: () => void
}): ReactElement {
  const t = useTranslations('settings.routing')
  const tErrors = useTranslations('errors')
  const { storeId } = useStore()
  const run = useDestructiveAction()
  const update = useUpdateRule(storeId)
  const remove = useDeleteRule(storeId)

  const toggle = (enabled: boolean): void => {
    update.mutate(
      { ruleId: rule.id, input: { enabled } },
      { onError: error => toast.error(tErrors(errorCodeOf(error))) }
    )
  }

  const askToDelete = (): void => {
    run('DELETE_ROUTING_RULE', {
      title: t('delete.title', { name: rule.name }),
      description: t('delete.description'),
      confirmLabel: t('delete.confirm'),
      onConfirm: async () => {
        try {
          await remove.mutateAsync(rule.id)
          toast.success(t('delete.done', { name: rule.name }))
        } catch (error) {
          toast.error(tErrors(errorCodeOf(error)))
        }
      }
    })
  }

  return (
    <li
      className={`flex flex-wrap items-center gap-3 rounded-lg border p-4 ${dragging ? 'opacity-50' : ''}`}
      // Any row accepts a drop; only a row that is being dragged was picked up by its handle
      onDragOver={canManage ? event => event.preventDefault() : undefined}
      onDrop={canManage ? onDrop : undefined}
    >
      {canManage ? (
        <span
          draggable={!busy}
          onDragStart={event => {
            event.dataTransfer.effectAllowed = 'move'
            onDragStart()
          }}
          onDragEnd={onDragEnd}
          title={t('reorder.drag', { name: rule.name })}
          className="text-muted-foreground cursor-grab"
        >
          <GripVertical aria-hidden className="size-5" />
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="flex items-center gap-2 font-medium">
          <span className="text-muted-foreground text-sm font-normal">{position}.</span>
          {rule.name}
          {rule.enabled ? null : (
            <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs font-normal">
              {t('disabled')}
            </span>
          )}
        </h2>
        <RuleSummary rule={rule} members={members} tags={tags} />
      </div>
      <div className="flex items-center gap-2">
        {canManage ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              <Pencil aria-hidden className="size-4" />
              {t('edit')}
              <span className="sr-only"> {rule.name}</span>
            </Button>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={rule.enabled}
                disabled={update.isPending}
                onChange={event => toggle(event.target.checked)}
                aria-label={t('toggle', { name: rule.name })}
              />
              {t('on')}
            </label>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={busy || position === 1}
              onClick={() => onMove(-1)}
              aria-label={t('reorder.up', { name: rule.name })}
            >
              <ArrowUp aria-hidden className="size-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={busy || position === total}
              onClick={() => onMove(1)}
              aria-label={t('reorder.down', { name: rule.name })}
            >
              <ArrowDown aria-hidden className="size-4" />
            </Button>
          </>
        ) : null}
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={remove.isPending}
            onClick={askToDelete}
          >
            <Trash2 aria-hidden className="size-4" />
            {t('delete.action')}
            <span className="sr-only"> {rule.name}</span>
          </Button>
        ) : null}
      </div>
    </li>
  )
}

// One line that says when the rule applies and what it does, from the rule as the api holds it
function RuleSummary({
  rule,
  members,
  tags
}: {
  rule: RuleView
  members: MemberDirectoryEntryView[]
  tags: TagView[]
}): ReactElement {
  const t = useTranslations('settings.routing.summary')
  const tChannels = useTranslations('settings.routing.channelNames')
  const { channelTypes, tagIds, keywords, outsideBusinessHours } = rule.conditions
  const parts: string[] = []
  if (channelTypes !== undefined) {
    parts.push(
      t('channels', { list: channelTypes.map(id => channelLabel(tChannels, id)).join(', ') })
    )
  }
  if (tagIds !== undefined) {
    const names = tagIds.map(id => tags.find(tag => tag.id === id)?.name ?? t('unknownTag'))
    parts.push(t('tags', { list: names.join(', ') }))
  }
  if (keywords !== undefined) parts.push(t('keywords', { list: keywords.join(', ') }))
  if (outsideBusinessHours === true) parts.push(t('outsideHours'))
  const nameOf = (id: string): string =>
    members.find(member => member.id === id)?.name ?? t('formerMember')
  const action =
    rule.action.type === RoutingActionTypes.UNASSIGNED
      ? t('unassigned')
      : rule.action.type === RoutingActionTypes.ASSIGN_USER
        ? t('assign', { name: nameOf(rule.action.userIds[0] ?? '') })
        : t('roundRobin', { count: rule.action.userIds.length })
  return (
    <span className="text-muted-foreground text-sm">
      {parts.length === 0 ? t('always') : parts.join(' · ')}
      {' → '}
      {action}
    </span>
  )
}

// A channel id that is not one of the official ones (a plugin) is shown as it is written
function channelLabel(t: (id: OfficialChannelId) => string, id: string): string {
  return isOfficialChannelId(id) ? t(id) : id
}
