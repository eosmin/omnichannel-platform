import type { ReactElement } from 'react'

import { StoreRootRedirect } from '../store-root-redirect'

// The address of the store itself (`/s/<id>`) is not a page: it answers "page not found" for an address a person can reasonably type or
// trim from a link, so it goes where the person starts in the store (see `StoreRootRedirect`).
export default function StoreRootPage(): ReactElement {
  return <StoreRootRedirect />
}
