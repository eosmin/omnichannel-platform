import { z } from 'zod'

import type { CarrierContext } from '@platform/plugins/sdk'

import { ForzaCountries, ForzaLimits, ForzaVehicleTypes } from './forza-constants'

// What the owner gives to connect Forza. The key and the account number are secrets and are kept encrypted
// (`credentials`); the rest is configuration (`metadata`).
const blankAsUndefined = (value: unknown): unknown => (value === '' ? undefined : value)
const positiveInt = z.coerce.number().int().positive()

// A signed request goes to this address, so a host that names the machine's own network is refused: localhost, a name with
// no dot (an internal one) and an IP literal in a private, loopback or link-local range. The name is not resolved here.
const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|192\.0\.0\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/
const INTERNAL_SUFFIX = /\.(local|internal|localhost|lan|home|corp)$/i
export function isPublicHost(hostname: string): boolean {
  // `localhost.` is the same host as `localhost`
  const host = hostname.toLowerCase().replace(/\.+$/, '')
  if (host === 'localhost' || host.startsWith('[') || INTERNAL_SUFFIX.test(host)) return false
  if (PRIVATE_IPV4.test(host)) return false
  return host.includes('.')
}

const BANK_KEYS = ['bankId', 'bankAccountName', 'bankAccountType', 'bankAccountId'] as const

export const forzaConnectInputSchema = z.object({
  codApp: z.string().trim().min(1).max(64),
  secretKey: z.string().trim().min(16).max(128),
  idClient: positiveInt,
  country: z.enum(ForzaCountries),
  // https only: the signed request goes there
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine(value => new URL(value).protocol === 'https:')
    .refine(value => isPublicHost(new URL(value).hostname)),
  // The visit point (`CodeOfReference`) the guides leave from, and the municipality code of the warehouse
  codeOfReference: positiveInt,
  originHeaderCodeTownship: z.string().trim().min(1).max(8),
  // Cash on delivery: where Forza deposits what it collects. All four or none.
  bankId: z.preprocess(blankAsUndefined, z.string().trim().min(1).max(20).optional()),
  bankAccountName: z.preprocess(blankAsUndefined, z.string().trim().min(1).max(40).optional()),
  bankAccountType: z.preprocess(blankAsUndefined, z.string().trim().min(1).max(20).optional()),
  bankAccountId: z.preprocess(blankAsUndefined, z.string().trim().min(1).max(25).optional()),
  defaultWeightLbs: z.preprocess(
    blankAsUndefined,
    z.coerce.number().positive().max(9999).optional()
  ),
  pickupVehicleTypeId: z.preprocess(
    blankAsUndefined,
    z.coerce.number().pipe(z.enum(ForzaVehicleTypes)).optional()
  )
})
export type ForzaConnectInput = z.infer<typeof forzaConnectInputSchema>

// The four bank fields come together or not at all
export function bankIsPartial(input: ForzaConnectInput): boolean {
  const filled = BANK_KEYS.filter(key => input[key] !== undefined).length
  return filled > 0 && filled < BANK_KEYS.length
}

export interface ForzaBank {
  bankId: string
  bankAccountName: string
  bankAccountType: string
  bankAccountId: string
}

// What a call needs, read from the context of the connection
export interface ForzaConfig {
  codApp: string
  secretKey: string
  idClient: number
  country: ForzaConnectInput['country']
  baseUrl: string
  codeOfReference: number
  originHeaderCodeTownship: string
  bank: ForzaBank | null
  defaultWeightLbs: number
  pickupVehicleTypeId: number
}

// The connection as it is stored: secrets in `credentials`, the rest in `metadata`
export function splitForzaConnection(input: ForzaConnectInput): {
  credentials: Record<string, unknown>
  metadata: Record<string, unknown>
} {
  const { codApp, secretKey, bankAccountId, ...rest } = input
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) metadata[key] = value
  }
  return {
    credentials: {
      codApp,
      secretKey,
      ...(bankAccountId === undefined ? {} : { bankAccountId })
    },
    metadata
  }
}

// Null when the connection is not complete: the plugin refuses the call without saying which field is wrong
export function readForzaConfig(
  ctx: Pick<CarrierContext, 'credentials' | 'metadata'>
): ForzaConfig | null {
  const parsed = forzaConnectInputSchema.safeParse({ ...ctx.metadata, ...ctx.credentials })
  if (!parsed.success) return null
  const input = parsed.data
  const bankComplete =
    input.bankId !== undefined &&
    input.bankAccountName !== undefined &&
    input.bankAccountType !== undefined &&
    input.bankAccountId !== undefined
  return {
    codApp: input.codApp,
    secretKey: input.secretKey,
    idClient: input.idClient,
    country: input.country,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    codeOfReference: input.codeOfReference,
    originHeaderCodeTownship: input.originHeaderCodeTownship,
    bank: bankComplete
      ? {
          bankId: input.bankId ?? '',
          bankAccountName: input.bankAccountName ?? '',
          bankAccountType: input.bankAccountType ?? '',
          bankAccountId: input.bankAccountId ?? ''
        }
      : null,
    defaultWeightLbs: input.defaultWeightLbs ?? ForzaLimits.DEFAULT_WEIGHT_LBS,
    pickupVehicleTypeId: input.pickupVehicleTypeId ?? ForzaVehicleTypes.MOTORCYCLE
  }
}
