'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { PluginWidgetSettingsView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import {
  usePluginWidgetSettings,
  useSetPluginWidgetVisible
} from '../../lib/plugin-widgets/use-plugin-widgets'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// Settings → Plugins, widgets (TDD_10 §7): which of the panels the installed plugins draw in the agent sidebar the
// agents see in this store. Hiding one is a store-wide choice kept with the installation; it does not uninstall the plugin
// and does not change what the plugin may do. Nothing is drawn for a store whose plugins have no widget.
export function PluginWidgetsPanel(): ReactElement | null {
  const t = useTranslations('settings.plugins.widgets')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const widgets = usePluginWidgetSettings(storeId, true)
  if (widgets.isError) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void widgets.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      </section>
    )
  }
  if (widgets.data === undefined || widgets.data.length === 0) return null
  return (
    <section aria-labelledby="plugin-widgets-title" className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 id="plugin-widgets-title" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <ul aria-label={t('listLabel')} className="flex flex-col gap-3">
        {widgets.data.map(widget => (
          <WidgetRow key={`${widget.installationId}:${widget.widgetId}`} widget={widget} />
        ))}
      </ul>
    </section>
  )
}

function WidgetRow({ widget }: { widget: PluginWidgetSettingsView }): ReactElement {
  const t = useTranslations('settings.plugins.widgets')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const setVisible = useSetPluginWidgetVisible(storeId)
  const next = !widget.visible

  const change = (): void => {
    setVisible.mutate(
      { installationId: widget.installationId, widgetId: widget.widgetId, visible: next },
      {
        onSuccess: () =>
          toast.success(
            t(next ? 'shown' : 'hidden', { name: widget.name, plugin: widget.pluginName })
          ),
        onError: error => toast.error(errorText(error))
      }
    )
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="font-medium wrap-anywhere">{widget.name}</h3>
        <span className="text-muted-foreground text-sm wrap-anywhere">
          {t('from', { plugin: widget.pluginName })}
        </span>
        <span className="text-muted-foreground text-xs break-all">{widget.origin}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm">{widget.visible ? t('visible') : t('notVisible')}</span>
        {can(ClientPermissions.SETTINGS_MANAGE_PLUGINS) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={setVisible.isPending}
            onClick={change}
          >
            {widget.visible ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {widget.visible ? t('hide') : t('show')}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
