'use client'

import { MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import { ClientErrorCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import type { StoreSnippetView } from '../../lib/settings/snippets-requests'
import { useDeleteSnippet } from '../../lib/settings/use-content'
import { useCodeText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

import { SnippetDialog } from './snippet-dialog'

type Editing = { kind: 'new' } | { kind: 'snippet'; snippet: StoreSnippetView } | null

// Settings → Snippets: the saved replies an agent inserts with a slash in the composer. Who may see
// conversations can read the list; SETTINGS_EDIT creates, edits and deletes. The api refuses to delete
// a reply that the closing message or the away message uses, and the page says which.
export function SnippetsPanel({ snippets }: { snippets: StoreSnippetView[] }): ReactElement {
  const t = useTranslations('settings.snippets')
  const codeText = useCodeText()
  const { storeId, can } = useStore()
  const canEdit = can(Permissions.SETTINGS_EDIT)
  const run = useDestructiveAction()
  const remove = useDeleteSnippet(storeId)
  const [editing, setEditing] = useState<Editing>(null)

  const askToDelete = (snippet: StoreSnippetView): void => {
    run('DELETE_SNIPPET', {
      title: t('delete.title', { title: snippet.title }),
      description: t('delete.description'),
      confirmLabel: t('delete.confirm'),
      onConfirm: async () => {
        try {
          await remove.mutateAsync(snippet.id)
          toast.success(t('delete.done', { title: snippet.title }))
        } catch (error) {
          // The api answers a conflict when the closing or the away message uses the snippet
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
      {snippets.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <MessageSquareText aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
        </div>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
          {snippets.map(snippet => (
            <li
              key={snippet.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border p-4"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <h2 className="flex items-center gap-2 font-medium">
                  {snippet.title}
                  <code className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs font-normal">
                    /{snippet.shortcut}
                  </code>
                </h2>
                <span className="text-muted-foreground line-clamp-2 text-sm whitespace-pre-line">
                  {snippet.content}
                </span>
              </div>
              {canEdit ? (
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing({ kind: 'snippet', snippet })}
                  >
                    <Pencil aria-hidden className="size-4" />
                    {t('edit')}
                    <span className="sr-only"> {snippet.title}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => askToDelete(snippet)}
                  >
                    <Trash2 aria-hidden className="size-4" />
                    {t('delete.action')}
                    <span className="sr-only"> {snippet.title}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <SnippetDialog
          key={editing.kind === 'snippet' ? editing.snippet.id : 'new'}
          snippet={editing.kind === 'snippet' ? editing.snippet : null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
