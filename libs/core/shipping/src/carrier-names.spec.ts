import { CarrierId } from '@platform/core/domain'
import { Locales } from '@platform/core/i18n'

import { carrierNameOf, carrierServiceLabelOf } from './carrier-names'

describe('carrierNameOf', () => {
  it('says the name of an official carrier in the language of the store', () => {
    const local = { id: CarrierId.LOCAL, name: 'Local courier' }
    expect(carrierNameOf(local, Locales.EN)).toBe('Local courier')
    expect(carrierNameOf(local, Locales.ES)).toBe('Mensajero local')
  })

  it('keeps the name a carrier declared when no message file has one', () => {
    expect(carrierNameOf({ id: CarrierId.FORZA, name: 'Forza' }, Locales.ES)).toBe('Forza')
  })
})

describe('carrierServiceLabelOf', () => {
  it('translates the service of an official carrier and keeps the label of one it does not know', () => {
    const local = { code: 'local', label: 'Local delivery' }
    expect(carrierServiceLabelOf(CarrierId.LOCAL, local, Locales.ES)).toBe('Entrega local')
    const unknown = { code: 'express', label: 'Express' }
    expect(carrierServiceLabelOf(CarrierId.LOCAL, unknown, Locales.ES)).toBe('Express')
  })

  it('never reads a service code as a path into the message file', () => {
    const odd = { code: '__proto__.constructor', label: 'Odd' }
    expect(carrierServiceLabelOf(CarrierId.LOCAL, odd, Locales.EN)).toBe('Odd')
  })
})
