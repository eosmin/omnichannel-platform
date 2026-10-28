import { checkCoverage, flattenKeys } from './frontend-coverage'

const steps = new Map([
  ['3.2', 'todo'],
  ['4.4', 'todo'],
  ['5.5', 'deferred (Phase 2)']
])

describe('flattenKeys', () => {
  it('walks nested groups and treats a path builder as one route', () => {
    const tree = {
      auth: { me: '/auth/me', byId: () => '/x' },
      returns: { reception: { scan: () => '' } }
    }
    expect(flattenKeys(tree)).toEqual(['auth.me', 'auth.byId', 'returns.reception.scan'])
  })
})

describe('checkCoverage', () => {
  it('passes when every exposed key is mapped to a step or to a reason', () => {
    const report = checkCoverage(
      ['a.one', 'a.two'],
      { 'a.one': { step: '3.2' }, 'a.two': { none: 'called by the worker only' } },
      steps
    )
    expect(report).toEqual({ unmapped: [], stale: [], invalid: [] })
  })

  it('reports what the backend exposes and the map does not know', () => {
    expect(checkCoverage(['a.one', 'a.two'], { 'a.one': { step: '3.2' } }, steps).unmapped).toEqual(
      ['a.two']
    )
  })

  it('reports what the map keeps after the backend dropped it', () => {
    expect(
      checkCoverage(['a.one'], { 'a.one': { step: '3.2' }, 'a.gone': { step: '3.2' } }, steps).stale
    ).toEqual(['a.gone'])
  })

  it('rejects a step the plan does not have and a "none" with no reason', () => {
    const report = checkCoverage(
      ['a.one', 'a.two'],
      { 'a.one': { step: '9.9' }, 'a.two': { none: '  ' } },
      steps
    )
    expect(report.invalid).toEqual(['a.one', 'a.two'])
  })

  it('rejects a step that is deferred, and an entry that is both or neither', () => {
    const report = checkCoverage(
      ['a.one', 'a.two', 'a.three'],
      {
        'a.one': { step: '5.5' },
        'a.two': { step: '3.2', none: 'both' },
        'a.three': {} as never // a shape the types forbid
      },
      steps
    )
    expect(report.invalid).toEqual(['a.one', 'a.three', 'a.two'])
  })

  it('does not take the name of an object member for a mapped route', () => {
    const report = checkCoverage(['toString', 'constructor'], {}, steps)
    expect(report.unmapped).toEqual(['constructor', 'toString'])
  })

  it('returns what it finds in order', () => {
    const report = checkCoverage(['b', 'a'], { z: { step: '3.2' }, y: { step: '3.2' } }, steps)
    expect(report.unmapped).toEqual(['a', 'b'])
    expect(report.stale).toEqual(['y', 'z'])
  })
})
