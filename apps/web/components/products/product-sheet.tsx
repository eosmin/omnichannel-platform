'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { useProduct } from '../../lib/products/use-products'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

import { ImagesTab } from './images-tab'
import { ProductForm } from './product-form'
import { VariantsTab } from './variants-tab'

// What the page asked the sheet to show: a form for a new product, or one product by its id
export type ProductTarget = { kind: 'new' } | { kind: 'product'; id: string }

const Sections = { DATA: 'data', IMAGES: 'images', VARIANTS: 'variants' } as const
type Section = (typeof Sections)[keyof typeof Sections]

// The panel of a product: Details, Pictures and Variants. It reads nothing while closed; it loads with the
// page's first click on a product, not with the page.
export function ProductSheet({
  target,
  onSelect,
  onClose
}: {
  target: ProductTarget | null
  onSelect: (target: ProductTarget | null) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('products.sheet')
  const tAll = useTranslations('products')
  // What was shown stays on the screen while the panel slides out
  const [last, setLast] = useState<ProductTarget | null>(target)
  if (target !== null && target !== last) setLast(target)
  const shown = target ?? last
  return (
    <Sheet open={target !== null} onOpenChange={open => (open ? undefined : onClose())}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{shown?.kind === 'new' ? t('newTitle') : t('editTitle')}</SheetTitle>
          <SheetDescription>{tAll('description')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {shown === null ? null : shown.kind === 'new' ? (
            <div className="flex flex-col gap-4">
              <ProductForm
                product={null}
                onCreated={id => onSelect({ kind: 'product', id })}
                onRemoved={onClose}
              />
              <p className="text-muted-foreground text-sm">{t('saveFirst')}</p>
            </div>
          ) : (
            <Body productId={shown.id} onRemoved={onClose} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Body({
  productId,
  onRemoved
}: {
  productId: string
  onRemoved: () => void
}): ReactElement {
  const t = useTranslations('products.sheet')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const product = useProduct(storeId, productId)
  const [section, setSection] = useState<Section>(Sections.DATA)

  if (product.isError && product.data === undefined) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{t('failed')}</p>
        <Button variant="outline" size="sm" onClick={() => void product.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </div>
    )
  }
  if (product.data === undefined) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {tAll('common.loading')}
      </p>
    )
  }
  const loaded = product.data
  return (
    <div className="flex flex-col gap-4">
      <Tabs value={section} onValueChange={value => setSection(value as Section)}>
        <TabsList aria-label={t('tabs.label')}>
          <TabsTrigger value={Sections.DATA}>{t('tabs.data')}</TabsTrigger>
          <TabsTrigger value={Sections.IMAGES}>{t('tabs.images')}</TabsTrigger>
          <TabsTrigger value={Sections.VARIANTS}>{t('tabs.variants')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {/* Kept mounted while another tab is shown: what was typed and not saved is not lost by looking at the
          pictures. It is keyed by the product only, so a refresh after a save does not rebuild it. */}
      <div hidden={section !== Sections.DATA}>
        <ProductForm
          key={loaded.id}
          product={loaded}
          onCreated={() => undefined}
          onRemoved={onRemoved}
        />
      </div>
      {section === Sections.IMAGES ? <ImagesTab product={loaded} /> : null}
      {section === Sections.VARIANTS ? <VariantsTab product={loaded} /> : null}
    </div>
  )
}
