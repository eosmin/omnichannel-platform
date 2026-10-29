import { redirect } from 'next/navigation'

import { AppPaths } from '@platform/api-client'

export default function OrgPage(): never {
  redirect(AppPaths.org.stores)
}
