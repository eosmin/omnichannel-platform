import { localCarrierPlugin } from '@platform/carriers/local'
import { LabelFormat } from '@platform/core/domain'

import { buildCarrierContext, buildCreateShipmentParams } from '../builders/carrier-plugin'

import { testCarrierPluginContract } from './carrier-plugin.contract'

// The official carriers each add their line beside their code; `local` has no recorded provider, so its fixtures
// are the data of a courier. It has no webhook and nothing secret
testCarrierPluginContract(() => localCarrierPlugin, {
  context: buildCarrierContext({
    credentials: { name: 'Juan Moto', phone: '71234567', prefix: 'JM' }
  }),
  createParams: buildCreateShipmentParams({ labelFormat: LabelFormat.PDF_100X150 }),
  secrets: []
})
