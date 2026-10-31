'use client'

import { ChevronDown, ChevronUp, EyeOff, Plus } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Permissions } from '@platform/core/auth'

import { type SidebarWidgetId, SidebarWidgets } from '../../lib/inbox/sidebar-widgets'
import { useHasRoomForSidebar } from '../../lib/inbox/use-is-wide'
import { useSidebarLayout } from '../../lib/inbox/use-sidebar-layout'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { CustomerPanel } from './customer-panel'
import { QuickActionsWidget } from './quick-actions-widget'
import { TeamStatusWidget } from './team-status-widget'
import { UnassignedQueueWidget } from './unassigned-queue-widget'

const BODIES: Record<SidebarWidgetId, () => ReactElement> = {
  [SidebarWidgets.QUICK_ACTIONS]: QuickActionsWidget,
  [SidebarWidgets.TEAM_STATUS]: TeamStatusWidget,
  [SidebarWidgets.UNASSIGNED_QUEUE]: UnassignedQueueWidget
}

// The right column of the inbox (TDD_09 §8): widgets the agent can reorder and hide, kept per user.
// Reordering is by buttons, so it works from the keyboard and on a touch screen with no dragging.
// It is drawn from the `xl` width; under it the room goes to the conversation.
export function InboxSidebar(): ReactElement | null {
  const t = useTranslations('inbox.sidebar')
  const { can } = useStore()
  const { layout, move, setHidden } = useSidebarLayout()
  const hasRoom = useHasRoomForSidebar()
  const { conversationId } = useParams<{ conversationId?: string }>()
  // Both widgets read what CONVERSATIONS_VIEW opens
  // Under the width the column is not drawn, and its widgets do not read anything
  if (!hasRoom || !can(Permissions.CONVERSATIONS_VIEW)) return null
  const shown = layout.filter(entry => !entry.isHidden)
  const hidden = layout.filter(entry => entry.isHidden)

  return (
    <aside
      aria-label={t('label')}
      className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-l p-3"
    >
      {conversationId === undefined ? null : <CustomerPanel conversationId={conversationId} />}
      {shown.map((entry, index) => {
        const Body = BODIES[entry.id]
        const title = t(`widgets.${entry.id}`)
        return (
          <section
            key={entry.id}
            aria-labelledby={`sidebar-${entry.id}`}
            className="flex flex-col gap-2"
          >
            <div className="flex items-center gap-1">
              <h2
                id={`sidebar-${entry.id}`}
                className="text-muted-foreground flex-1 text-xs font-semibold tracking-wide uppercase"
              >
                {title}
              </h2>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={index === 0}
                aria-label={t('moveUp', { widget: title })}
                onClick={() => move(entry.id, -1)}
              >
                <ChevronUp />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={index === shown.length - 1}
                aria-label={t('moveDown', { widget: title })}
                onClick={() => move(entry.id, 1)}
              >
                <ChevronDown />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={t('hide', { widget: title })}
                onClick={() => setHidden(entry.id, true)}
              >
                <EyeOff />
              </Button>
            </div>
            <Body />
          </section>
        )
      })}
      {hidden.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          {hidden.map(entry => (
            <Button
              key={entry.id}
              size="sm"
              variant="ghost"
              className="justify-start"
              onClick={() => setHidden(entry.id, false)}
            >
              <Plus />
              {t('add', { widget: t(`widgets.${entry.id}`) })}
            </Button>
          ))}
        </div>
      )}
    </aside>
  )
}
