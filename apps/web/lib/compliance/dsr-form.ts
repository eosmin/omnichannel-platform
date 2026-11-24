import { z } from 'zod'

import type { ApiClient } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

// Settings → Data requests → the public form: the key the store gave to its form of data requests (Step 7.2-H2b, C1a). Kept with the page
// like `dsr-requests.ts`, and not in `@platform/api-client`, whose barrel the inbox loads whole.
//
// The key is public by design (it will travel in the address of the form), so the screen shows it whole to who holds the permission. What it
// never does is write it anywhere else: not a log line, not the audit log (the api keeps its last four characters there).
const formSchema = z.object({
  // null = the store takes no public requests
  key: z.string().nullable(),
  // false while the public flow is off: the key exists but the form takes nothing yet
  open: z.boolean()
})
export type DsrFormView = z.output<typeof formSchema>

export function fetchDsrForm(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<DsrFormView> {
  return client.request(ApiRoutes.compliance.dsrForm, { schema: formSchema, storeId, signal })
}

// Makes the first key (`current` null) or replaces the one the screen showed: the api changes it only if the store still holds `current`,
// and answers 409 if someone changed it first
export function makeDsrFormKey(
  client: ApiClient,
  storeId: string,
  current: string | null
): Promise<DsrFormView> {
  return client.request(ApiRoutes.compliance.dsrFormKey, {
    method: 'POST',
    body: { current },
    schema: formSchema,
    storeId
  })
}

export function revokeDsrFormKey(
  client: ApiClient,
  storeId: string,
  current: string | null
): Promise<DsrFormView> {
  return client.request(ApiRoutes.compliance.dsrFormKeyRevoke, {
    method: 'POST',
    body: { current },
    schema: formSchema,
    storeId
  })
}
