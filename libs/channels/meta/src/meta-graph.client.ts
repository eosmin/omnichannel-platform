import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'

import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import {
  MetaErrorCodes,
  MetaGraph,
  type MetaGraphOrigin,
  MetaLimits,
  MetaGrantedPageScopes,
  MetaOAuth,
  MetaUpload,
  MetaWebhook,
  type MetaWebhookApp,
  MetaWebhookApps,
  TokenExpiryLimits,
  type TokenInspection,
  TokenKinds
} from '@platform/core/domain'
import {
  ChannelConnectFailureReasons,
  ErrorCodes,
  HttpStatusCodes,
  PluginChecks
} from '@platform/core/errors'
import { type FetchedMedia, PluginError, UnsafeMediaLinkError } from '@platform/plugins/sdk'

import { graphFailure, graphFileFailure, graphUnexpected, graphUnreachable } from './graph-failure'
import { limitBytes } from './limit-bytes'
import { MetaAppConfig } from './meta-app-config'
import { answerMetaHandshake, isValidMetaSignature } from './meta-webhook'

// An id or an edge name: letters, digits, underscore, dash. No dot, so no `..`, and no slash.
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
// A media id is a number. Any other segment would let an id from a webhook read another Graph node
// (`me`, `debug_token`) with the connection's token.
// 302 is class 3: a redirect
const STATUS_CLASS = 100
const REDIRECT_CLASS = 3
const MEDIA_ID = /^\d+$/
// What can go into a header value: printable ASCII
const HEADER_TOKEN = /^[\x21-\x7E]+$/
// `image/png`: the type of an upload goes into a header line and a form field
const MIME_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/
// A form field name: letters, digits, underscore
const FIELD_NAME = /^[A-Za-z0-9_]+$/
// The name of the file in the form: plain characters only, so it can never close the quotes or add a line
const FILE_NAME = /^[A-Za-z0-9._ ()-]{1,120}$/

// The statuses that split a refusal of the caller from a failure of Meta
const HTTP_CLIENT_ERROR_MIN = 400
const HTTP_SERVER_ERROR_MIN = 500
const HTTP_TOO_MANY_REQUESTS = HttpStatusCodes.TOO_MANY_REQUESTS

const tokenAnswerSchema = z.object({ access_token: z.string().min(1).max(4096) })

// What `debug_token` answers, read for these fields alone. `expires_at` is a date in seconds, 0 for a token that
// does not expire; one that is missing says nothing, and is not taken for "never".
const debugAnswerSchema = z.object({
  data: z.object({
    is_valid: z.boolean(),
    type: z.string().max(40).optional(),
    expires_at: z.number().int().nonnegative().optional(),
    scopes: z.array(z.string()).optional(),
    // What the person ticked in the dialog, by permission: the ids of the Pages they chose. Read tolerant: a
    // part that does not have the shape is the same as a part that is not there.
    // Each element is read alone below: one that does not fit must not cost the others
    granular_scopes: z.array(z.unknown()).optional().catch(undefined)
  })
})

// The shape of the error that says "this edge does not take that method". Only the class and the subcode of
// the error are read, never its message.
const methodRejectionSchema = z.object({ error: z.object({ type: z.string().optional() }) })

type DebugMethod = 'POST' | 'GET'

interface DebugResult {
  inspection: TokenInspection
  pageIds: string[]
}

// The Pages the person chose, from the targets of the permissions that target Pages
const granularScopeSchema = z.object({
  scope: z.string(),
  target_ids: z.array(z.unknown()).optional().catch(undefined)
})

function grantedPages(granular: unknown[] | undefined): string[] {
  const ids = new Set<string>()
  for (const item of granular ?? []) {
    const parsed = granularScopeSchema.safeParse(item)
    if (!parsed.success || !MetaGrantedPageScopes.includes(parsed.data.scope)) continue
    for (const id of parsed.data.target_ids ?? []) {
      if (typeof id !== 'string') continue
      if (MetaOAuth.ASSET_ID_PATTERN.test(id)) ids.add(id)
    }
  }
  return [...ids].slice(0, MetaOAuth.MAX_GRANTED_PAGES)
}

const mediaInfoSchema = z.object({
  url: z.url(),
  mime_type: z.string().min(1),
  file_size: z.number().int().nonnegative().optional()
})

export interface GraphRequest<T> {
  // ['123456', 'messages'] is /123456/messages
  path: readonly string[]
  token: string
  schema: z.ZodType<T>
  query?: Record<string, string>
  body?: unknown
  // A POST that changes nothing the second time (a subscription, a read receipt) may be tried again
  idempotent?: boolean
  // Facebook's Graph, the only host there is
  origin?: MetaGraphOrigin
  // The caller's own reason to stop waiting; the request still ends by itself after `REQUEST_TIMEOUT_MS`
  signal?: AbortSignal
}

export interface UploadRequest<T> {
  path: readonly string[]
  token: string
  // The text fields of the form, sent before the file (`messaging_product`, `type`)
  fields: Record<string, string>
  // The stored bytes, opened by the client only after everything refusable was refused, so that a
  // refusal leaves no stream open. `size` is what was recorded when the file was checked: the upload
  // is cut off if the stream holds more, and fails if it ends short. `contentType` is that record too.
  file: { open: () => Promise<NodeJS.ReadableStream>; contentType: string; size: number }
  schema: z.ZodType<T>
  origin?: MetaGraphOrigin
  // The name of the form field that holds the file: `file` for the media edge of WhatsApp, `filedata`
  // when the file is uploaded and sent in one call
  fileField?: string
  // False when the call changes something the customer sees (the Send API): a failure that may have
  // reached Meta is then not tried again. True (the default) for an upload that only makes an id.
  safeToRepeat?: boolean
  // The name Meta shows for the file; `upload` when left out. Only plain characters go (checked here too).
  fileName?: string
}

// The calls and checks the three Meta plugins share. The token is the connection's and arrives per
// call; the app secret and the verify token belong to the platform's one Meta app.
@Injectable()
export class MetaGraphClient {
  constructor(private readonly config: MetaAppConfig) {}

  // The secret is the one of the app that sends the webhook. Instagram's own app, when there is one, is
  // the only key for Instagram: the main key does not also pass there, or a leak of either would forge
  // what the other signs. Every other channel answers to the main key alone. The app is a required
  // argument: a channel that forgets to name its app does not compile instead of verifying with the wrong key.
  isValidSignature(rawBody: string, headers: Record<string, string>, app: MetaWebhookApp): boolean {
    const secret = this.signingSecretOf(app)
    return isValidMetaSignature(rawBody, headers[MetaWebhook.SIGNATURE_HEADER], secret)
  }

  // One case per app, and a new app that is not handled here does not compile
  private signingSecretOf(app: MetaWebhookApp): string | undefined {
    switch (app) {
      case MetaWebhookApps.INSTAGRAM:
        return this.config.instagramAppSecret ?? this.config.appSecret
      case MetaWebhookApps.MAIN:
        return this.config.appSecret
      default: {
        const unhandled: never = app
        throw new Error(`unhandled Meta app: ${String(unhandled)}`)
      }
    }
  }

  verifyHubChallenge(query: Record<string, string>): string | null {
    return answerMetaHandshake(query, this.config.verifyToken)
  }

  async get<T>(request: GraphRequest<T>): Promise<T> {
    return this.call('GET', request)
  }

  // The address of the login dialog of the app, for a `state` and a callback the core chose
  loginDialogUrl(params: { state: string; redirectUri: string; scope: string }): string {
    const { appId, graphVersion } = this.config
    if (appId === undefined) throw graphUnexpected()
    const query = new URLSearchParams({
      client_id: appId,
      redirect_uri: params.redirectUri,
      state: params.state,
      scope: params.scope,
      response_type: MetaOAuth.RESPONSE_TYPE
    })
    return `${MetaOAuth.DIALOG_ORIGIN}/${graphVersion}/${MetaOAuth.DIALOG_PATH}?${query.toString()}`
  }

  async post<T>(request: GraphRequest<T>): Promise<T> {
    return this.call('POST', request)
  }

  // The token endpoint of the login: the code of the dialog for the token of the person, and that one for a
  // token of about 60 days (`grant_type=fb_exchange_token`). It has no token to send, it proves the app with
  // its secret. The secret travels in the body of a POST, never in the address, which a proxy or a log may
  // keep. A code is good once, so a call that may have reached Meta is never repeated, and what Meta
  // answers is read for `access_token` alone: the rest, and the text of a refusal, are dropped.
  async exchangeToken(grant: Record<string, string>): Promise<string> {
    const { appId, appSecret } = this.config
    if (appId === undefined || appSecret === undefined) throw graphUnexpected()
    const response = await this.fetchOrFail(
      this.urlFor(MetaGraph.ORIGIN, MetaOAuth.TOKEN_EDGE.split('/'), undefined),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          ...grant,
          client_id: appId,
          client_secret: appSecret
        }).toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(MetaLimits.REQUEST_TIMEOUT_MS)
      },
      false
    )
    const body = await readJson(response)
    if (!response.ok) {
      const failure = graphFailure(response.status, body, { safeToRepeat: false })
      // A refusal of this endpoint (a code that was used, an app id or a secret that is wrong) never changes by
      // trying again: Meta words some of them with the codes it uses for its own outages, and the person must
      // not be told to wait for what is a setting
      const refused =
        response.status >= HTTP_CLIENT_ERROR_MIN &&
        response.status < HTTP_SERVER_ERROR_MIN &&
        response.status !== HTTP_TOO_MANY_REQUESTS
      if (refused && failure.reason === ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE) {
        throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
          retryable: false,
          providerCode: failure.providerCode,
          providerSubcode: failure.providerSubcode,
          reason: ChannelConnectFailureReasons.REQUEST_REJECTED
        })
      }
      throw failure
    }
    if (body === undefined) throw graphUnreachable({ safeToRepeat: false })
    const parsed = tokenAnswerSchema.safeParse(body)
    if (!parsed.success) throw graphUnreachable({ safeToRepeat: false })
    return parsed.data.access_token
  }

  // The method that worked on `debug_token`, kept for the life of the process so that the other one is not
  // tried on every call
  private debugMethod: { method: DebugMethod; until: number } | undefined
  // Questions are asked one at a time until a method is known: otherwise a burst would each try the POST and,
  // refused, each put its token in the address of a GET
  private debugQueue: Promise<unknown> = Promise.resolve()

  // What Meta says about a token (`GET /debug_token`): whether it is valid, whose kind it is and when it
  // stops. The app proves itself with `APP_ID|APP_SECRET`, sent as the Authorization header and nowhere else:
  // never in an address, a log or an error. The token that is asked about is a secret too, so it goes in the
  // body of a POST; `debug_token` documents only GET, so if Meta refuses the POST (recognised by the shape of
  // its error, not by its text) the same question is asked with GET, and only then does the token go in the
  // address, which is never logged or kept. Nothing of the answer is kept but the fields above.
  //
  // A failure is thrown as the error the core understands and says nothing about the token: the caller
  // takes it for "could not ask", never for "expired".
  async debugToken(inputToken: string): Promise<TokenInspection> {
    return (await this.debug(inputToken)).inspection
  }

  // The ids of the Pages the person ticked in the dialog of Facebook, from the same question: deduplicated, plain
  // ids only (they go into a path), at most `MetaOAuth.MAX_GRANTED_PAGES`. Only the permissions that target Pages.
  async grantedPageIds(inputToken: string): Promise<string[]> {
    return (await this.debug(inputToken)).pageIds
  }

  private async debug(inputToken: string): Promise<DebugResult> {
    if (this.knownDebugMethod() !== undefined) return this.askDebugToken(inputToken)
    const turn = this.debugQueue.then(
      () => this.askDebugToken(inputToken),
      () => this.askDebugToken(inputToken)
    )
    this.debugQueue = turn.catch(() => undefined)
    return turn
  }

  private knownDebugMethod(): DebugMethod | undefined {
    const known = this.debugMethod
    return known !== undefined && known.until > Date.now() ? known.method : undefined
  }

  private async askDebugToken(inputToken: string): Promise<DebugResult> {
    const { appId, appSecret } = this.config
    if (appId === undefined || appSecret === undefined) throw graphUnexpected()
    const appToken = `${appId}|${appSecret}`
    if (!HEADER_TOKEN.test(appToken) || !HEADER_TOKEN.test(inputToken)) throw graphUnexpected()
    const known = this.knownDebugMethod()
    const methods: DebugMethod[] = known === undefined ? ['POST', 'GET'] : [known]
    let last: PluginError | undefined
    for (const method of methods) {
      const response = await this.fetchOrFail(
        this.debugUrl(method, inputToken),
        {
          method,
          headers: {
            authorization: `Bearer ${appToken}`,
            ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
          },
          body:
            method === 'POST'
              ? new URLSearchParams({ [MetaGraph.DEBUG_TOKEN_INPUT_FIELD]: inputToken }).toString()
              : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(TokenExpiryLimits.REQUEST_TIMEOUT_MS)
        },
        true
      )
      const body = await readJson(response)
      if (!response.ok) {
        last = graphFailure(response.status, body, { safeToRepeat: true })
        // Another method is tried only when this one was refused for being the wrong method
        if (method === 'POST' && methods.includes('GET') && isMethodRejection(body)) continue
        throw last
      }
      if (body === undefined) throw graphUnreachable({ safeToRepeat: true })
      const parsed = debugAnswerSchema.safeParse(body)
      if (!parsed.success) throw graphUnexpected()
      const { data } = parsed.data
      // A token that works has a date (0: none); a missing one says nothing and is not taken for "never". One
      // that Meta says is not valid may come without it, and that is the answer.
      if (data.is_valid && data.expires_at === undefined) throw graphUnexpected()
      this.debugMethod = { method, until: Date.now() + MetaLimits.DEBUG_METHOD_MEMORY_MS }
      return {
        inspection: {
          kind: tokenKindOf(data.type),
          isValid: data.is_valid,
          expiresAt: !data.expires_at ? null : new Date(data.expires_at * 1000),
          scopes: (data.scopes ?? [])
            .filter(scope => scope.length > 0 && scope.length <= TokenExpiryLimits.SCOPE_MAX_LENGTH)
            .slice(0, TokenExpiryLimits.SCOPES_MAX)
        },
        pageIds: grantedPages(data.granular_scopes)
      }
    }
    throw last ?? graphUnexpected()
  }

  // The address of the call: the edge alone for a POST; with the token being asked about for a GET
  private debugUrl(method: DebugMethod, inputToken: string): string {
    return this.urlFor(
      MetaGraph.ORIGIN,
      [MetaGraph.DEBUG_TOKEN_EDGE],
      method === 'GET' ? { [MetaGraph.DEBUG_TOKEN_INPUT_FIELD]: inputToken } : undefined
    )
  }

  // Uploads one file as multipart/form-data and answers what Meta answers (the id of the media). The
  // body is streamed with an exact content-length, so a file of 100 MB never sits in memory, and the
  // stream is held to the size recorded for the file. An upload changes nothing the customer sees, so a
  // failure is worth trying again (the caller opens the file again: a stream is read once), unless the request
  // says `safeToRepeat: false` because the upload is also a send.
  async uploadMedia<T>(request: UploadRequest<T>): Promise<T> {
    if (!HEADER_TOKEN.test(request.token)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.TOKEN_NOT_HEADER_SAFE
      })
    }
    const { contentType, size } = request.file
    const fileField = request.fileField ?? MetaUpload.FILE_FIELD
    const safeToRepeat = request.safeToRepeat ?? true
    const fileName = request.fileName ?? MetaUpload.FILE_NAME
    // Nothing that reaches a header or a form line may carry a line break or a quote
    if (
      !MIME_TYPE.test(contentType) ||
      !FIELD_NAME.test(fileField) ||
      !FILE_NAME.test(fileName) ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MetaLimits.MEDIA_MAX_BYTES ||
      Object.entries(request.fields).some(
        ([name, value]) => !FIELD_NAME.test(name) || /[\r\n]/.test(value)
      )
    ) {
      throw graphUnexpected()
    }
    const url = this.urlFor(request.origin ?? MetaGraph.ORIGIN, request.path, undefined)
    const boundary = `${MetaUpload.BOUNDARY_PREFIX}${randomBytes(16).toString('hex')}`
    const head = Buffer.from(
      [
        ...Object.entries(request.fields).map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
        ),
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; ` +
          `filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`
      ].join('')
    )
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
    // Opened only now, after every refusal above
    // A storage that cannot give the file says so before anything reached Meta: a plain, repeatable failure
    // that carries nothing of the storage's own message (it may name the bucket or a signed link)
    const opened = await request.file.open().catch(() => {
      throw graphUnreachable({ safeToRepeat: true })
    })
    const source = opened instanceof Readable ? opened : Readable.from(opened)
    const limited = limitBytes(source, size, size)
    // Why the limiter stopped the stream, if it did: fetch only says that the call failed, and a file
    // that is not the size recorded is no network error to be tried again
    let stopped: unknown
    limited.on('error', error => {
      stopped = error
    })
    async function* multipart(): AsyncGenerator<Buffer> {
      yield head
      for await (const chunk of limited) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      }
      yield tail
    }
    try {
      let response: Response
      try {
        response = await this.fetchOrFail(
          url,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${request.token}`,
              'content-type': `${MetaUpload.FORM_CONTENT_TYPE}; boundary=${boundary}`,
              'content-length': String(head.length + size + tail.length)
            },
            body: Readable.toWeb(Readable.from(multipart())),
            duplex: 'half',
            redirect: 'manual',
            signal: AbortSignal.timeout(MetaLimits.UPLOAD_TIMEOUT_MS)
          },
          safeToRepeat
        )
      } catch (error) {
        // The stream failing on our side (the storage, a file not of the size recorded) means the body was
        // never complete, so nothing was sent. fetch can report its own abort before the stream's error
        // event has been handled: one turn of the loop settles which of the two came first.
        await new Promise<void>(resolve => setImmediate(resolve))
        const local = limited.errored ?? stopped
        throw local instanceof PluginError ? local : error
      }
      const body = await readJson(response)
      if (!response.ok) throw graphFailure(response.status, body, { safeToRepeat })
      // A 2xx that cannot be read or does not fit: an upload that only makes an id can be asked again, a
      // send may already have gone out
      if (body === undefined && !safeToRepeat) throw graphUnreachable({ safeToRepeat })
      const parsed = request.schema.safeParse(body)
      if (!parsed.success)
        throw safeToRepeat ? graphUnexpected() : graphUnreachable({ safeToRepeat })
      return parsed.data
    } finally {
      // On every way out: Meta may have answered before it read the whole body, and the object in the
      // bucket must not stay open
      limited.destroy()
    }
  }

  // GET /{media-id} answers a short-lived url; the file is behind it and wants the same token. The url
  // is Meta's word, so it is only followed to a Meta host over https, and a file bigger than the limit
  // is cut off instead of being read to the end.
  async downloadMedia(token: string, mediaId: string): Promise<FetchedMedia> {
    if (!MEDIA_ID.test(mediaId)) throw graphUnexpected()
    const info = await this.get({ path: [mediaId], token, schema: mediaInfoSchema })
    // The type is the one Meta declared in its authenticated answer, not the one the file server sends
    return this.downloadFile(info.url, token, info.file_size, info.mime_type)
  }

  // Messenger and Instagram put the url of the file in the webhook itself. It is a link of a Meta CDN
  // (or, for the GIFs of Instagram, of a listed GIF host) that needs no token, so none is sent; the type is the one the file server declares, because Meta
  // does not vouch for it here.
  async downloadMediaUrl(url: string): Promise<FetchedMedia> {
    // The link is the customer's: one that is not a Meta CDN or a listed GIF host is refused as any other unsafe link, not
    // counted as a failure of the fetch. (The url that Graph itself answers for a media id keeps the
    // check below, where a foreign host is an unexpected answer.)
    if (!isMetaMediaLink(url)) throw new UnsafeMediaLinkError()
    return this.downloadFile(url, undefined, undefined, undefined, true)
  }

  private async downloadFile(
    url: string,
    token: string | undefined,
    declaredSize: number | undefined,
    declaredType: string | undefined,
    // The link of a customer may be a GIF host; the url that Graph answers may not
    customerLink = false
  ): Promise<FetchedMedia> {
    const target = parseUrl(url)
    if (!target || !isMetaMediaUrl(target, customerLink)) throw graphUnexpected()
    if ((declaredSize ?? 0) > MetaLimits.MEDIA_MAX_BYTES) throw graphUnexpected()

    const response = await this.fetchOrFail(url, {
      method: 'GET',
      headers: {
        // Uncompressed, so that content-length is the length of the file and a cut-off one shows
        'accept-encoding': 'identity',
        // The token goes only where it is needed
        ...(token && MetaGraph.MEDIA_TOKEN_HOSTS.some(host => host === target.hostname)
          ? { authorization: `Bearer ${token}` }
          : {})
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(MetaLimits.MEDIA_TIMEOUT_MS)
    })
    if (!response.ok) {
      await discard(response)
      throw graphFileFailure(response.status)
    }
    // With a content-encoding the length is the compressed one, not the length of the stream
    const length = response.headers.has('content-encoding')
      ? null
      : parseLength(response.headers.get('content-length'))
    if (!response.body || (length ?? 0) > MetaLimits.MEDIA_MAX_BYTES) {
      await discard(response)
      throw graphUnexpected()
    }

    const source = Readable.fromWeb(response.body)
    return {
      stream: limitBytes(source, MetaLimits.MEDIA_MAX_BYTES, length),
      contentType: declaredType ?? mediaTypeOf(response.headers.get('content-type')),
      contentLength: length
    }
  }

  private async call<T>(method: 'GET' | 'POST', request: GraphRequest<T>): Promise<T> {
    // A token that cannot be a header makes fetch throw before any call, and it never will work
    if (!HEADER_TOKEN.test(request.token)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
        retryable: false,
        failedCheck: PluginChecks.TOKEN_NOT_HEADER_SAFE
      })
    }
    const url = this.urlFor(request.origin ?? MetaGraph.ORIGIN, request.path, request.query)
    const safeToRepeat = method === 'GET' || request.idempotent === true
    const response = await this.fetchOrFail(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${request.token}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: 'manual',
        signal:
          request.signal === undefined
            ? AbortSignal.timeout(MetaLimits.REQUEST_TIMEOUT_MS)
            : AbortSignal.any([AbortSignal.timeout(MetaLimits.REQUEST_TIMEOUT_MS), request.signal])
      },
      safeToRepeat
    )
    const body = await readJson(response)
    if (!response.ok) throw graphFailure(response.status, body, { safeToRepeat })
    // A 2xx whose body cannot be read: a read can be asked again, a send may already have gone out
    if (body === undefined) throw graphUnreachable({ safeToRepeat })
    const parsed = request.schema.safeParse(body)
    // A 2xx that does not fit: a send may have gone out, so it is not a plain refusal
    if (!parsed.success) throw safeToRepeat ? graphUnexpected() : graphUnreachable({ safeToRepeat })
    return parsed.data
  }

  private urlFor(
    origin: MetaGraphOrigin,
    path: readonly string[],
    query: Record<string, string> | undefined
  ): string {
    if (path.length === 0 || !path.every(segment => PATH_SEGMENT.test(segment))) {
      throw graphUnexpected()
    }
    // The config may replace the host with a fake one in a test; where it is deployed it is never set
    const host = this.config.graphOrigin ?? origin
    const base = `${host}/${this.config.graphVersion}/${path.join('/')}`
    return query ? `${base}?${new URLSearchParams(query).toString()}` : base
  }

  // A redirect is never followed: neither Graph nor a media host has a reason to send one, and the
  // token would travel with it. It is not retried either, the same call would be sent away again.
  private async fetchOrFail(
    url: string,
    init: RequestInit,
    safeToRepeat = true
  ): Promise<Response> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch {
      throw graphUnreachable({ safeToRepeat })
    }
    if (Math.floor(response.status / STATUS_CLASS) === REDIRECT_CLASS) {
      await discard(response)
      throw graphUnexpected()
    }
    return response
  }
}

function tokenKindOf(type: string | undefined): TokenInspection['kind'] {
  switch (type?.toUpperCase()) {
    case 'PAGE':
      return TokenKinds.PAGE
    case 'USER':
      return TokenKinds.USER
    default:
      return TokenKinds.UNKNOWN
  }
}

// The answer of an edge to a method it does not take: by the class of the error and its subcode
function isMethodRejection(body: unknown): boolean {
  const parsed = methodRejectionSchema.safeParse(body)
  return parsed.success && parsed.data.error.type === MetaErrorCodes.METHOD_REJECTED_ERROR_TYPE
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

// `image/jpeg; charset=binary` is `image/jpeg`; a missing or odd type is plain bytes
function mediaTypeOf(header: string | null): string {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? ''
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : MetaGraph.FALLBACK_CONTENT_TYPE
}

// Whether a link of a customer may be fetched: a Meta CDN or an exact host of the GIF list (so a true is
// not proof that the host is Meta's; the token is only ever sent to `MEDIA_TOKEN_HOSTS`): https, no port or credentials, a host of the
// list. Pure (no lookup, no call), so that it can run before anything touches the network.
export function isMetaMediaLink(link: string): boolean {
  const target = parseUrl(link)
  return target !== null && isMetaMediaUrl(target, true)
}

function isMetaMediaUrl(url: URL, customerLink = false): boolean {
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    (MetaGraph.MEDIA_TOKEN_HOSTS.some(host => host === url.hostname) ||
      MetaGraph.MEDIA_CDN_HOSTS.some(host => host === url.hostname) ||
      MetaGraph.MEDIA_CDN_SUFFIXES.some(suffix => url.hostname.endsWith(suffix)) ||
      (customerLink && MetaGraph.MEDIA_GIF_HOSTS.some(host => host === url.hostname)))
  )
}

// An answer that is refused is not read; closing it frees the connection
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

// `undefined` when the body cannot be read or is not json; an answer of `null` is a body
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function parseLength(header: string | null): number | null {
  // Number() takes '', ' ', '0x10' and '1e3'; a byte count is only digits
  if (header === null || !/^\d+$/.test(header)) return null
  const length = Number(header)
  return Number.isSafeInteger(length) && length >= 0 ? length : null
}
