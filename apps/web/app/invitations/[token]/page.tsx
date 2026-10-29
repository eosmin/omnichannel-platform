import type { ReactElement } from 'react'

import { InvitationCard } from '../invitation-card'

export default async function InvitationPage({
  params
}: {
  params: Promise<{ token: string }>
}): Promise<ReactElement> {
  const { token } = await params
  return <InvitationCard token={token} />
}
