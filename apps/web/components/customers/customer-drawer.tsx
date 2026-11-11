'use client'

import { Images } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useCustomer } from '../../lib/customers/use-customer-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

import { CustomerDetails } from './customer-details'
import { CustomerOrders } from './customer-orders'
import { CustomerTimeline } from './customer-timeline'
import { NoteBox } from './note-box'

// The gallery loads when it is first opened: it brings the lightbox and the grid, which the inbox
// (that draws the customer panel) does not need and its script budget does not have room for
const MediaGallery = dynamic(() => import('./media-gallery').then(module => module.MediaGallery), {
  ssr: false
})

const ACTIVITY = 'activity'
const ORDERS = 'orders'
type Section = typeof ACTIVITY | typeof ORDERS

// The customer profile (TDD_09 §6): a drawer over the page with the identity on the left and the
// activity on the right. It reads nothing while closed.
export function CustomerDrawer({
  customerId,
  isOpen,
  onClose
}: {
  customerId: string | null
  isOpen: boolean
  onClose: () => void
}): ReactElement {
  const t = useTranslations('customers.profile')
  return (
    <Sheet open={isOpen} onOpenChange={open => (open ? undefined : onClose())}>
      <SheetContent>
        {customerId === null ? null : (
          <Body key={customerId} customerId={customerId} onClose={onClose} />
        )}
        <SheetDescription className="sr-only">{t('description')}</SheetDescription>
      </SheetContent>
    </Sheet>
  )
}

function Body({ customerId, onClose }: { customerId: string; onClose: () => void }): ReactElement {
  const t = useTranslations('customers.profile')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const customer = useCustomer(storeId, customerId)
  const mayView = can(ClientPermissions.CUSTOMERS_VIEW)
  const mayOpenMedia = mayView && can(ClientPermissions.MEDIA_VIEW)
  const [isGalleryOpen, setGalleryOpen] = useState(false)
  const mayOpenOrders = mayView && can(ClientPermissions.ORDERS_VIEW)
  const [section, setSection] = useState<Section>(ACTIVITY)

  return (
    <>
      <SheetHeader>
        <SheetTitle>{t('title')}</SheetTitle>
      </SheetHeader>
      <div className="relative grid min-h-0 flex-1 gap-6 overflow-y-auto overscroll-contain p-4 md:grid-cols-[260px_1fr]">
        {!mayView ? (
          <p role="alert" className="text-sm md:col-span-2">
            {t('noAccess')}
          </p>
        ) : customer.isError && customer.data === undefined ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-sm md:col-span-2">
            <p>{t('failed')}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void customer.refetch()}
            >
              {tAll('common.tryAgain')}
            </Button>
          </div>
        ) : customer.data === undefined ? (
          <p role="status" className="text-muted-foreground text-sm md:col-span-2">
            {tAll('common.loading')}
          </p>
        ) : (
          <>
            <CustomerDetails customer={customer.data} editable />
            <div className="flex flex-col gap-6">
              {mayOpenMedia ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => setGalleryOpen(true)}
                >
                  <Images aria-hidden />
                  {t('media')}
                </Button>
              ) : null}
              {can(ClientPermissions.CUSTOMERS_EDIT) ? <NoteBox customerId={customerId} /> : null}
              {mayOpenOrders ? (
                <Tabs value={section} onValueChange={value => setSection(value as Section)}>
                  <TabsList aria-label={t('sectionLabel')}>
                    <TabsTrigger value={ACTIVITY}>{t('sections.activity')}</TabsTrigger>
                    <TabsTrigger value={ORDERS}>{t('sections.orders')}</TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              {mayOpenOrders && section === ORDERS ? (
                <CustomerOrders customerId={customerId} onNavigate={onClose} />
              ) : (
                <CustomerTimeline customerId={customerId} onNavigate={onClose} />
              )}
            </div>
          </>
        )}
      </div>
      {mayOpenMedia && isGalleryOpen ? (
        <MediaGallery customerId={customerId} isOpen onClose={() => setGalleryOpen(false)} />
      ) : null}
    </>
  )
}
