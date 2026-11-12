import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  CodStatus,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportErrors,
  RemittanceImportLimits,
  RemittanceLineOutcome,
  RemittanceStatus,
  ShipmentStatus
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { JobNames, QueueNames } from '@platform/core/queues'
import { MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { createCarrierConnection, createShipment } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const OK = HttpStatusCodes.OK
const CREATED = HttpStatusCodes.CREATED
const NO_CONTENT = HttpStatusCodes.NO_CONTENT
const BAD_REQUEST = HttpStatusCodes.BAD_REQUEST
const FORBIDDEN = HttpStatusCodes.FORBIDDEN
const NOT_FOUND = HttpStatusCodes.NOT_FOUND
const CONFLICT = HttpStatusCodes.CONFLICT
const TOO_LARGE = HttpStatusCodes.PAYLOAD_TOO_LARGE

interface DraftBody {
  id: string
  status: RemittanceStatus
  reference: string | null
  receivedOn: string | null
  importProfileId: string | null
  sourceMediaId: string | null
  totals: { expectedCents: number; reportedCents: number; feeCents: number }
  lines: { guideNumber: string; outcome: RemittanceLineOutcome; row?: number }[]
}
interface ErrorBody {
  error: {
    code: string
    metadata?: {
      errorCount: number
      errors: { row: number; field: string | null; code: string; value: string | null }[]
    }
  }
}

describe('Importing the settlement file of a carrier (TDD_17 §4.15, Step 4.13 PR C)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let connectionId = ''
  const scans = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING)).useValue(scans)
    )
    ctx = await seedTestContext(owner, app, prefix)
    connectionId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'IM' }))
      .id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(() => {
    scans.jobs.length = 0
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)

  const RICH = {
    guideNumber: 'Guia',
    amount: 'Monto',
    date: 'Fecha',
    reference: 'Liquidacion',
    fee: 'Comision'
  }
  const profileBody = (over: Record<string, unknown> = {}) => ({
    connectionId,
    name: `Layout ${Math.random().toString(36).slice(2, 8)}`,
    columns: { guideNumber: 'Guia', amount: 'Monto' },
    ...over
  })
  async function profile(over: Record<string, unknown> = {}): Promise<string> {
    const made = await asAdmin().post(ApiRoutes.remittances.importProfiles).send(profileBody(over))
    expect(made.status).toBe(CREATED)
    return (made.body as { id: string }).id
  }
  const importUrl = (profileId: string, connection = connectionId) =>
    `${ApiRoutes.remittances.imports}?connectionId=${connection}&profileId=${profileId}`
  const sendFile = (profileId: string, text: string | Buffer, type = 'text/csv', who = asAdmin) =>
    who().post(importUrl(profileId)).set('Content-Type', type).send(text)
  const pending = (guideNumber: string, expected: number) =>
    createShipment(owner, {
      storeId: ctx.storeA.id,
      connectionId,
      guideNumber,
      status: ShipmentStatus.DELIVERED,
      codAmountCents: expected,
      codExpectedCents: expected,
      codStatus: CodStatus.PENDING_REMITTANCE,
      deliveredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    })
  const countsOf = async () => ({
    remittances: await owner.codRemittance.count({ where: { storeId: ctx.storeA.id } }),
    files: await owner.media.count({
      where: { storeId: ctx.storeA.id, purpose: MediaPurpose.REMITTANCE_FILE }
    })
  })

  describe('the profiles', () => {
    it('saves a mapping per connection, lists it, changes it and deletes it', async () => {
      const id = await profile({ name: 'Courier layout' })
      const list = await asViewer().get(
        `${ApiRoutes.remittances.importProfiles}?connectionId=${connectionId}`
      )
      expect(list.status).toBe(OK)
      expect(
        (list.body as { id: string; name: string; delimiter: string }[]).find(
          item => item.id === id
        )
      ).toMatchObject({
        name: 'Courier layout',
        delimiter: ',',
        hasHeader: true,
        decimalSeparator: '.',
        dateFormat: 'yyyy-MM-dd'
      })
      const changed = await asAdmin()
        .patch(ApiRoutes.remittances.importProfileById(id))
        .send({ delimiter: ';', decimalSeparator: ',', name: 'Courier layout 2' })
      expect(changed.status).toBe(OK)
      expect(changed.body).toMatchObject({
        delimiter: ';',
        decimalSeparator: ',',
        name: 'Courier layout 2'
      })
      expect((await asAdmin().delete(ApiRoutes.remittances.importProfileById(id))).status).toBe(
        NO_CONTENT
      )
      expect((await asAdmin().delete(ApiRoutes.remittances.importProfileById(id))).status).toBe(
        NOT_FOUND
      )
    })

    it('refuses a second profile with the same name for the connection, and a connection of another store', async () => {
      await profile({ name: 'Same name' })
      const twice = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ name: 'Same name' }))
      expect(twice.status).toBe(CONFLICT)
      const foreign = await createCarrierConnection(owner, { storeId: ctx.storeB.id })
      const other = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ connectionId: foreign.id }))
      expect(other.status).toBe(NOT_FOUND)
    })

    it('refuses a mapping by header name for a file that has no header, and a field it does not know', async () => {
      const noHeader = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ hasHeader: false }))
      expect(noHeader.status).toBe(BAD_REQUEST)
      const positions = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ hasHeader: false, columns: { guideNumber: 0, amount: 1 } }))
      expect(positions.status).toBe(CREATED)
      const stray = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ storeId: ctx.storeB.id }))
      expect(stray.status).toBe(BAD_REQUEST)
      const delimiter = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ delimiter: '|' }))
      expect(delimiter.status).toBe(BAD_REQUEST)
      const id = await profile()
      const later = await asAdmin()
        .patch(ApiRoutes.remittances.importProfileById(id))
        .send({ hasHeader: false })
      expect(later.status).toBe(BAD_REQUEST)
      const comma = await asAdmin()
        .patch(ApiRoutes.remittances.importProfileById(id))
        .send({ decimalSeparator: ',' })
      expect(comma.status).toBe(BAD_REQUEST)
      const same = await asAdmin()
        .post(ApiRoutes.remittances.importProfiles)
        .send(profileBody({ delimiter: ',', decimalSeparator: ',' }))
      expect(same.status).toBe(BAD_REQUEST)
    })

    it('lets the remittances that it read keep their lines, and the id of how they were read, when it is deleted', async () => {
      const id = await profile()
      await pending('PRO-DEL-1', 500)
      const made = await sendFile(id, 'Guia,Monto\nPRO-DEL-1,5.00\n')
      expect(made.status).toBe(CREATED)
      const draft = made.body as DraftBody
      expect(draft.importProfileId).toBe(id)
      expect((await asAdmin().delete(ApiRoutes.remittances.importProfileById(id))).status).toBe(
        NO_CONTENT
      )
      const row = await owner.codRemittance.findUniqueOrThrow({
        where: { id: draft.id },
        include: { lines: true }
      })
      // The id stays as the evidence of how the file was read; the profile itself is gone
      expect(row.importProfileId).toBe(id)
      expect(await owner.remittanceImportProfile.count({ where: { id } })).toBe(0)
      expect(row.lines).toHaveLength(1)
    })
  })

  describe('the preview of the mapper', () => {
    it('reads a sample with the mapping being tried and writes nothing', async () => {
      const before = await countsOf()
      const preview = await asAdmin()
        .post(ApiRoutes.remittances.importPreview)
        .send({
          text: 'Guia;Monto;Fecha\nG-1;10,50;12/11/2026\nG-2;x;12/11/2026\n',
          profile: {
            delimiter: RemittanceDelimiters.SEMICOLON,
            decimalSeparator: RemittanceDecimalSeparators.COMMA,
            dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH,
            columns: { guideNumber: 'Guia', amount: 'Monto', date: 'Fecha' }
          }
        })
      expect(preview.status).toBe(OK)
      expect(preview.body).toMatchObject({
        headers: ['Guia', 'Monto', 'Fecha'],
        rowCount: 2,
        lines: [{ guideNumber: 'G-1', reportedCents: 1050, row: 2 }],
        errorCount: 1,
        errors: [
          { row: 3, field: 'amount', code: RemittanceImportErrors.INVALID_AMOUNT, value: 'x' }
        ],
        receivedOn: '2026-11-12'
      })
      expect(await countsOf()).toEqual(before)
    })

    it('refuses a sample larger than a preview takes, a missing mapping and a viewer', async () => {
      const big = 'x'.repeat(RemittanceImportLimits.PREVIEW_MAX_BYTES + 1)
      const body = { text: big, profile: { columns: { guideNumber: 'a', amount: 'b' } } }
      expect((await asAdmin().post(ApiRoutes.remittances.importPreview).send(body)).status).toBe(
        BAD_REQUEST
      )
      expect(
        (await asAdmin().post(ApiRoutes.remittances.importPreview).send({ text: 'a' })).status
      ).toBe(BAD_REQUEST)
      const ok = { text: 'a\n1', profile: { columns: { guideNumber: 'a', amount: 'a' } } }
      expect((await asViewer().post(ApiRoutes.remittances.importPreview).send(ok)).status).toBe(
        FORBIDDEN
      )
    })
  })

  describe('the import of a file', () => {
    it('makes a draft whose lines carry every outcome, keeps the file and queues its scan', async () => {
      const id = await profile({ columns: RICH })
      await pending('IMP-MATCH', 1000)
      await pending('IMP-DIFF', 2000)
      const csv = [
        'Liquidacion,Guia,Monto,Fecha,Comision',
        'LIQ-77,IMP-MATCH,10.00,2026-11-12,0.50',
        'LIQ-77,IMP-DIFF,18.00,2026-11-12,',
        'LIQ-77,IMP-NOPE,3.00,2026-11-12,',
        ''
      ].join('\r\n')
      const made = await sendFile(id, csv, 'text/csv; charset=utf-8')
      expect(made.status).toBe(CREATED)
      const draft = made.body as DraftBody
      expect(draft).toMatchObject({
        status: RemittanceStatus.DRAFT,
        reference: 'LIQ-77',
        receivedOn: '2026-11-12',
        importProfileId: id,
        sourceMediaId: expect.any(String) as string
      })
      expect(draft.lines.map(line => [line.guideNumber, line.outcome])).toEqual([
        ['IMP-MATCH', RemittanceLineOutcome.MATCHED],
        ['IMP-DIFF', RemittanceLineOutcome.AMOUNT_DIFFERS],
        ['IMP-NOPE', RemittanceLineOutcome.NOT_FOUND]
      ])
      expect(draft.totals).toMatchObject({ expectedCents: 3000, reportedCents: 2800, feeCents: 50 })

      const stored = await owner.codRemittance.findUniqueOrThrow({ where: { id: draft.id } })
      const media = await owner.media.findUniqueOrThrow({
        where: { id: stored.sourceMediaId ?? '' }
      })
      expect(media).toMatchObject({
        purpose: MediaPurpose.REMITTANCE_FILE,
        storeId: ctx.storeA.id,
        contentType: 'text/csv',
        status: 'pending',
        fileSize: Buffer.byteLength(csv)
      })
      expect(await app.get(StorageService).head(media.key)).not.toBeNull()
      expect(scans.jobs).toEqual([
        {
          name: JobNames.SCAN_FILE,
          data: { mediaId: media.id },
          opts: { jobId: `${JobNames.SCAN_FILE}-${media.id}` }
        }
      ])
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.REMITTANCE_IMPORTED,
        resourceId: draft.id,
        resourceType: 'remittance'
      })
      expect(entry?.metadata).toMatchObject({ profileId: id, rows: 3, mediaId: media.id })
      // Nothing was settled: a shipment moves only when the draft is confirmed
      const shipment = await owner.shipment.findFirstOrThrow({
        where: { guideNumber: 'IMP-MATCH' }
      })
      expect(shipment.codStatus).toBe(CodStatus.PENDING_REMITTANCE)
    })

    it('removes the file with the draft that was made of it', async () => {
      const id = await profile()
      const made = await sendFile(id, 'Guia,Monto\nGONE-1,1.00\n')
      const draft = made.body as DraftBody
      const stored = await owner.codRemittance.findUniqueOrThrow({ where: { id: draft.id } })
      const media = await owner.media.findUniqueOrThrow({
        where: { id: stored.sourceMediaId ?? '' }
      })
      expect((await asAdmin().delete(ApiRoutes.remittances.byId(draft.id))).status).toBe(NO_CONTENT)
      expect(await owner.media.count({ where: { id: media.id } })).toBe(0)
      expect(await app.get(StorageService).head(media.key)).toBeNull()
    })

    it('keeps the file as it was sent, with its BOM, and reads it without the BOM', async () => {
      const id = await profile()
      const sent = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('Guia,Monto,\nBOM-1,1.00,\n')
      ])
      const made = await sendFile(id, sent)
      expect(made.status).toBe(CREATED)
      expect((made.body as DraftBody).lines).toHaveLength(1)
      const stored = await owner.codRemittance.findUniqueOrThrow({
        where: { id: (made.body as DraftBody).id }
      })
      const media = await owner.media.findUniqueOrThrow({
        where: { id: stored.sourceMediaId ?? '' }
      })
      expect(media.fileSize).toBe(sent.length)
    })

    it('reads a table pasted with tabs as text/plain', async () => {
      const id = await profile({
        delimiter: RemittanceDelimiters.TAB,
        columns: { guideNumber: 'Guia', amount: 'Monto' }
      })
      await pending('IMP-TAB', 700)
      const made = await sendFile(id, 'Guia\tMonto\nIMP-TAB\t7.00\n', 'text/plain')
      expect(made.status).toBe(CREATED)
      expect((made.body as DraftBody).lines[0]?.outcome).toBe(RemittanceLineOutcome.MATCHED)
      const media = await owner.media.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, filename: { endsWith: '.tsv' } }
      })
      expect(media.contentType).toBe('text/tab-separated-values')
    })

    it('refuses a file with an unreadable cell, says which, and makes nothing of it', async () => {
      const id = await profile()
      const before = await countsOf()
      const bad = await sendFile(id, 'Guia,Monto\nG-1,5.00\nG-2,abc\nG-3,"1,234.50"\n,\n')
      expect(bad.status).toBe(BAD_REQUEST)
      const body = bad.body as ErrorBody
      expect(body.error.code).toBe(ErrorCodes.REMITTANCE_IMPORT_INVALID)
      expect(body.error.metadata?.errorCount).toBe(2)
      expect(body.error.metadata?.errors).toEqual([
        { row: 3, field: 'amount', code: RemittanceImportErrors.INVALID_AMOUNT, value: 'abc' },
        { row: 4, field: 'amount', code: RemittanceImportErrors.INVALID_AMOUNT, value: '1,234.50' }
      ])
      expect(await countsOf()).toEqual(before)
      expect(scans.jobs).toHaveLength(0)
    })

    it('refuses a row with an unquoted delimiter in a cell, which moved the columns', async () => {
      const id = await profile()
      const refused = await sendFile(id, 'Guia,Monto\nG-1,5.00\nG-2,12,50\n')
      expect(refused.status).toBe(BAD_REQUEST)
      expect((refused.body as ErrorBody).error.metadata?.errors).toEqual([
        { row: 3, field: null, code: RemittanceImportErrors.ROW_TOO_WIDE, value: '3' }
      ])
    })

    it('refuses a profile that was edited into one that breaks the rules, with a clean answer', async () => {
      const id = await profile()
      await owner.remittanceImportProfile.update({
        where: { id },
        data: { columns: { guideNumber: { nope: true }, amount: 'Monto' } }
      })
      const refused = await sendFile(id, 'Guia,Monto\nX,1\n')
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('refuses a column that the file does not have, an empty file and a body that is not text', async () => {
      const id = await profile()
      const missing = await sendFile(id, 'A,B\n1,2\n')
      expect((missing.body as ErrorBody).error.metadata?.errors[0]).toMatchObject({
        code: RemittanceImportErrors.COLUMN_NOT_FOUND
      })
      expect((await sendFile(id, '')).status).toBe(BAD_REQUEST)
      const json = await asAdmin().post(importUrl(id)).send({ text: 'Guia,Monto' })
      expect(json.status).toBe(BAD_REQUEST)
      expect((json.body as ErrorBody).error.code).toBe(ErrorCodes.REMITTANCE_IMPORT_INVALID)
      const notUtf8 = await sendFile(id, Buffer.from([0xff, 0xfe, 0x41, 0x0a]))
      expect(notUtf8.status).toBe(BAD_REQUEST)
    })

    it('refuses a file larger than five megabytes', async () => {
      const id = await profile()
      const huge = Buffer.alloc(RemittanceImportLimits.MAX_BYTES + 1, 0x61)
      const refused = await sendFile(id, huge)
      expect(refused.status).toBe(TOO_LARGE)
    })

    it('takes a file of five thousand rows, and refuses one of more', async () => {
      const id = await profile()
      const rows = (count: number) =>
        Array.from({ length: count }, (_, index) => `FULL-${index},1.00`).join('\n')
      const made = await sendFile(id, `Guia,Monto\n${rows(RemittanceImportLimits.MAX_ROWS)}\n`)
      expect(made.status).toBe(CREATED)
      expect((made.body as DraftBody).lines).toHaveLength(RemittanceImportLimits.MAX_ROWS)
      const over = await sendFile(id, `Guia,Monto\n${rows(RemittanceImportLimits.MAX_ROWS + 1)}\n`)
      expect(over.status).toBe(BAD_REQUEST)
      expect((over.body as ErrorBody).error.metadata?.errors[0]?.code).toBe(
        RemittanceImportErrors.TOO_MANY_ROWS
      )
    })

    it('does not use a profile of another connection or store, nor a connection of another store', async () => {
      const mine = await profile()
      const otherConnection = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        prefix: 'IO'
      })
      const crossed = await asAdmin()
        .post(importUrl(mine, otherConnection.id))
        .set('Content-Type', 'text/csv')
        .send('Guia,Monto\nX,1\n')
      expect(crossed.status).toBe(NOT_FOUND)
      const foreign = await createCarrierConnection(owner, { storeId: ctx.storeB.id })
      const theirs = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.remittances.importProfiles)
        .send({
          connectionId: foreign.id,
          name: 'Theirs',
          columns: { guideNumber: 'Guia', amount: 'Monto' }
        })
      const theirId = (theirs.body as { id: string }).id
      const stolen = await sendFile(theirId, 'Guia,Monto\nX,1\n')
      expect(stolen.status).toBe(NOT_FOUND)
      const listed = await asAdmin().get(ApiRoutes.remittances.importProfiles)
      expect((listed.body as { id: string }[]).some(item => item.id === theirId)).toBe(false)
    })

    it('lets only who manages remittances import or save a profile', async () => {
      const id = await profile()
      for (const who of [asViewer, asAgent]) {
        expect((await sendFile(id, 'Guia,Monto\nX,1\n', 'text/csv', who)).status).toBe(FORBIDDEN)
        expect(
          (await who().post(ApiRoutes.remittances.importProfiles).send(profileBody())).status
        ).toBe(FORBIDDEN)
        expect(
          (await who().patch(ApiRoutes.remittances.importProfileById(id)).send({ name: 'x' }))
            .status
        ).toBe(FORBIDDEN)
        expect((await who().delete(ApiRoutes.remittances.importProfileById(id))).status).toBe(
          FORBIDDEN
        )
      }
      expect((await asAgent().get(ApiRoutes.remittances.importProfiles)).status).toBe(FORBIDDEN)
    })
  })
})
