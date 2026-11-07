'use client'

import { Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import type { StoreTagView } from '../../lib/settings/tags-requests'
import { useDeleteTag } from '../../lib/settings/use-content'
import { toast } from '../../lib/toast'
import { useCodeText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { TagDialog } from './tag-dialog'

type Editing = { kind: 'new' } | { kind: 'tag'; tag: StoreTagView } | null

// Settings → Tags: the tags of the store, shared by its customers and conversations (TDD_09 §13).
// Who may see conversations can read the list; SETTINGS_EDIT creates, edits and deletes.
export function TagsPanel({ tags }: { tags: StoreTagView[] }): ReactElement {
  const t = useTranslations('settings.tags')
  const codeText = useCodeText()
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.SETTINGS_EDIT)
  const run = useDestructiveAction()
  const remove = useDeleteTag(storeId)
  const [editing, setEditing] = useState<Editing>(null)

  const askToDelete = (tag: StoreTagView): void => {
    run('DELETE_TAG', {
      title: t('delete.title', { name: tag.name }),
      description: t('delete.description'),
      confirmLabel: t('delete.confirm'),
      onConfirm: async () => {
        try {
          await remove.mutateAsync(tag.id)
          toast.success(t('delete.done', { name: tag.name }))
        } catch (error) {
          // The api answers a conflict when a routing rule names the tag / a message uses the reply
          const code = errorCodeOf(error)
          toast.error(
            code === ClientErrorCodes.RESOURCE_CONFLICT ? t('delete.inUse') : codeText(code)
          )
        }
      }
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm">{t('description')}</p>
        {canEdit ? (
          <Button type="button" size="sm" onClick={() => setEditing({ kind: 'new' })}>
            <Plus aria-hidden className="size-4" />
            {t('create')}
          </Button>
        ) : null}
      </div>
      {tags.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Tag aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {tags.map(tag => (
            <li key={tag.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
              <span
                aria-hidden
                className="size-4 shrink-0 rounded-full border"
                style={{ backgroundColor: tag.color }}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 className="font-medium">{tag.name}</h2>
                {tag.description === null ? null : (
                  <span className="text-muted-foreground text-sm">{tag.description}</span>
                )}
              </div>
              {canEdit ? (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing({ kind: 'tag', tag })}
                  >
                    <Pencil aria-hidden className="size-4" />
                    {t('edit')}
                    <span className="sr-only"> {tag.name}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => askToDelete(tag)}
                  >
                    <Trash2 aria-hidden className="size-4" />
                    {t('delete.action')}
                    <span className="sr-only"> {tag.name}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <TagDialog
          // A fresh form for each tag: nothing typed for one carries to the next
          key={editing.kind === 'tag' ? editing.tag.id : 'new'}
          tag={editing.kind === 'tag' ? editing.tag : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
