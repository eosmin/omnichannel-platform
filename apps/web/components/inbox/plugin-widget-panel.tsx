'use client'

import { Puzzle, Settings, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react'

import {
  AppPaths,
  callPluginWidgetBridge,
  type PluginWidgetView,
  StoreSettingsSections
} from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { apiClient } from '../../lib/api'
import {
  connectWidget,
  type WidgetBridge,
  type WidgetStatus,
  WidgetStatuses,
  widgetFrameUrl
} from '../../lib/plugin-widget-bridge'
import { openWidgetSession } from '../../lib/plugin-widgets/use-plugin-widgets'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// What a widget with no height of its own gets, in pixels (TDD_10 §7 draws 400)
const DEFAULT_HEIGHT = 400

// One widget of a plugin in the agent sidebar (TDD_10 §7): a sandboxed frame of the plugin's own origin. The sandbox keeps
// `allow-same-origin` so the frame has its own origin and the page can tell who is talking; that is safe only because the
// api never lists a widget on one of our origins. The frame gets no url token and no API key: after it loads, the page
// gives it one port, and the session and every answer travel over that port.
export function PluginWidgetPanel({
  widget,
  conversationId
}: {
  widget: PluginWidgetView
  conversationId: string
}): ReactElement {
  const t = useTranslations('inbox.pluginWidgets')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const headingId = useId()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<WidgetBridge | null>(null)
  const [status, setStatus] = useState<WidgetStatus>(WidgetStatuses.CONNECTING)
  // A new key remounts the frame: the way to try again
  const [attempt, setAttempt] = useState(0)

  // Every load is a new document with no port: a frame that navigates itself is offered a new one
  const connect = useCallback((): void => {
    bridgeRef.current?.close()
    const frame = frameRef.current
    if (frame === null) return
    bridgeRef.current = connectWidget({
      frame,
      widgetOrigin: widget.origin,
      widgetId: widget.widgetId,
      conversationId,
      openSession: () =>
        openWidgetSession(storeId, widget.installationId, conversationId, widget.widgetId),
      call: (token, request) => callPluginWidgetBridge(apiClient, storeId, token, request),
      onStatus: setStatus
    })
  }, [conversationId, storeId, widget.installationId, widget.origin, widget.widgetId])

  useEffect(
    () => () => {
      bridgeRef.current?.close()
      bridgeRef.current = null
    },
    []
  )

  const retry = (): void => {
    bridgeRef.current?.close()
    bridgeRef.current = null
    setStatus(WidgetStatuses.CONNECTING)
    setAttempt(value => value + 1)
  }

  const broken = status === WidgetStatuses.UNRESPONSIVE || status === WidgetStatuses.FAILED
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2 rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Puzzle aria-hidden className="text-muted-foreground size-4 shrink-0" />
        <h2 id={headingId} className="min-w-0 flex-1 truncate text-sm font-medium">
          {widget.pluginName}
          <span className="text-muted-foreground font-normal"> · {widget.name}</span>
        </h2>
        {can(ClientPermissions.SETTINGS_VIEW) ? (
          <Button asChild size="icon" variant="ghost" className="size-7">
            <Link
              href={AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS)}
              aria-label={t('manage', { name: widget.pluginName })}
            >
              <Settings aria-hidden />
            </Link>
          </Button>
        ) : null}
      </div>
      <iframe
        key={attempt}
        ref={frameRef}
        src={widgetFrameUrl(widget.url, widget.widgetId, conversationId)}
        title={t('frameTitle', { name: widget.pluginName, widget: widget.name })}
        sandbox="allow-scripts allow-forms allow-same-origin"
        referrerPolicy="no-referrer"
        allow=""
        onLoad={connect}
        style={{ height: widget.height ?? DEFAULT_HEIGHT }}
        className={broken ? 'hidden' : 'w-full border-0'}
      />
      {status === WidgetStatuses.CONNECTING ? (
        <p role="status" className="text-muted-foreground px-3 pb-3 text-xs">
          {tAll('common.loading')}
        </p>
      ) : null}
      {broken ? (
        <div role="alert" className="flex flex-col items-start gap-2 px-3 pb-3 text-sm">
          <p className="flex items-start gap-2">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {status === WidgetStatuses.FAILED ? t('failed') : t('unresponsive')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
