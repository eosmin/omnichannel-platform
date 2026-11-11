import { z } from 'zod'

import { CarrierCapability, CarrierId, LocalGuide } from '@platform/core/domain'
import {
  type CarrierConnectInput,
  type CarrierConnectResult,
  type CarrierPlugin,
  CarrierRejectedError,
  PluginTypes,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import { buildLocalLabelLayout } from './label-template'

// What the owner gives for an independent courier: a name, a phone, optional notes and the prefix of the guides
// (TDD_17 §4.2). Nothing is secret, so nothing is a credential.
export const localConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(1).max(30),
  // Blanks are no notes
  notes: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform(value => (value === '' ? undefined : value)),
  prefix: z.string().regex(LocalGuide.PREFIX_PATTERN)
})
export type LocalConnectionInput = z.infer<typeof localConnectionSchema>

// The one service of a courier that has no catalog; its label is the owner's to rename in Settings → Carriers
export const LOCAL_DEFAULT_SERVICE_CODE = 'local'

export const LOCAL_CARRIER_VERSION = '1.0.0'

// The `local` carrier: an independent courier with no API, no webhooks and no guide of its own. The core makes the
// guide (GuideSequence) and asks this plugin where things go on the label. Status is set by hand, so its catalog is
// empty (TDD_17 §4.17).
export const localCarrierPlugin: CarrierPlugin = {
  id: CarrierId.LOCAL,
  name: 'Local courier',
  version: LOCAL_CARRIER_VERSION,
  author: 'platform',
  type: PluginTypes.CARRIER,
  capabilities: [CarrierCapability.INTERNAL_GUIDE, CarrierCapability.COD],

  serviceCatalog: () => [
    { code: LOCAL_DEFAULT_SERVICE_CODE, label: 'Local delivery', defaultForNextDay: false }
  ],
  statusCatalog: () => [],

  connect: (input: CarrierConnectInput): Promise<CarrierConnectResult> => {
    const parsed = localConnectionSchema.safeParse(input.credentials)
    if (!parsed.success) {
      return Promise.reject(new CarrierRejectedError('The courier data is not valid'))
    }
    const { name, phone, notes, prefix } = parsed.data
    return Promise.resolve({
      displayName: name,
      credentials: {},
      metadata: { phone, prefix, ...(notes === undefined ? {} : { notes }) }
    })
  },
  disconnect: () => Promise.resolve(),
  // There is nothing to reach: a local connection is always as healthy as the platform
  healthCheck: () => Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() }),

  shipmentCreation: ShipmentCreationModes.INTERNAL,
  buildLabelLayout: buildLocalLabelLayout
}
