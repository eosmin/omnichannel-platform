import { redirect } from 'next/navigation'

import { AppPaths } from '@platform/api-client'

// The address of the store itself (`/s/<id>`) is not a page: it goes to the inbox, where the store starts. Without
// this it answered "page not found" for an address a person can reasonably type or trim from a link.
export default async function StoreRootPage({
  params
}: {
  params: Promise<{ storeId: string }>
}): Promise<never> {
  const { storeId } = await params
  redirect(AppPaths.store.inbox(storeId))
}
