import { PluginError } from '@platform/plugins/sdk'

// The numbers Meta (or another provider) gave for a failure, to be logged beside the error name: a
// plugin keeps only the code and the subcode of the answer, so they cannot hold a token or a link
export function providerCodesOf(error: unknown): {
  providerCode?: number
  providerSubcode?: number
  step?: string
} {
  if (!(error instanceof PluginError)) return {}
  return {
    ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
    ...(error.providerSubcode === undefined ? {} : { providerSubcode: error.providerSubcode }),
    ...(error.step === undefined ? {} : { step: error.step })
  }
}
