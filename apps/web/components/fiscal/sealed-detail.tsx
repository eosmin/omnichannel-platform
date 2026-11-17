'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import type { FiscalDocumentDetailView } from '@platform/api-client'

import { useMoney, usePercentFigure } from '../../lib/finance/use-money'

// What a fiscal document was sealed with (Step 4B.9b-5c): the lines, the tax by rate and the issuer as it was when the document was made.
// It is read by the route of one document and is the evidence of what was said to the authority, so it is drawn as it is sealed: the
// amounts are the ones in the seal and nothing is added up again here, except that the api says whether its own lines agree with the total
// (`consistent`) and a document that does not agree says so above the figures. The address of the issuer is the provider's own list of
// keys and values: the screen knows no country and no provider.
export function SealedDetail({
  detail
}: {
  detail: FiscalDocumentDetailView['detail']
}): ReactElement {
  const t = useTranslations('finance.fiscal.sealed')
  const money = useMoney()
  const percent = usePercentFigure()
  const rate = (bps: number | null): string => (bps === null ? t('noRate') : `${percent(bps)} %`)
  return (
    <section className="flex flex-col gap-3" aria-label={t('title')} data-testid="fiscal-sealed">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      {detail.consistent ? null : (
        <p
          role="alert"
          data-testid="fiscal-sealed-inconsistent"
          className="border-destructive/40 bg-destructive/5 flex items-start gap-2 rounded-md border p-3 text-sm"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t('inconsistent')}
        </p>
      )}
      <p className="text-muted-foreground text-xs">
        {detail.pricesIncludeTax ? t('pricesIncludeTax') : t('pricesExcludeTax')}
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[32rem] text-sm" data-testid="fiscal-sealed-lines">
          <caption className="sr-only">{t('lines.caption')}</caption>
          <thead>
            <tr className="text-muted-foreground border-b text-xs">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('lines.description')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('lines.quantity')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('lines.unitPrice')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('lines.rate')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('lines.tax')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('lines.total')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {detail.lines.map((line, index) => (
              <tr key={`${line.description}-${String(index)}`} data-testid="fiscal-sealed-line">
                <td className="px-3 py-2 text-start">{line.description}</td>
                <td className="px-3 py-2 text-end tabular-nums">{line.quantity}</td>
                <td className="px-3 py-2 text-end tabular-nums">{money(line.unitPriceCents)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{rate(line.taxRateBps)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{money(line.taxCents)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{money(line.totalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl
        className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3"
        data-testid="fiscal-sealed-extras"
      >
        <Item label={t('shipping')}>{money(detail.shippingCents)}</Item>
        <Item label={t('shippingTax')}>{money(detail.shippingTaxCents)}</Item>
        <Item label={t('discount')}>{money(detail.discountCents)}</Item>
      </dl>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[22rem] text-sm" data-testid="fiscal-sealed-breakdown">
          <caption className="px-3 py-2 text-start text-sm font-medium">
            {t('breakdown.title')}
          </caption>
          <thead>
            <tr className="text-muted-foreground border-y text-xs">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('breakdown.rate')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('breakdown.base')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('breakdown.tax')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {detail.taxBreakdown.map((row, index) => (
              <tr
                key={`${String(row.taxRateBps)}-${String(index)}`}
                data-testid="fiscal-sealed-rate"
              >
                <td className="px-3 py-2 text-start tabular-nums">{rate(row.taxRateBps)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{money(row.baseCents)}</td>
                <td className="px-3 py-2 text-end tabular-nums">{money(row.taxCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="flex flex-col gap-1" aria-label={t('issuer.title')}>
        <h4 className="text-sm font-semibold">{t('issuer.title')}</h4>
        <dl
          className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2"
          data-testid="fiscal-sealed-issuer"
        >
          <Item label={t('issuer.legalName')}>{detail.issuer.legalName}</Item>
          <Item label={t('issuer.taxId')}>{detail.issuer.taxId}</Item>
          {detail.issuer.registrationId === null ? null : (
            <Item label={t('issuer.registrationId')}>{detail.issuer.registrationId}</Item>
          )}
          {detail.issuer.activityCode === null ? null : (
            <Item label={t('issuer.activityCode')}>{detail.issuer.activityCode}</Item>
          )}
          {detail.issuer.establishmentCode === null ? null : (
            <Item label={t('issuer.establishmentCode')}>{detail.issuer.establishmentCode}</Item>
          )}
          {Object.entries(detail.issuer.address).map(([key, value]) => (
            <Item key={key} label={key}>
              {value}
            </Item>
          ))}
        </dl>
      </section>
    </section>
  )
}

function Item({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
