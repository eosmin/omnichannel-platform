import type { ReactElement } from 'react'

import { pageTitle } from '../../lib/page-titles'

import { OrgHome } from './org-shell'

export const generateMetadata = pageTitle('org')

export default function OrgPage(): ReactElement {
  return <OrgHome />
}
