export class UploadAbortedError extends Error {
  constructor() {
    super('The upload was cancelled')
  }
}

export class UploadFailedError extends Error {
  constructor(readonly status: number) {
    super(`The bucket answered ${status}`)
  }
}

// PUTs the bytes to the signed URL. fetch has no upload progress, so this is XHR. The headers are
// only the content type the URL was signed for: no credentials, no cookies (the URL is the permission).
export function uploadToUrl(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadAbortedError())
      return
    }
    const request = new XMLHttpRequest()
    const onAbort = (): void => request.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (): void => signal.removeEventListener('abort', onAbort)

    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      done()
      if (request.status >= 200 && request.status < 300) {
        onProgress(1)
        resolve()
      } else {
        reject(new UploadFailedError(request.status))
      }
    }
    request.onerror = () => {
      done()
      reject(new UploadFailedError(0))
    }
    request.onabort = () => {
      done()
      reject(new UploadAbortedError())
    }
    request.open('PUT', url)
    request.setRequestHeader('content-type', contentType)
    request.send(file)
  })
}
