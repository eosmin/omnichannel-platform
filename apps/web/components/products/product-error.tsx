'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ProductLimits } from '@platform/core/domain'

import { conflictOf } from '../../lib/products/product-conflict'
import { MutationError } from '../customers/mutation-error'

// The reason a catalog change was refused. The api answers every conflict with the same code and says which
// in the metadata: those have their own words here; anything else is the text of its error code.
export function ProductError({ error }: { error: Error | null }): ReactElement | null {
  const t = useTranslations('products.conflicts')
  const conflict = conflictOf(error)
  if (conflict === null) return <MutationError error={error} />
  return (
    <p role="alert" className="text-destructive text-sm">
      {t(conflict, { max: ProductLimits.MAX_VARIANTS_PER_PRODUCT })}
    </p>
  )
}
