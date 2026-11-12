import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

// The small mark of a customer flagged with caution (TDD_17 §4.16): it informs and never blocks. The reason is not here:
// it belongs to who may read customers (the profile and the create-order drawer show it).
export function CautionChip(): ReactElement {
  const t = useTranslations('customers.cautionFlag')
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/60 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <TriangleAlert aria-hidden className="size-3" />
      {t('chip')}
    </span>
  )
}
