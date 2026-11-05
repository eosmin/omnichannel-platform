import type { ReactElement } from 'react'

import { InvitationCard } from '../invitation-card'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('invitation')

export default async function InvitationPage({
  params
}: {
  params: Promise<{ token: string }>
}): Promise<ReactElement> {
  const { token } = await params
  return <InvitationCard token={token} />
}
