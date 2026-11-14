'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

export interface TrendSeries {
  id: string
  label: string
  values: readonly number[]
  // The second line is dashed so two lines are told apart without their color
  dashed?: boolean
}

const WIDTH = 640
const HEIGHT = 200
const PAD = { left: 36, right: 8, top: 8, bottom: 20 }

// The daily volume as lines, drawn here: a chart library would cost the page more than the one chart needs. The picture is for
// the eyes; the same numbers are in a table that a screen reader reads (and that is the text of the chart for everyone else).
export function TrendChart({
  days,
  series,
  caption
}: {
  days: readonly string[]
  series: readonly TrendSeries[]
  caption: string
}): ReactElement {
  const t = useTranslations('analytics.chart')
  const format = useFormatter()
  // A whole number, so the label of the top gridline is the number the line reaches
  const max = Math.max(1, Math.ceil(Math.max(0, ...series.flatMap(line => [...line.values]))))
  const innerWidth = WIDTH - PAD.left - PAD.right
  const innerHeight = HEIGHT - PAD.top - PAD.bottom
  const x = (index: number): number =>
    PAD.left + (days.length <= 1 ? innerWidth / 2 : (index / (days.length - 1)) * innerWidth)
  const y = (value: number): number => PAD.top + innerHeight - (value / max) * innerHeight
  const label = (day: string): string =>
    format.dateTime(new Date(`${day}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    })
  const first = days[0]
  const last = days.at(-1)

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-sm font-medium">{caption}</figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={t('label', { caption })}
        className="h-auto w-full"
      >
        {[0, 1].map(step => (
          <g key={step}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={y(max * step)}
              y2={y(max * step)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 4}
              y={y(max * step) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {format.number(max * step)}
            </text>
          </g>
        ))}
        {series.map((line, lineIndex) => (
          <polyline
            key={line.id}
            fill="none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeDasharray={line.dashed === true ? '6 4' : undefined}
            className={lineIndex === 0 ? 'stroke-primary' : 'stroke-muted-foreground'}
            points={line.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
          />
        ))}
        {first === undefined || last === undefined ? null : (
          <>
            <text x={PAD.left} y={HEIGHT - 4} className="fill-muted-foreground text-[10px]">
              {label(first)}
            </text>
            <text
              x={WIDTH - PAD.right}
              y={HEIGHT - 4}
              textAnchor="end"
              className="fill-muted-foreground text-[10px]"
            >
              {label(last)}
            </text>
          </>
        )}
      </svg>
      <ul className="flex flex-wrap gap-4 text-xs">
        {series.map((line, lineIndex) => (
          <li key={line.id} className="flex items-center gap-1.5">
            <svg aria-hidden width="20" height="4" viewBox="0 0 20 4">
              <line
                x1="0"
                x2="20"
                y1="2"
                y2="2"
                strokeWidth="2"
                strokeDasharray={line.dashed === true ? '5 3' : undefined}
                className={lineIndex === 0 ? 'stroke-primary' : 'stroke-muted-foreground'}
              />
            </svg>
            {line.label}
          </li>
        ))}
      </ul>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('day')}</th>
            {series.map(line => (
              <th key={line.id} scope="col">
                {line.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.map((day, index) => (
            <tr key={day}>
              <th scope="row">{label(day)}</th>
              {series.map(line => (
                <td key={line.id}>{format.number(line.values[index] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}
