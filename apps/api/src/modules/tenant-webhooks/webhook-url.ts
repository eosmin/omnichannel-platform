import { Logger } from '@nestjs/common'

import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { errorCodeOf, resolvePublicHttpsUrl } from '@platform/core/url-safety'

// The address of a webhook must lead to the public internet: https, the default port, no credentials, and a host
// whose every address is public (TDD_07 §2). Checked when the webhook is made or its address changed; the worker
// checks it again at every delivery and connects to the address it checked, because a name can answer differently
// later. Whatever is wrong gives the same answer, so the check cannot be used to map the network of the server.
export async function assertWebhookUrl(raw: string): Promise<void> {
  try {
    await resolvePublicHttpsUrl(raw)
  } catch (error) {
    // A resolver that did not answer looks the same to the owner as an address that is not allowed: the log tells them apart
    new Logger('assertWebhookUrl').warn(`a webhook address was refused (${errorCodeOf(error)})`)
    throw new PlatformException(
      ErrorCodes.VALIDATION_URL_NOT_ALLOWED,
      'the address of a webhook must be https and lead to the public internet',
      HttpStatusCodes.BAD_REQUEST
    )
  }
}
