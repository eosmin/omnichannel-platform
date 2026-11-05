import type { ReactElement } from 'react'

import { OrganizationProfilePage } from '../organization-profile-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('orgProfile')

export default function Page(): ReactElement {
  return <OrganizationProfilePage />
}
