import { randomUUID } from 'node:crypto'

import { CarrierCapability, CarrierConnectionStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { CarrierWebhookRejections, CarrierWebhookService } from './carrier-webhook.service'

// The webhook of a carrier finds its store BEFORE any context exists (resolve_carrier_connection, then the row with its secret is read
// inside the context of the store it found). What these cases hold: an address that is not a connection never reaches the
// database, one that is not known opens no context, and a body whose signature is wrong has the context CLOSED already (it is
// opened only to read the secret) and queues nothing.

const STORE = 'store-1'
const ORGANIZATION = 'org-1'

function build(options: { resolved: boolean; signatureValid: boolean }) {
  const connectionId = randomUUID()
  const state = {
    inside: false,
    opened: [] as unknown[],
    insideWhenVerified: undefined as boolean | undefined
  }
  const prisma = {
    client: {
      $queryRaw: jest.fn(() =>
        Promise.resolve(
          options.resolved
            ? [{ id: connectionId, store_id: STORE, organization_id: ORGANIZATION }]
            : []
        )
      ),
      carrierConnection: {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: connectionId,
            storeId: STORE,
            carrierId: 'carrier-x',
            status: CarrierConnectionStatus.ACTIVE,
            webhookSecret: 'sealed'
          })
        )
      }
    },
    tenantTransaction: jest.fn(async (context: unknown, work: () => Promise<unknown>) => {
      state.opened.push(context)
      state.inside = true
      try {
        return await work()
      } finally {
        state.inside = false
      }
    })
  }
  const plugin = {
    id: 'carrier-x',
    handleWebhook: jest.fn(() => Promise.resolve([])),
    validateWebhookSignature: jest.fn(() => {
      state.insideWhenVerified = state.inside
      return options.signatureValid
    })
  }
  const registry = {
    find: jest.fn(() => plugin),
    hasCapability: jest.fn(
      (_id: string, capability: string) => capability === CarrierCapability.WEBHOOK_STATUS
    )
  }
  const cipher = { open: jest.fn(() => JSON.stringify({ secret: 'the-secret' })) }
  const queue = { addBulk: jest.fn(() => Promise.resolve([])) }
  const received = { inc: jest.fn() }
  const rejected = { inc: jest.fn() }
  const logger = { setContext: jest.fn(), error: jest.fn(), warn: jest.fn() }
  const service = new CarrierWebhookService(
    prisma as never,
    registry as never,
    cipher as never,
    queue as never,
    received as never,
    rejected as never,
    logger as never
  )
  return { service, connectionId, state, prisma, plugin, queue, rejected }
}

const BODY = Buffer.from('{"events":[]}')

describe('CarrierWebhookService, before the context exists', () => {
  it('never reaches the database for an address that is not a connection id', async () => {
    const { service, prisma, rejected } = build({ resolved: true, signatureValid: true })
    await expect(service.receive('not-a-uuid', BODY, {}, {})).rejects.toMatchObject({
      code: ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID
    })
    expect(prisma.client.$queryRaw).not.toHaveBeenCalled()
    expect(prisma.tenantTransaction).not.toHaveBeenCalled()
    expect(rejected.inc).toHaveBeenCalledWith({
      reason: CarrierWebhookRejections.MALFORMED_ADDRESS
    })
  })

  it('opens no context for a connection the database does not know, and answers like a bad signature', async () => {
    const { service, prisma, queue, connectionId } = build({
      resolved: false,
      signatureValid: true
    })
    await expect(service.receive(connectionId, BODY, {}, {})).rejects.toMatchObject({
      code: ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID
    })
    expect(prisma.tenantTransaction).not.toHaveBeenCalled()
    expect(queue.addBulk).not.toHaveBeenCalled()
  })

  it('reads the secret in the context of the store the lookup found and nothing else', async () => {
    const { service, prisma, connectionId } = build({ resolved: true, signatureValid: false })
    await expect(service.receive(connectionId, BODY, {}, {})).rejects.toBeDefined()
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1)
    expect(prisma.tenantTransaction).toHaveBeenCalledWith(
      { storeIds: [STORE], organizationIds: [ORGANIZATION] },
      expect.any(Function)
    )
    expect(prisma.client.carrierConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: connectionId, storeId: STORE } })
    )
  })

  it('has closed the context when it checks a signature, and a wrong one queues nothing', async () => {
    const { service, state, plugin, queue, connectionId, rejected } = build({
      resolved: true,
      signatureValid: false
    })
    await expect(service.receive(connectionId, BODY, {}, {})).rejects.toMatchObject({
      code: ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID
    })
    expect(plugin.validateWebhookSignature).toHaveBeenCalledTimes(1)
    expect(state.insideWhenVerified).toBe(false)
    expect(state.inside).toBe(false)
    expect(queue.addBulk).not.toHaveBeenCalled()
    expect(plugin.handleWebhook).not.toHaveBeenCalled()
    expect(rejected.inc).toHaveBeenCalledWith(
      expect.objectContaining({ reason: CarrierWebhookRejections.BAD_SIGNATURE })
    )
  })
})
