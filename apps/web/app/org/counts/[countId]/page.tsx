import type { ReactElement } from 'react'

import { CountPage } from '../../count-page'
import { pageTitle } from '../../page-title'

export const generateMetadata = pageTitle('orgCounts')

export default async function OrgCountPage({
  params
}: {
  params: Promise<{ countId: string }>
}): Promise<ReactElement> {
  const { countId } = await params
  return <CountPage countId={countId} />
}
