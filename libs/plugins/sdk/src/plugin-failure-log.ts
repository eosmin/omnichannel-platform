import {
  type ChannelConnectFailureReason,
  ErrorCodes,
  errorName,
  isChannelConnectFailureReason,
  PluginChecks,
  type PluginCheck
} from '@platform/core/errors'

import { PluginError } from './plugin-error'

// What may be logged about a failure of a channel plugin: its name, the numbers the provider gave
// (code and subcode) and the name of the local check that refused, never a message, a value or a token.
// The numbers and the check name are the only parts of a plugin error that cannot hold a secret.
const KNOWN_CHECKS: readonly unknown[] = Object.values(PluginChecks)
const KNOWN_CODES: readonly unknown[] = Object.values(ErrorCodes)
// A class name is identifiers only: `name` is writable, so a plugin could put text in it
const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

function safeName(error: unknown): string {
  const name = errorName(error)
  return CLASS_NAME.test(name) ? name : 'Error'
}

export function pluginFailureLog(error: unknown): {
  errorName: string
  errorCode?: string
  providerCode?: number
  providerSubcode?: number
  failedCheck?: PluginCheck
  reason?: ChannelConnectFailureReason
} {
  if (!(error instanceof PluginError)) return { errorName: safeName(error) }
  return {
    errorName: safeName(error),
    // The code is one of ours, checked against the list: a plugin cannot put text in it
    ...(KNOWN_CODES.includes(error.code) ? { errorCode: error.code } : {}),
    // Checked at run time too: a plugin can be a third party's, and a type does not stop a string
    ...(Number.isInteger(error.providerCode) ? { providerCode: error.providerCode } : {}),
    ...(Number.isInteger(error.providerSubcode) ? { providerSubcode: error.providerSubcode } : {}),
    ...(KNOWN_CHECKS.includes(error.failedCheck) ? { failedCheck: error.failedCheck } : {}),
    ...(isChannelConnectFailureReason(error.reason) ? { reason: error.reason } : {})
  }
}
