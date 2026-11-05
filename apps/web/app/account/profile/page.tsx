import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { ProfileCard } from '../profile-card'

export const generateMetadata = pageTitle('accountProfile')

export default function ProfilePage(): ReactElement {
  return <ProfileCard />
}
