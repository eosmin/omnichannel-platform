import { ExportStatus } from '@platform/core/queues'

import { exportContentType, exportView } from './exports.views'

const now = new Date('2026-11-01T12:00:00.000Z')
const row = {
  id: 'e1',
  type: 'customers',
  format: 'csv',
  status: ExportStatus.READY,
  key: 'stores/s/exports/e1/customers-2026-11-01.csv',
  rowCount: 3,
  error: null,
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  completedAt: new Date('2026-11-01T10:01:00.000Z'),
  expiresAt: new Date('2026-11-08T10:00:00.000Z')
}

describe('exportView', () => {
  it('names the file by the last part of its key and never shows the key', () => {
    const view = exportView(row, now)
    expect(view.filename).toBe('customers-2026-11-01.csv')
    expect(JSON.stringify(view)).not.toContain('stores/s')
  })

  it('reports a ready export past its date as expired, before the cleanup marks the row', () => {
    expect(
      exportView({ ...row, expiresAt: new Date('2026-11-01T11:59:59.000Z') }, now).status
    ).toBe(ExportStatus.EXPIRED)
    expect(exportView(row, now).status).toBe(ExportStatus.READY)
  })

  it('has no file name while the file is not made', () => {
    expect(exportView({ ...row, status: ExportStatus.PENDING, key: null }, now).filename).toBeNull()
  })
})

describe('exportContentType', () => {
  it('tells a zip from a csv', () => {
    expect(exportContentType('zip')).toBe('application/zip')
    expect(exportContentType('csv')).toContain('text/csv')
  })
})
