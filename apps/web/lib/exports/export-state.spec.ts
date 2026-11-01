import {
  exportStatusKey,
  exportTypeKey,
  hasPendingExport,
  isExportReady,
  mayOpenExports,
  UNKNOWN_EXPORT_LABEL
} from './export-state'

describe('export state', () => {
  it('keeps the key of a kind and a state the page knows', () => {
    expect(exportTypeKey('media_zip')).toBe('media_zip')
    expect(exportStatusKey('failed')).toBe('failed')
  })

  it('draws a kind or a state of a newer server as unknown', () => {
    expect(exportTypeKey('invoices')).toBe(UNKNOWN_EXPORT_LABEL)
    expect(exportStatusKey('paused')).toBe(UNKNOWN_EXPORT_LABEL)
  })

  it('offers the download only for a ready export', () => {
    expect(isExportReady({ status: 'ready' })).toBe(true)
    expect(isExportReady({ status: 'expired' })).toBe(false)
    expect(isExportReady({ status: 'pending' })).toBe(false)
  })

  it('opens the center for who may make any one kind of export', () => {
    expect(mayOpenExports(permission => permission === 'media:download_all')).toBe(true)
    expect(mayOpenExports(() => false)).toBe(false)
  })

  it('polls only while one export is pending', () => {
    expect(hasPendingExport([{ status: 'ready' }, { status: 'pending' }])).toBe(true)
    expect(hasPendingExport([{ status: 'ready' }, { status: 'failed' }])).toBe(false)
    expect(hasPendingExport([])).toBe(false)
  })
})
