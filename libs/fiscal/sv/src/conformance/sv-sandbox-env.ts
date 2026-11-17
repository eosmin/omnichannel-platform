import { FiscalEnvironment } from '@platform/core/domain'
import type { FiscalIssuerInput, FiscalVoidParty } from '@platform/fiscal/sdk'

import { SvAddressKeys, SvCredentialKeys } from '../sv-constants'

// What the run against the real sandbox reads from the environment of the person who runs it, on their own machine. The names are listed here
// and nowhere else; a value is never printed, logged or put in a report (the run keeps the secret ones to check that none got out). The
// sandbox is the only environment this can build: production is not an option of this code.

export const SvSandboxEnvNames = {
  // The words of the owner's own switch: without it nothing is sent, whatever else is set
  CONFIRM: 'DTE_SANDBOX_CONFIRM',
  SIGNER_URL: 'FISCAL_SIGNER_URL',
  TAX_ID: 'DTE_SANDBOX_NIT',
  API_PASSWORD: 'DTE_SANDBOX_API_PASSWORD',
  KEY_PASSWORD: 'DTE_SANDBOX_KEY_PASSWORD',
  LEGAL_NAME: 'DTE_SANDBOX_LEGAL_NAME',
  REGISTRATION: 'DTE_SANDBOX_NRC',
  ACTIVITY: 'DTE_SANDBOX_ACTIVITY_CODE',
  ESTABLISHMENT_CODE: 'DTE_SANDBOX_ESTABLISHMENT_CODE',
  ESTABLISHMENT_TYPE: 'DTE_SANDBOX_ESTABLISHMENT_TYPE',
  POINT_OF_SALE_CODE: 'DTE_SANDBOX_POINT_OF_SALE_CODE',
  DEPARTMENT: 'DTE_SANDBOX_DEPARTMENT',
  MUNICIPALITY: 'DTE_SANDBOX_MUNICIPALITY',
  DISTRICT: 'DTE_SANDBOX_DISTRICT',
  COMPLEMENT: 'DTE_SANDBOX_ADDRESS',
  PHONE: 'DTE_SANDBOX_PHONE',
  EMAIL: 'DTE_SANDBOX_EMAIL',
  RESPONSIBLE_NAME: 'DTE_SANDBOX_RESPONSIBLE_NAME',
  RESPONSIBLE_ID_TYPE: 'DTE_SANDBOX_RESPONSIBLE_ID_TYPE',
  RESPONSIBLE_ID_NUMBER: 'DTE_SANDBOX_RESPONSIBLE_ID_NUMBER'
} as const

// The value the owner types in the confirmation variable
export const SvSandboxConfirmation = 'send-to-sandbox'

const REQUIRED = [
  SvSandboxEnvNames.SIGNER_URL,
  SvSandboxEnvNames.TAX_ID,
  SvSandboxEnvNames.API_PASSWORD,
  SvSandboxEnvNames.KEY_PASSWORD,
  SvSandboxEnvNames.LEGAL_NAME,
  SvSandboxEnvNames.REGISTRATION,
  SvSandboxEnvNames.ACTIVITY,
  SvSandboxEnvNames.ESTABLISHMENT_CODE,
  SvSandboxEnvNames.ESTABLISHMENT_TYPE,
  SvSandboxEnvNames.POINT_OF_SALE_CODE,
  SvSandboxEnvNames.DEPARTMENT,
  SvSandboxEnvNames.MUNICIPALITY,
  SvSandboxEnvNames.DISTRICT,
  SvSandboxEnvNames.COMPLEMENT,
  SvSandboxEnvNames.PHONE,
  SvSandboxEnvNames.EMAIL,
  SvSandboxEnvNames.RESPONSIBLE_NAME,
  SvSandboxEnvNames.RESPONSIBLE_ID_TYPE,
  SvSandboxEnvNames.RESPONSIBLE_ID_NUMBER
] as const

export interface SvSandboxSetup {
  readonly signerUrl: string
  readonly issuer: FiscalIssuerInput
  readonly credentials: Readonly<Record<string, unknown>>
  readonly responsible: FiscalVoidParty
  // Every value that must never leave the process: the report is checked against them
  readonly secrets: readonly string[]
}

export type SvSandboxReading =
  // Nothing is set (or the owner did not confirm): the run is simulated or a dry run, and says which names would be needed
  | { readonly ready: false; readonly missing: readonly string[]; readonly confirmed: boolean }
  | { readonly ready: true; readonly setup: SvSandboxSetup }

const present = (
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | null => {
  const value = env[name]
  return value === undefined || value.trim() === '' ? null : value.trim()
}

// Reads the environment. Returns the NAMES that are missing, never a value. Ready only when every name is set and the owner confirmed.
export function readSvSandboxEnv(
  env: Readonly<Record<string, string | undefined>>
): SvSandboxReading {
  const missing = REQUIRED.filter(name => present(env, name) === null)
  const confirmed = present(env, SvSandboxEnvNames.CONFIRM) === SvSandboxConfirmation
  if (missing.length > 0 || !confirmed) return { ready: false, missing, confirmed }
  const value = (name: string): string => present(env, name) ?? ''
  const taxId = value(SvSandboxEnvNames.TAX_ID)
  const apiPassword = value(SvSandboxEnvNames.API_PASSWORD)
  const keyPassword = value(SvSandboxEnvNames.KEY_PASSWORD)
  const responsibleNumber = value(SvSandboxEnvNames.RESPONSIBLE_ID_NUMBER)
  return {
    ready: true,
    setup: {
      signerUrl: value(SvSandboxEnvNames.SIGNER_URL),
      issuer: {
        legalName: value(SvSandboxEnvNames.LEGAL_NAME),
        taxId,
        registrationId: value(SvSandboxEnvNames.REGISTRATION),
        address: {
          [SvAddressKeys.DEPARTMENT]: value(SvSandboxEnvNames.DEPARTMENT),
          [SvAddressKeys.MUNICIPALITY]: value(SvSandboxEnvNames.MUNICIPALITY),
          [SvAddressKeys.DISTRICT]: value(SvSandboxEnvNames.DISTRICT),
          [SvAddressKeys.COMPLEMENT]: value(SvSandboxEnvNames.COMPLEMENT)
        },
        activityCode: value(SvSandboxEnvNames.ACTIVITY),
        establishmentCode: value(SvSandboxEnvNames.ESTABLISHMENT_CODE),
        establishmentType: value(SvSandboxEnvNames.ESTABLISHMENT_TYPE),
        pointOfSaleCode: value(SvSandboxEnvNames.POINT_OF_SALE_CODE),
        phone: value(SvSandboxEnvNames.PHONE),
        email: value(SvSandboxEnvNames.EMAIL),
        // The only environment this code can make
        environment: FiscalEnvironment.SANDBOX
      },
      credentials: {
        [SvCredentialKeys.API_PASSWORD]: apiPassword,
        [SvCredentialKeys.CERTIFICATE_PASSWORD]: keyPassword
      },
      responsible: {
        name: value(SvSandboxEnvNames.RESPONSIBLE_NAME),
        idType: value(SvSandboxEnvNames.RESPONSIBLE_ID_TYPE),
        idNumber: responsibleNumber
      },
      // The tax number is searched both as typed and as digits (the documents carry it without dashes), and so are the others
      secrets: [
        taxId,
        taxId.replace(/\D/g, ''),
        apiPassword,
        keyPassword,
        responsibleNumber,
        value(SvSandboxEnvNames.PHONE),
        value(SvSandboxEnvNames.EMAIL),
        value(SvSandboxEnvNames.LEGAL_NAME),
        value(SvSandboxEnvNames.RESPONSIBLE_NAME)
      ].filter(secret => secret.length > 0)
    }
  }
}
