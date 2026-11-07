import Link from 'next/link'
import type { ReactElement, ReactNode } from 'react'

import { type AccountProfile, AppPaths } from '@platform/api-client'

import { NotificationCenter } from './notification-center'
import { StoreSwitcher } from './store-switcher'
import { UserMenu } from './user-menu'

// Brand, store switcher and the person's menu. The brand leads home: "/" goes to the store used
// last. An entry for a page appears here when the page exists (Inbox with Step 3.2, Customers with
// 3.3, Orders and Analytics with 4.4 and 5.2): a link to a page that is not built would be a 404.
export function TopBar({
  profile,
  currentStoreId,
  appTitle,
  nav
}: {
  profile: AccountProfile
  currentStoreId: string | null
  appTitle: string
  // The links to the pages of the area, when it has them
  nav?: ReactNode
}): ReactElement {
  return (
    // What does not fit gives way from the left: the title shortens, the store name shortens, the links
    // scroll on their own. The bell and the account menu never leave the window (the inbox clips the
    // page, so a control pushed out would be out of reach)
    <header className="bg-background flex h-14 items-center gap-3 border-b px-4">
      {/* On a phone the title leaves the bar (it stays for a screen reader) so that the store name can be read */}
      <Link
        href={AppPaths.home}
        className="min-w-0 shrink-[2] truncate rounded-sm font-semibold max-md:sr-only max-md:focus-visible:not-sr-only"
      >
        {appTitle}
      </Link>
      <div className="min-w-28 shrink">
        <StoreSwitcher
          memberships={profile.memberships}
          suspendedStores={profile.suspendedStores}
          currentStoreId={currentStoreId}
        />
      </div>
      {nav}
      <div className="flex-1" />
      <div className="flex shrink-0 items-center gap-1">
        {currentStoreId !== null && <NotificationCenter storeId={currentStoreId} />}
        <UserMenu name={profile.name} email={profile.email} />
      </div>
    </header>
  )
}
