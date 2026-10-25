import { findMissingTranslations, flattenKeys } from './translations'

describe('flattenKeys', () => {
  it('turns nested messages into dotted keys, one per leaf', () => {
    expect(
      flattenKeys({
        common: { save: 'Guardar' },
        orders: { status: { OPEN: 'Abierta', CLOSED: 'Cerrada' }, total: 'Total' },
        list: ['a', 'b']
      }).sort()
    ).toEqual(['common.save', 'list', 'orders.status.CLOSED', 'orders.status.OPEN', 'orders.total'])
  })

  it('leaves out a key with no text, so that it counts as missing', () => {
    expect(flattenKeys({ a: '', b: { c: '  ', d: 'x' }, e: {}, f: null })).toEqual(['b.d'])
  })

  it('answers nothing for no messages', () => {
    expect(flattenKeys({})).toEqual([])
  })
})

describe('findMissingTranslations', () => {
  const en = { locale: 'en', keys: new Set(['a', 'b', 'errors.X']) }

  it('is clean when every locale has every key', () => {
    expect(
      findMissingTranslations(en, [{ locale: 'es', keys: new Set(en.keys) }], ['errors.X'])
    ).toEqual([])
  })

  it('names the keys a locale lacks', () => {
    expect(findMissingTranslations(en, [{ locale: 'es', keys: new Set(['a']) }], [])).toEqual([
      { locale: 'es', missing: ['b', 'errors.X'] }
    ])
  })

  it('names the keys the constants imply and the source lacks', () => {
    expect(findMissingTranslations(en, [], ['errors.X', 'errors.NEW'])).toEqual([
      { locale: 'en', missing: ['errors.NEW'] }
    ])
  })

  it('lists the keys of the constants in order', () => {
    expect(findMissingTranslations({ locale: 'en', keys: new Set() }, [], ['z', 'a'])).toEqual([
      { locale: 'en', missing: ['a', 'z'] }
    ])
  })

  it('does not complain about extra keys in a locale', () => {
    expect(
      findMissingTranslations(en, [{ locale: 'es', keys: new Set([...en.keys, 'extra']) }], [])
    ).toEqual([])
  })
})
