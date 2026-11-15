import { type CredentialCipher, generateToken } from '@platform/core/crypto'
import { RemoteChannelLimits } from '@platform/core/domain'

// What the platform keeps of the secret that signs the commands of a remote channel (TDD_10 §6.7.3): the secret as text, sealed as
// the credentials of a connection are, in `PluginInstallation.commandSecret` and `commandSecretPrevious`
export const COMMAND_SECRET_FIELD = 'secret'

// 32 random bytes (base64url text). Shown to the owner once (the plugin needs it to verify what the platform sends) and never again.
export function newCommandSecret(): string {
  return generateToken(RemoteChannelLimits.SECRET_BYTES)
}

export function sealCommandSecret(
  cipher: CredentialCipher,
  secret: string
): Uint8Array<ArrayBuffer> {
  return cipher.seal({ [COMMAND_SECRET_FIELD]: secret })
}
