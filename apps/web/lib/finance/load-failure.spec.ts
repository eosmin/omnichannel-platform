import { ApiError } from '@platform/api-client'

import { permissionRefusalOf } from './load-failure'

const refused = new ApiError(403, 'PERMISSION_DENIED', 'x', null, { required: ['inventory:view'] })
const refusedWithNone = new ApiError(403, 'PERMISSION_DENIED', 'x')
const network = new ApiError(0, 'NETWORK_UNAVAILABLE', 'x')

describe('permissionRefusalOf', () => {
  it('finds the refusal for lack of permission among the failed reads', () => {
    expect(permissionRefusalOf([null, refused])).toBe(refused)
    expect(permissionRefusalOf([network, refused])).toBe(refused)
  })

  it('is null when no read was refused for a permission it names', () => {
    expect(permissionRefusalOf([])).toBeNull()
    expect(permissionRefusalOf([null, null])).toBeNull()
    expect(permissionRefusalOf([network, refusedWithNone])).toBeNull()
  })
})
