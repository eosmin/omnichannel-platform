'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useId } from 'react'

import { metricMessageKey, ReportMetrics } from '@platform/core/analytics'

// The figures a file can hold (the whole-store metrics of the catalog), each one a checkbox. Shared by the export of the
// dashboard and the form of a scheduled report, so both offer the same list in the same order.
export function MetricPicker({
  value,
  onChange,
  disabled,
  invalid,
  errorId
}: {
  value: readonly string[]
  onChange: (next: string[]) => void
  disabled: boolean
  invalid: boolean
  errorId?: string
}): ReactElement {
  const t = useTranslations('analytics.metrics')
  const tPicker = useTranslations('analytics.picker')
  const idPrefix = useId()
  const toggle = (metric: string): void => {
    onChange(value.includes(metric) ? value.filter(item => item !== metric) : [...value, metric])
  }
  return (
    <fieldset
      className="flex flex-col gap-2 rounded-lg border p-3"
      disabled={disabled}
      aria-describedby={invalid ? errorId : undefined}
    >
      <legend className="px-1 text-sm font-medium">{tPicker('legend')}</legend>
      <div className="flex gap-3 text-xs">
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => onChange([...ReportMetrics])}
        >
          {tPicker('all')}
        </button>
        <button
          type="button"
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => onChange([])}
        >
          {tPicker('none')}
        </button>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {ReportMetrics.map(metric => {
          const id = `${idPrefix}-${metric}`
          return (
            <label key={metric} htmlFor={id} className="flex items-center gap-2 text-sm">
              <input
                id={id}
                type="checkbox"
                className="size-4"
                checked={value.includes(metric)}
                onChange={() => toggle(metric)}
              />
              {/* The key of a metric is its name with the dots out: a spec holds the messages to the catalog */}
              {t(metricMessageKey(metric) as 'orders_revenue')}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
