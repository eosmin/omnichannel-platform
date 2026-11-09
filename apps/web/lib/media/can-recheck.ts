import { ClientErrorCodes } from '@platform/core/errors'

// A file that is stored and had no verdict when the asking stopped can be asked about again. Any other
// failed file (refused, infected, not uploaded) has nothing to ask and is removed.
export function canRecheck(item: {
  status: string
  mediaId: string | null
  code: string | null
}): boolean {
  return (
    item.status === 'failed' &&
    item.mediaId !== null &&
    item.code === ClientErrorCodes.FILE_NOT_READY
  )
}
