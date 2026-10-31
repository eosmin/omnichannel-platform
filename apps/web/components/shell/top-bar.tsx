import type { ReactElement, ReactNode } from 'react'

import type { AccountProfile } from '@platform/api-client'

import { StoreSwitcher } from './store-switcher'
import { UserMenu } from './user-menu'

// Brand, store switcher and the person's menu. An entry for a page appears here when the page
// exists (Inbox with Step 3.2, Customers with 3.3, Orders and Analytics with 4.4 and 5.2): a link to
// a page that is not built would be a 404.
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
    <header className="bg-background flex h-14 items-center gap-3 border-b px-4">
      <span className="font-semibold">{appTitle}</span>
      <StoreSwitcher memberships={profile.memberships} currentStoreId={currentStoreId} />
      {nav}
      <div className="flex-1" />
      <UserMenu name={profile.name} email={profile.email} />
    </header>
  )
}
