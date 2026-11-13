import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { withTimeout } from '@platform/channels/connections'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher, generateToken } from '@platform/core/crypto'
import {
  DatabaseNull,
  isUniqueViolation,
  lockStoreForWrite,
  lockStoreScope,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  CARRIER_WEBHOOK_SECRET_BYTES,
  CarrierCapability,
  type CarrierCapabilityType,
  CarrierConnectionLimits,
  CarrierConnectionStatus,
  CarrierHealthReasons,
  CarrierLockScopes,
  singleLineText,
  type ConnectCarrierBody,
  type CursorPage,
  isInstallationActive,
  LocalGuide,
  ShippingPlugin,
  type UpdateCarrierBody
} from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { PublicApiConfig } from '@platform/core/http'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { buildCarrierContext, carrierNameOf, carrierServiceLabelOf } from '@platform/core/shipping'
import { CarrierRegistry } from '@platform/plugins/runtime'
import type { CarrierPlugin } from '@platform/plugins/sdk'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type { ListCarriersQuery } from './carrier-connections.schemas'
import {
  type ConnectAnswer,
  connectAnswerSchema,
  defaultServiceCodeOf,
  healthReasonOf,
  localMetadataSchema,
  type RulesSnapshot,
  seedServices,
  seedStatusMappings,
  settingsProblem
} from './carrier-connections.support'
import {
  type CarrierConnectionView,
  type CarrierRegistryEntry,
  type CarrierTestResult,
  CONNECTION_SELECT,
  type ConnectedCarrierView,
  type ConnectionRow
} from './carrier-connections.views'

const CONNECTION_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }] as const

// What a connection starts with when nothing says otherwise (the defaults of the columns)
const NEW_CONNECTION_RULES: RulesSnapshot = {
  defaultShippingFeeCents: null,
  minShippingFeeCents: null,
  maxShippingFeeCents: null,
  pickupEnabled: false,
  pickupDays: [1, 2, 3, 4, 5],
  autoPickup: false,
  autoPickupTime: null
}

// What a connection keeps of what the plugin gave back, none of it secret: the phone and notes of a courier with `CarrierCapability.INTERNAL_GUIDE`, or the
// settings of a carrier's account. Nothing when there is nothing to keep.
function contactOf(
  local: { contact: Record<string, string> } | null,
  answer: ConnectAnswer
): Record<string, string> | ConnectAnswer['metadata'] | undefined {
  if (local !== null) return local.contact
  return Object.keys(answer.metadata).length > 0 ? answer.metadata : undefined
}

function invalidInput(message: string): PlatformException {
  return new PlatformException(
    ErrorCodes.VALIDATION_INVALID_INPUT,
    message,
    HttpStatusCodes.BAD_REQUEST
  )
}

// The guide prefix of a courier that numbers its own guides is taken: the code says why, so the screen can tell the owner what to change
function prefixTaken(message: string): PlatformException {
  return new PlatformException(
    ErrorCodes.SHIPPING_GUIDE_PREFIX_TAKEN,
    message,
    HttpStatusCodes.CONFLICT
  )
}

function notActive(): PlatformException {
  return new PlatformException(
    ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
    'the carrier connection is disconnected',
    HttpStatusCodes.CONFLICT
  )
}

interface LocalSettings {
  prefix: string
  contact: Record<string, string>
}

// The connections of the carriers of the store of the request (TDD_17 §1, §4.12, §6). Every read and write is filtered by
// that store, which comes from the guard and never from the request. The plugin is the one of the registry; what it
// answers is checked before it is kept; the credentials and the webhook secret are encrypted before they reach the
// database and never come back out of it.
@Injectable()
export class CarrierConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CarrierRegistry,
    private readonly cipher: CredentialCipher,
    private readonly publicApi: PublicApiConfig,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(CarrierConnectionsService.name)
  }

  // Which carriers the platform has and what each can do, in the language of the store
  async registryOf(storeId: string): Promise<CarrierRegistryEntry[]> {
    const locale = await this.localeOf(storeId)
    return this.registry.list().map(plugin => ({
      id: plugin.id,
      name: carrierNameOf(plugin, locale),
      version: plugin.version,
      capabilities: this.capabilitiesOf(plugin.id),
      shipmentCreation: plugin.shipmentCreation,
      maxBatchSize: plugin.maxBatchSize ?? null,
      hasCredentials: !this.registry.hasCapability(plugin.id, CarrierCapability.INTERNAL_GUIDE),
      services: plugin.serviceCatalog().map(service => ({
        code: service.code,
        label: carrierServiceLabelOf(plugin.id, service, locale)
      }))
    }))
  }

  async list(
    storeId: string,
    query: ListCarriersQuery
  ): Promise<CursorPage<CarrierConnectionView>> {
    const { cursor, limit } = query
    const rows = await this.prisma.client.carrierConnection.findMany({
      where: {
        storeId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } }
              ]
            })
      },
      select: CONNECTION_SELECT,
      orderBy: [...CONNECTION_ORDER],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    const context = await this.viewContext(storeId)
    return {
      data: page.map(row => this.viewOf(row, context)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(storeId: string, connectionId: string): Promise<CarrierConnectionView> {
    const row = await this.rowOf(this.prisma.client, storeId, connectionId)
    return this.viewOf(row, await this.viewContext(storeId))
  }

  // The call to the carrier happens before the transaction: it can be slow, and a lock held across a network call would
  // block the store. The count of the store and its names are checked inside, under the lock.
  async connect(
    storeId: string,
    body: ConnectCarrierBody,
    actor: Actor
  ): Promise<ConnectedCarrierView> {
    const plugin = this.registry.find(body.carrierId)
    if (plugin === undefined) throw resourceNotFound('carrier')
    await this.assertInstalled(this.prisma.client, storeId)
    const locale = await this.localeOf(storeId)

    // Cheap checks first, so a carrier is not asked to register an account the store cannot keep. The transaction checks
    // them again under the lock.
    await this.assertRoom(this.prisma.client, storeId, body.displayName)
    const internal = this.registry.hasCapability(plugin.id, CarrierCapability.INTERNAL_GUIDE)
    // Everything that depends only on the body and the plugin is checked before the carrier is asked to make an account
    const seeded = seedServices(plugin, service =>
      carrierServiceLabelOf(plugin.id, service, locale)
    )
    const defaultServiceCode = defaultServiceCodeOf(plugin, seeded, body.defaultServiceCode)
    if (defaultServiceCode !== null && !seeded.some(row => row.code === defaultServiceCode)) {
      throw invalidInput('the default service is not one of the carrier')
    }
    const problem = settingsProblem(NEW_CONNECTION_RULES, body)
    if (problem !== null) throw invalidInput(problem)
    // A plugin whose catalog is not valid is the plugin's bug, and answers before anything is written
    const mappings = seedStatusMappings(plugin)

    const { answer, local } = await this.askToConnect(plugin, storeId, body.credentials)
    const connectionId = randomUUID()
    const secret = this.registry.hasCapability(plugin.id, CarrierCapability.WEBHOOK_STATUS)
      ? generateToken(CARRIER_WEBHOOK_SECRET_BYTES)
      : null
    // The name the plugin gives is cleaned as the one the owner types is: one visible line
    const displayName =
      body.displayName ??
      singleLineText(CarrierConnectionLimits.DISPLAY_NAME_MAX_LENGTH, 1)
        .catch(() => 'Carrier')
        .parse(answer.displayName)

    // Sealed here and not in the transaction: what cannot be written as JSON, or is too large, is the plugin's bad answer, and
    // it is answered as such (the error itself is not handed on: it may hold what was being sealed)
    let credentials: ReturnType<CredentialCipher['seal']> | null
    let webhookSecret: ReturnType<CredentialCipher['seal']> | null
    try {
      credentials = internal ? null : this.cipher.seal(answer.credentials)
      webhookSecret = secret === null ? null : this.cipher.seal({ secret })
    } catch {
      await this.forget(plugin, storeId, connectionId, answer)
      throw invalidInput('the credentials cannot be stored')
    }
    let created: { id: string; becameDefault: boolean; view: CarrierConnectionView }
    try {
      // Sealed here and not in the transaction: what cannot be written as JSON, or is too large, is the plugin's bad answer
      created = await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, CarrierLockScopes.CONNECTIONS)
        // Read again with the row locked: the uninstall changes the installation, so a connection is never added to one that
        // was revoked a moment ago
        await this.lockInstallation(tx, storeId)
        await this.assertInstalled(tx, storeId)
        await this.assertRoom(tx, storeId, displayName)
        if (local !== null) await this.assertPrefixFree(tx, storeId, local.prefix, null)
        const row = await tx.carrierConnection.create({
          data: {
            id: connectionId,
            storeId,
            carrierId: plugin.id,
            displayName,
            credentials,
            webhookSecret,
            defaultServiceCode,
            defaultShippingPayer: body.defaultShippingPayer,
            labelFormat: body.labelFormat,
            pickupEnabled: body.pickupEnabled,
            pickupDays: body.pickupDays,
            pickupCutoffTime: body.pickupCutoffTime,
            autoPickup: body.autoPickup,
            autoPickupTime: body.autoPickupTime,
            pickupReminderMinutes: body.pickupReminderMinutes,
            pollIntervalMinutes: body.pollIntervalMinutes,
            maxDeliveryAttempts: body.maxDeliveryAttempts,
            defaultShippingFeeCents: body.defaultShippingFeeCents,
            minShippingFeeCents: body.minShippingFeeCents,
            maxShippingFeeCents: body.maxShippingFeeCents,
            remittanceDeductsFee: body.remittanceDeductsFee,
            contact: contactOf(local, answer)
          },
          select: { id: true }
        })
        if (seeded.length > 0) {
          await tx.carrierService.createMany({
            data: seeded.map(service => ({ storeId, connectionId: row.id, ...service }))
          })
        }
        if (mappings.length > 0) {
          await tx.carrierStatusMapping.createMany({
            data: mappings.map(mapping => ({ storeId, connectionId: row.id, ...mapping }))
          })
        }
        if (local !== null) {
          await tx.guideSequence.create({
            data: { storeId, connectionId: row.id, prefix: local.prefix }
          })
        }
        // The first connection of a store is its default (a store with one carrier never has to say so); an explicit
        // `isDefault: false` is honoured, and a later connection never takes the place of the one that is there
        const current = await tx.storeSettings.findUnique({
          where: { storeId },
          select: { defaultCarrierConnectionId: true }
        })
        let defaultId = current?.defaultCarrierConnectionId ?? null
        // Only a store whose one connection this is: a store that let its default go while others are live keeps choosing
        const others =
          body.isDefault === undefined && current !== null && defaultId === null
            ? await tx.carrierConnection.count({
                where: {
                  storeId,
                  id: { not: row.id },
                  status: { not: CarrierConnectionStatus.DISABLED }
                }
              })
            : 1
        const becomesDefault =
          body.isDefault === true ||
          (others === 0 && body.isDefault === undefined && current !== null && defaultId === null)
        if (becomesDefault) {
          await tx.storeSettings.update({
            where: { storeId },
            data: { defaultCarrierConnectionId: row.id }
          })
          defaultId = row.id
        }
        // The view is read inside the transaction: the secret is shown once, and a read that fails after the commit would lose it
        const made = await this.rowOf(tx, storeId, row.id)
        return {
          id: row.id,
          becameDefault: becomesDefault,
          view: this.viewOf(made, { defaultId, locale })
        }
      })
    } catch (error) {
      // The carrier made an account for a connection that was not kept: tell it so, best effort. Not for a name that is taken:
      // the account may be the very one a live connection of the store uses, and forgetting it would break that connection
      const nameTaken =
        isUniqueViolation(error) ||
        (error instanceof PlatformException && error.code === ErrorCodes.RESOURCE_ALREADY_EXISTS)
      if (!nameTaken) await this.forget(plugin, storeId, connectionId, answer)
      if (isUniqueViolation(error)) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_ALREADY_EXISTS,
          'a carrier connection with that name already exists',
          HttpStatusCodes.CONFLICT
        )
      }
      throw error
    }

    this.record(AuditAction.CARRIER_CONNECTED, storeId, created.id, actor, {
      carrierId: plugin.id,
      displayName,
      isDefault: created.becameDefault
    })
    // The one time the secret leaves the platform: the owner pastes it into the carrier's panel
    return { ...created.view, webhookSecret: secret }
  }

  async update(
    storeId: string,
    connectionId: string,
    body: UpdateCarrierBody,
    actor: Actor
  ): Promise<CarrierConnectionView> {
    const before = await this.rowOf(this.prisma.client, storeId, connectionId)
    // A connection of a plugin that was uninstalled is not renewed, even if the uninstall left it behind
    if (before.status !== String(CarrierConnectionStatus.DISABLED)) {
      await this.assertInstalled(this.prisma.client, storeId)
    }
    // A connection that was let go keeps its name reserved, so the one thing it still accepts is a new name
    const onlyRename = Object.entries(body).every(
      ([key, value]) => value === undefined || key === 'displayName'
    )
    const disabled = before.status === String(CarrierConnectionStatus.DISABLED)
    if (disabled && !onlyRename) throw notActive()
    const plugin = this.registry.find(before.carrierId)
    if (plugin === undefined && !disabled) throw notActive()
    const internal =
      plugin !== undefined &&
      this.registry.hasCapability(plugin.id, CarrierCapability.INTERNAL_GUIDE)

    // New credentials are checked with the carrier first, and only then replace the old ones
    const asked =
      body.credentials === undefined || plugin === undefined
        ? null
        : await this.askToConnect(plugin, storeId, body.credentials)
    const answer = asked === null ? null : asked.answer
    let credentials: ReturnType<CredentialCipher['seal']> | undefined
    try {
      credentials = answer === null || internal ? undefined : this.cipher.seal(answer.credentials)
    } catch {
      throw invalidInput('the credentials cannot be stored')
    }
    const local = asked === null ? null : asked.local

    try {
      await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, CarrierLockScopes.CONNECTIONS)
        // The row again, with the locks held: what is validated is what is written over
        const row = await this.rowOf(tx, storeId, connectionId)
        if (row.status === String(CarrierConnectionStatus.DISABLED) && !onlyRename) {
          throw notActive()
        }
        // As a connect does: a connection is not renewed under an installation that was revoked a moment ago
        if (row.status !== String(CarrierConnectionStatus.DISABLED)) {
          await this.lockInstallation(tx, storeId)
          await this.assertInstalled(tx, storeId)
        }
        if (local !== null) await this.assertPrefixFree(tx, storeId, local.prefix, connectionId)

        const problem = settingsProblem(
          {
            defaultShippingFeeCents: row.defaultShippingFeeCents,
            minShippingFeeCents: row.minShippingFeeCents,
            maxShippingFeeCents: row.maxShippingFeeCents,
            pickupEnabled: row.pickupEnabled,
            pickupDays: row.pickupDays,
            autoPickup: row.autoPickup,
            autoPickupTime: row.autoPickupTime
          },
          {
            ...(body.defaultShippingFeeCents === undefined
              ? {}
              : { defaultShippingFeeCents: body.defaultShippingFeeCents }),
            ...(body.minShippingFeeCents === undefined
              ? {}
              : { minShippingFeeCents: body.minShippingFeeCents }),
            ...(body.maxShippingFeeCents === undefined
              ? {}
              : { maxShippingFeeCents: body.maxShippingFeeCents }),
            ...(body.pickupEnabled === undefined ? {} : { pickupEnabled: body.pickupEnabled }),
            ...(body.pickupDays === undefined ? {} : { pickupDays: body.pickupDays }),
            ...(body.autoPickup === undefined ? {} : { autoPickup: body.autoPickup }),
            ...(body.autoPickupTime === undefined ? {} : { autoPickupTime: body.autoPickupTime })
          }
        )
        if (problem !== null) throw invalidInput(problem)

        // The services: only a code the connection has, and the default one must stay a service that is on
        const services = new Map(row.services.map(service => [service.code, { ...service }]))
        for (const edit of body.services ?? []) {
          const service = services.get(edit.code)
          if (service === undefined) throw invalidInput('a service is not one of the connection')
          if (edit.label !== undefined) service.label = edit.label
          if (edit.active !== undefined) service.active = edit.active
        }
        const defaultServiceCode = body.defaultServiceCode ?? row.defaultServiceCode
        if (
          (body.defaultServiceCode !== undefined || body.services !== undefined) &&
          defaultServiceCode !== null &&
          services.get(defaultServiceCode)?.active !== true
        ) {
          throw invalidInput('the default service must be a service that is on')
        }
        for (const edit of body.services ?? []) {
          await tx.carrierService.updateMany({
            where: { storeId, connectionId, code: edit.code },
            data: { label: edit.label, active: edit.active }
          })
        }

        // The locks held here are the ones a disconnect takes, so the state read above is the one written over
        await tx.carrierConnection.updateMany({
          where: { id: connectionId, storeId },
          data: {
            displayName: body.displayName,
            credentials,
            defaultServiceCode: body.defaultServiceCode,
            defaultShippingPayer: body.defaultShippingPayer,
            labelFormat: body.labelFormat,
            pickupEnabled: body.pickupEnabled,
            pickupDays: body.pickupDays,
            pickupCutoffTime: body.pickupCutoffTime,
            autoPickup: body.autoPickup,
            autoPickupTime: body.autoPickupTime,
            pickupReminderMinutes: body.pickupReminderMinutes,
            pollIntervalMinutes: body.pollIntervalMinutes,
            maxDeliveryAttempts: body.maxDeliveryAttempts,
            defaultShippingFeeCents: body.defaultShippingFeeCents,
            minShippingFeeCents: body.minShippingFeeCents,
            maxShippingFeeCents: body.maxShippingFeeCents,
            remittanceDeductsFee: body.remittanceDeductsFee,
            ...(answer === null ? {} : { contact: contactOf(local, answer) ?? DatabaseNull }),
            // New credentials that the carrier accepted clear what the last failure said
            ...(answer === null
              ? {}
              : {
                  lastError: null,
                  ...(row.status === String(CarrierConnectionStatus.ERROR)
                    ? { status: CarrierConnectionStatus.ACTIVE }
                    : {})
                })
          }
        })
        // The numbering of a courier with `CarrierCapability.INTERNAL_GUIDE` goes on from where it was: only the prefix of the new guides changes
        if (local !== null) {
          await tx.guideSequence.updateMany({
            where: { storeId, connectionId },
            data: { prefix: local.prefix }
          })
        }
        if (body.isDefault === true) {
          await tx.storeSettings.update({
            where: { storeId },
            data: { defaultCarrierConnectionId: connectionId }
          })
        } else if (body.isDefault === false) {
          await tx.storeSettings.updateMany({
            where: { storeId, defaultCarrierConnectionId: connectionId },
            data: { defaultCarrierConnectionId: null }
          })
        }
      })
    } catch (error) {
      // New credentials that were not kept are NOT forgotten at the carrier: they may be a new key of the account the live
      // connection still uses, and telling the carrier to drop it would kill that connection (plan 4.8, B2 (m))
      if (isUniqueViolation(error)) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_ALREADY_EXISTS,
          'a carrier connection with that name already exists',
          HttpStatusCodes.CONFLICT
        )
      }
      throw error
    }

    // Which fields changed, by name: no value, so no credential, ever reaches the audit trail
    const { credentials: replaced, ...rest } = body
    this.record(AuditAction.CARRIER_UPDATED, storeId, connectionId, actor, {
      changed: [
        ...Object.keys(rest).filter(key => rest[key as keyof typeof rest] !== undefined),
        ...(replaced === undefined ? [] : ['credentials'])
      ].sort()
    })
    return this.get(storeId, connectionId)
  }

  // Asks the carrier whether the connection works. A failure is told as a name of a closed list, never in the carrier's
  // words. The credentials that the carrier refused move the connection to `error`; a carrier that did not answer does not
  // change its state.
  async test(storeId: string, connectionId: string): Promise<CarrierTestResult> {
    const row = await this.rowOf(this.prisma.client, storeId, connectionId)
    if (row.status === String(CarrierConnectionStatus.DISABLED)) throw notActive()
    // No credential is sent to a carrier for an installation that was revoked, even if its uninstall left the connection
    await this.assertInstalled(this.prisma.client, storeId)
    const plugin = this.registry.find(row.carrierId)
    if (plugin === undefined) throw notActive()

    let reason: ReturnType<typeof healthReasonOf> | null = null
    try {
      const health = await withTimeout(
        plugin.healthCheck(buildCarrierContext({ ...row, storeId }, this.cipher)),
        CarrierConnectionLimits.PROVIDER_TIMEOUT_MS
      )
      if (health.healthy !== true) reason = CarrierHealthReasons.REJECTED
    } catch (error) {
      reason = healthReasonOf(error)
      this.logger.warn(
        { carrierId: row.carrierId, storeId, connectionId, reason, errorName: errorName(error) },
        'carrier health check failed'
      )
    }
    const checkedAt = new Date()

    // Conditional on the connection being on: a disconnect that ran meanwhile is not undone by a late answer
    await this.prisma.client.carrierConnection.updateMany({
      where: { id: connectionId, storeId, status: { not: CarrierConnectionStatus.DISABLED } },
      data:
        reason === null
          ? { lastHealthyAt: checkedAt, lastError: null, status: CarrierConnectionStatus.ACTIVE }
          : {
              lastError: reason,
              ...(reason === CarrierHealthReasons.AUTH ||
              reason === CarrierHealthReasons.CREDENTIALS_UNREADABLE
                ? { status: CarrierConnectionStatus.ERROR }
                : {})
            }
    })
    return { healthy: reason === null, checkedAt: checkedAt.toISOString(), reason }
  }

  // Disconnecting keeps the row: its shipments, its pickups and the numbering of its guides stay, because they are the history
  // of the business. The carrier is told, the credentials and the secret are deleted at once, and the connection stops being
  // the default. Run again it changes nothing.
  async disconnect(
    storeId: string,
    connectionId: string,
    actor: Actor
  ): Promise<CarrierConnectionView> {
    const row = await this.rowOf(this.prisma.client, storeId, connectionId)
    if (row.status !== String(CarrierConnectionStatus.DISABLED)) {
      await this.tellCarrier(row, storeId)
      const changed = await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        await lockStoreScope(tx, storeId, CarrierLockScopes.CONNECTIONS)
        const updated = await tx.carrierConnection.updateMany({
          where: { id: connectionId, storeId, status: { not: CarrierConnectionStatus.DISABLED } },
          data: {
            status: CarrierConnectionStatus.DISABLED,
            credentials: null,
            webhookSecret: null,
            lastError: null
          }
        })
        await tx.storeSettings.updateMany({
          where: { storeId, defaultCarrierConnectionId: connectionId },
          data: { defaultCarrierConnectionId: null }
        })
        return updated.count === 1
      })
      if (changed) {
        this.record(AuditAction.CARRIER_DISCONNECTED, storeId, connectionId, actor, {
          carrierId: row.carrierId,
          openShipments: row._count.shipments,
          openPickups: row._count.pickups
        })
      }
    }
    return this.get(storeId, connectionId)
  }

  // A new secret for the webhook of a connection (TDD_17 §4.9): the owner lost the old one, or it leaked. It takes the place
  // of the old one at once (the carrier's panel has to be updated), and, like the one made at connect, it is given in this
  // answer only: nothing can show it again. A connection that was let go has no webhook, and a carrier that pushes no status
  // has nothing to sign.
  async rotateWebhookSecret(
    storeId: string,
    connectionId: string,
    actor: Actor
  ): Promise<{ webhookSecret: string }> {
    const row = await this.rowOf(this.prisma.client, storeId, connectionId)
    if (row.status === String(CarrierConnectionStatus.DISABLED)) throw notActive()
    if (!this.registry.hasCapability(row.carrierId, CarrierCapability.WEBHOOK_STATUS)) {
      throw new PlatformException(
        ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING,
        'the carrier does not push status updates',
        HttpStatusCodes.CONFLICT
      )
    }
    const secret = generateToken(CARRIER_WEBHOOK_SECRET_BYTES)
    const sealed = this.cipher.seal({ secret })
    await this.prisma.transaction(async tx => {
      // The same lock as a disconnect: a secret is never written to a connection that is being let go
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, CarrierLockScopes.CONNECTIONS)
      const updated = await tx.carrierConnection.updateMany({
        where: { id: connectionId, storeId, status: { not: CarrierConnectionStatus.DISABLED } },
        data: { webhookSecret: sealed }
      })
      if (updated.count !== 1) throw notActive()
    })
    // The secret is not in the audit row: only that it was made
    this.record(AuditAction.CARRIER_WEBHOOK_SECRET_ROTATED, storeId, connectionId, actor, {
      carrierId: row.carrierId
    })
    return { webhookSecret: secret }
  }

  // Every connection of the store that is not disconnected: what uninstalling the shipping plugin does (D19)
  async disconnectAll(storeId: string, actor: Actor): Promise<void> {
    const open = await this.prisma.client.carrierConnection.findMany({
      where: { storeId, status: { not: CarrierConnectionStatus.DISABLED } },
      select: { id: true },
      orderBy: { id: 'asc' }
    })
    // One that fails must not leave the rest with their credentials: every one is tried, and the first failure is raised after
    let failure: Error | null = null
    for (const connection of open) {
      try {
        await this.disconnect(storeId, connection.id, actor)
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(errorName(error))
      }
    }
    if (failure !== null) throw failure
  }

  // The carrier hears that the connection ends. Its answer does not stop the disconnect: a carrier that is down must not keep
  // credentials the owner wants gone.
  private async tellCarrier(row: ConnectionRow, storeId: string): Promise<void> {
    const plugin = this.registry.find(row.carrierId)
    if (plugin === undefined) return
    try {
      await withTimeout(
        plugin.disconnect(buildCarrierContext({ ...row, storeId }, this.cipher)),
        CarrierConnectionLimits.PROVIDER_TIMEOUT_MS
      )
    } catch (error) {
      this.logger.warn(
        { carrierId: row.carrierId, storeId, connectionId: row.id, errorName: errorName(error) },
        'the carrier did not confirm the disconnect'
      )
    }
  }

  // connect() of the plugin, with its answer checked. A carrier that could not be reached is a 503 and one that did not accept
  // the credentials a 400 with the reason as a name of the closed list; anything else (a bug of the plugin, an answer that is
  // not valid) is not the owner's input and is raised as what it is.
  private async askToConnect(
    plugin: CarrierPlugin,
    storeId: string,
    credentials: Record<string, unknown>
  ): Promise<{ answer: ConnectAnswer; local: LocalSettings | null }> {
    try {
      const answer = connectAnswerSchema.parse(
        await withTimeout(
          plugin.connect({ storeId, credentials }),
          CarrierConnectionLimits.PROVIDER_TIMEOUT_MS
        )
      )
      const internal = this.registry.hasCapability(plugin.id, CarrierCapability.INTERNAL_GUIDE)
      return { answer, local: internal ? this.localSettings(answer) : null }
    } catch (error) {
      const reason = healthReasonOf(error)
      this.logger.warn(
        { carrierId: plugin.id, storeId, reason, errorName: errorName(error) },
        'carrier connect failed'
      )
      if (reason === CarrierHealthReasons.UNAVAILABLE) {
        throw new PlatformException(
          ErrorCodes.SHIPPING_CARRIER_UNAVAILABLE,
          'the carrier could not be reached',
          HttpStatusCodes.SERVICE_UNAVAILABLE
        )
      }
      if (reason === CarrierHealthReasons.AUTH || reason === CarrierHealthReasons.REJECTED) {
        throw new PlatformException(
          ErrorCodes.SHIPPING_CARRIER_CREDENTIALS_INVALID,
          'the carrier did not accept the connection',
          HttpStatusCodes.BAD_REQUEST,
          { reason }
        )
      }
      // The error of a plugin is never handed on: its request, its headers or its answer may hold the account's secret, and
      // the filter that reports an unknown error sends the whole object to the log and to Sentry. Only the name was logged.
      // eslint-disable-next-line preserve-caught-error -- the cause is left out on purpose: it may hold the secret
      throw new Error(`the carrier plugin failed to connect (${reason})`)
    }
  }

  // The carrier is told that a connection it just made was not kept (the transaction failed): its account is not left behind
  private async forget(
    plugin: CarrierPlugin,
    storeId: string,
    connectionId: string,
    answer: ConnectAnswer
  ): Promise<void> {
    try {
      await withTimeout(
        plugin.disconnect({
          storeId,
          connectionId,
          credentials: answer.credentials,
          metadata: answer.metadata
        }),
        CarrierConnectionLimits.PROVIDER_TIMEOUT_MS
      )
    } catch (error) {
      this.logger.warn(
        { carrierId: plugin.id, storeId, errorName: errorName(error) },
        'the carrier did not confirm that the connection was not kept'
      )
    }
  }

  // The store has room for one more connection and the name is free. `name` is unknown until the carrier answers when the
  // client did not give one.
  private async assertRoom(
    client: PrismaService['client'] | PrismaTransaction,
    storeId: string,
    name: string | undefined
  ): Promise<void> {
    const live = await client.carrierConnection.count({
      where: { storeId, status: { not: CarrierConnectionStatus.DISABLED } }
    })
    if (live >= CarrierConnectionLimits.MAX_PER_STORE) {
      throw resourceConflict('the store has the most carrier connections it may have')
    }
    if (name !== undefined) {
      const taken = await client.carrierConnection.findFirst({
        where: { storeId, displayName: name },
        select: { id: true }
      })
      if (taken !== null) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_ALREADY_EXISTS,
          'a carrier connection with that name already exists',
          HttpStatusCodes.CONFLICT
        )
      }
    }
  }

  // Two couriers of a store never print the same guide number: the reception of returns finds a package by it (TDD_17 §4.16).
  // The numbering of each connection is unique already; the prefix is what tells the connections apart.
  private async assertPrefixFree(
    tx: PrismaTransaction,
    storeId: string,
    prefix: string,
    exceptConnectionId: string | null
  ): Promise<void> {
    // A courier that was let go and printed no guide frees its prefix (what it printed is checked below)
    const taken = await tx.guideSequence.findFirst({
      where: {
        storeId,
        prefix,
        connection: { status: { not: CarrierConnectionStatus.DISABLED } },
        ...(exceptConnectionId === null ? {} : { connectionId: { not: exceptConnectionId } })
      },
      select: { connectionId: true }
    })
    if (taken !== null) throw prefixTaken('another courier of the store uses that guide prefix')
    // A prefix that another courier changed away from still prints on its guides: taking it would number two packages of
    // the store with the same guide (no table forbids it across connections, because two carriers may share a number)
    const printed = await tx.shipment.findFirst({
      where: {
        storeId,
        guideNumber: { startsWith: `${prefix}${LocalGuide.SEPARATOR}` },
        ...(exceptConnectionId === null ? {} : { connectionId: { not: exceptConnectionId } })
      },
      select: { id: true }
    })
    if (printed !== null)
      throw prefixTaken('that guide prefix is printed on guides of another courier')
  }

  // What a carrier that makes no guide of its own (one with `CarrierCapability.INTERNAL_GUIDE`) gives back: the prefix of its guides, that must be
  // one the barcode and the sort can use, and the contact the owner reads. Throws what a bad answer throws.
  private localSettings(answer: ConnectAnswer): LocalSettings {
    const { phone, notes, prefix } = localMetadataSchema.parse(answer.metadata)
    if (!LocalGuide.PREFIX_PATTERN.test(prefix))
      throw new RangeError('the guide prefix is not valid')
    return { prefix, contact: { phone, ...(notes === undefined ? {} : { notes }) } }
  }

  // The installation row is read with a shared lock: an uninstall that revokes it waits for this transaction, so it then finds
  // the connection made here and disconnects it, and no connection is added to an installation that was revoked a moment ago
  private async lockInstallation(tx: PrismaTransaction, storeId: string): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM plugin_installations WHERE store_id = ${storeId} AND plugin_id = ${ShippingPlugin.ID} FOR SHARE`
  }

  private async assertInstalled(
    client: PrismaService['client'] | PrismaTransaction,
    storeId: string
  ): Promise<void> {
    const installation = await client.pluginInstallation.findUnique({
      where: { storeId_pluginId: { storeId, pluginId: ShippingPlugin.ID } },
      select: { status: true, plugin: { select: { status: true } } }
    })
    if (installation === null || !isInstallationActive(installation)) {
      throw new PlatformException(
        ErrorCodes.PLUGIN_NOT_INSTALLED,
        'the shipping plugin is not installed in this store',
        HttpStatusCodes.CONFLICT
      )
    }
  }

  private async rowOf(
    client: PrismaService['client'] | PrismaTransaction,
    storeId: string,
    connectionId: string
  ): Promise<ConnectionRow> {
    // The store is part of the filter, so the connection of another store is the same 404 as one that does not exist
    const row = await client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: CONNECTION_SELECT
    })
    if (row === null) throw resourceNotFound('carrier connection')
    return row
  }

  private async localeOf(storeId: string): Promise<Locale> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { defaultLocale: true }
    })
    return SUPPORTED_LOCALES.find(locale => locale === store?.defaultLocale) ?? DEFAULT_LOCALE
  }

  private async viewContext(storeId: string): Promise<{
    defaultId: string | null
    locale: Locale
  }> {
    const [settings, locale] = await Promise.all([
      this.prisma.client.storeSettings.findUnique({
        where: { storeId },
        select: { defaultCarrierConnectionId: true }
      }),
      this.localeOf(storeId)
    ])
    return { defaultId: settings?.defaultCarrierConnectionId ?? null, locale }
  }

  private capabilitiesOf(carrierId: string): CarrierCapabilityType[] {
    return Object.values(CarrierCapability).filter(capability =>
      this.registry.hasCapability(carrierId, capability)
    )
  }

  private viewOf(
    row: ConnectionRow,
    context: { defaultId: string | null; locale: Locale }
  ): CarrierConnectionView {
    const plugin = this.registry.find(row.carrierId)
    // The settings of a courier the owner typed (a phone, a note). What another carrier's plugin keeps is for the plugin
    const contact =
      this.registry.hasCapability(row.carrierId, CarrierCapability.INTERNAL_GUIDE) &&
      typeof row.contact === 'object' &&
      row.contact !== null &&
      !Array.isArray(row.contact)
        ? Object.fromEntries(Object.entries(row.contact))
        : null
    return {
      id: row.id,
      carrierId: row.carrierId,
      carrierName: plugin === undefined ? row.carrierId : carrierNameOf(plugin, context.locale),
      displayName: row.displayName,
      status: row.status,
      hasCredentials: row.credentials !== null,
      hasWebhookSecret: row.webhookSecret !== null,
      webhookUrl: this.registry.hasCapability(row.carrierId, CarrierCapability.WEBHOOK_STATUS)
        ? `${this.publicApi.apiUrl.replace(/\/$/, '')}${API_PREFIX}${ApiRoutes.webhooks.carrier(row.id)}`
        : null,
      capabilities: this.capabilitiesOf(row.carrierId),
      isDefault: context.defaultId === row.id,
      defaultServiceCode: row.defaultServiceCode,
      defaultShippingPayer: row.defaultShippingPayer,
      labelFormat: row.labelFormat,
      contact,
      guidePrefix: row.guideSequence?.prefix ?? null,
      services: row.services,
      pickupEnabled: row.pickupEnabled,
      pickupDays: row.pickupDays,
      pickupCutoffTime: row.pickupCutoffTime,
      autoPickup: row.autoPickup,
      autoPickupTime: row.autoPickupTime,
      pickupReminderMinutes: row.pickupReminderMinutes,
      pollIntervalMinutes: row.pollIntervalMinutes,
      maxDeliveryAttempts: row.maxDeliveryAttempts,
      defaultShippingFeeCents: row.defaultShippingFeeCents,
      minShippingFeeCents: row.minShippingFeeCents,
      maxShippingFeeCents: row.maxShippingFeeCents,
      remittanceDeductsFee: row.remittanceDeductsFee,
      openShipments: row._count.shipments,
      openPickups: row._count.pickups,
      lastHealthyAt: row.lastHealthyAt?.toISOString() ?? null,
      lastError: toHealthReason(row.lastError),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    }
  }

  private record(
    action:
      | typeof AuditAction.CARRIER_CONNECTED
      | typeof AuditAction.CARRIER_UPDATED
      | typeof AuditAction.CARRIER_DISCONNECTED
      | typeof AuditAction.CARRIER_WEBHOOK_SECRET_ROTATED,
    storeId: string,
    connectionId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'carrier_connection',
      resourceId: connectionId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

const HEALTH_REASONS: ReadonlySet<string> = new Set(Object.values(CarrierHealthReasons))

function toHealthReason(value: string | null): CarrierConnectionView['lastError'] {
  if (value === null || !HEALTH_REASONS.has(value)) return null
  return Object.values(CarrierHealthReasons).find(reason => reason === value) ?? null
}
