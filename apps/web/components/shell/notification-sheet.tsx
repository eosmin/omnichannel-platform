'use client'

import type { ReactElement } from 'react'

import { Sheet, SheetContent } from '../ui/sheet'

import { NotificationPanel } from './notification-panel'

// The panel that slides over the page when the bell is pressed, downloaded the first time (`NotificationCenter`)
export default function NotificationSheet({
  storeId,
  open,
  onOpenChange,
  unreadCount
}: {
  storeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  unreadCount: number
}): ReactElement {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="md:w-[28rem]">
        <NotificationPanel
          storeId={storeId}
          open={open}
          unreadCount={unreadCount}
          onNavigate={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  )
}
