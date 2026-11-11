'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { CountLineView } from '@platform/api-client'

import type { ApplyRefusal } from '../../lib/counts/count-conflict'
import { useCodeText } from '../../lib/use-error-text'
import { Button } from '../ui/button'

const nameOf = (line: CountLineView | undefined): string =>
  line === undefined ? '' : [line.productName, line.variantName].filter(Boolean).join(' · ')

// Why the api refused to apply, line by line. Nothing was applied (all or none). The lines the stock cannot cover go back
// to counting with "Recount"; the ones the engine refused for another reason (a product no longer tracked, a warehouse
// switched off or unlinked since the count began) cannot be fixed from the sheet: the count is cancelled and made again.
export function CountApplyRefusal({
  refusal,
  lines,
  canReopen,
  reopening,
  onReopen
}: {
  refusal: ApplyRefusal
  lines: readonly CountLineView[]
  canReopen: boolean
  reopening: boolean
  onReopen: () => void
}): ReactElement {
  const t = useTranslations('counts.refusal')
  const codeText = useCodeText()
  const byId = new Map(lines.map(line => [line.id, line]))
  return (
    <section role="alert" className="border-destructive flex flex-col gap-3 rounded-lg border p-3">
      <h2 className="text-destructive flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden className="size-4" />
        {t(refusal.kind === 'short_stock' ? 'shortTitle' : 'refusedTitle')}
      </h2>
      <p className="text-sm">{t(refusal.kind === 'short_stock' ? 'shortBody' : 'refusedBody')}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {refusal.kind === 'short_stock'
          ? refusal.lines.map(item => (
              <li key={item.lineId}>
                <span className="font-medium">{nameOf(byId.get(item.lineId))}</span>
                {' — '}
                {item.onHand === null
                  ? t('shortLineUnknown', { requested: item.requested })
                  : t('shortLine', { requested: item.requested, onHand: item.onHand })}
              </li>
            ))
          : refusal.lines.map(item => (
              <li key={item.lineId}>
                <span className="font-medium">{nameOf(byId.get(item.lineId))}</span>
                {' — '}
                {codeText(item.code)}
              </li>
            ))}
      </ul>
      {refusal.kind === 'short_stock' && canReopen ? (
        <div>
          <Button variant="outline" size="sm" onClick={onReopen} busy={reopening}>
            {t('recount')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}
