'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { serializeFrameOrigins } from '../../lib/plugin-frames'
import {
  clearReloadMark,
  documentFrameOrigins,
  framesAllowed,
  readFrameCookie,
  shouldReloadFor,
  writeFrameCookie
} from '../../lib/plugin-frames-client'
import { usePluginWidgets } from '../../lib/plugin-widgets/use-plugin-widgets'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { PluginWidgetPanel } from './plugin-widget-panel'

// sessionStorage can throw (blocked site data): the page then never reloads for a new origin and says so
function tabStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

// The widgets of the plugins the store installed, under the customer in the right column (TDD_10 §7). Loaded on its own
// (lazy-dialogs): the inbox has a script budget and a store with no widgets never needs any of this.
//
// A frame can load only from an origin the page's policy names (`frame-src`), and the policy is made per request by the
// proxy from a cookie that this page writes. So the first time a store has a widget origin the document does not know,
// the page writes the cookie and reloads once; after that the frames load.
export function PluginWidgetsSection({
  conversationId
}: {
  conversationId: string
}): ReactElement | null {
  const t = useTranslations('inbox.pluginWidgets')
  const { storeId, can } = useStore()
  const widgets = usePluginWidgets(storeId, can(ClientPermissions.CONVERSATIONS_VIEW))
  const list = widgets.data
  const origins = useMemo(() => [...new Set((list ?? []).map(widget => widget.origin))], [list])
  // What this document's policy allows is fixed when it loads, whatever the cookie says later
  const [allowed] = useState(() => documentFrameOrigins(document))
  // A widget draws when its own origin is allowed; the ones that are not wait for the reload, or are said to be blocked
  const shown = (list ?? []).filter(widget => allowed.includes(widget.origin))
  const covered = framesAllowed(allowed, origins)
  const [blocked, setBlocked] = useState(false)
  // The page reloads by itself only the first time it learns the widgets; a later change (a plugin installed while the agent
  // works) never throws away a half-written reply: the agent is offered the reload instead
  const decided = useRef(false)

  useEffect(() => {
    if (list === undefined) return
    const sorted = [...origins].sort()
    if (
      serializeFrameOrigins(readFrameCookie(document, storeId).sort()) !==
      serializeFrameOrigins(sorted)
    ) {
      writeFrameCookie(document, storeId, sorted, window.location.protocol === 'https:')
    }
    if (framesAllowed(allowed, origins)) {
      clearReloadMark(tabStorage(), storeId)
      return
    }
    if (decided.current) {
      setBlocked(true)
      return
    }
    decided.current = true
    if (shouldReloadFor(tabStorage(), storeId, origins)) window.location.reload()
    else setBlocked(true)
  }, [allowed, list, origins, storeId])

  if (list === undefined || list.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {shown.map(widget => (
        <PluginWidgetPanel
          key={`${widget.installationId}:${widget.widgetId}:${conversationId}`}
          widget={widget}
          conversationId={conversationId}
        />
      ))}
      {covered ? null : blocked ? (
        <div role="alert" className="text-muted-foreground flex flex-col items-start gap-2 text-sm">
          <p>{t('blocked')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t('reload')}
          </Button>
        </div>
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          {t('preparing')}
        </p>
      )}
    </div>
  )
}
