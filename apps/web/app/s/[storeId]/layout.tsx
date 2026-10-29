import type { ReactElement, ReactNode } from 'react'

import { StoreShell } from '../store-shell'

export default async function StoreLayout({
  children,
  params
}: {
  children: ReactNode
  params: Promise<{ storeId: string }>
}): Promise<ReactElement> {
  const { storeId } = await params
  return <StoreShell storeId={storeId}>{children}</StoreShell>
}
