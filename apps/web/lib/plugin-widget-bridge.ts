import { ApiError } from '@platform/api-client'
import {
  PluginBridgeFailures,
  type PluginBridgeFailure,
  PluginBridgeMessages,
  pluginBridgeReadySchema,
  type PluginBridgeRequest,
  pluginBridgeRequestSchema,
  type PluginBridgeResponse,
  type PluginBridgeSessionMessage,
  PluginWidgetQuery,
  PluginWidgetTimings
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

// The page side of a plugin widget (TDD_10 §7). The frame is a document of another origin: it gets one port, over
// which it hears the session and asks for what it needs, and it never gets the API key or a token in its url.
// Nothing a frame says is trusted: a message that is not exactly one of ours is dropped without an answer.

export const WidgetStatuses = {
  CONNECTING: 'connecting',
  READY: 'ready',
  // The frame never answered the INIT: blocked by the plugin's own headers, down, or not a widget
  UNRESPONSIVE: 'unresponsive',
  // No session could be opened for it
  FAILED: 'failed'
} as const
export type WidgetStatus = (typeof WidgetStatuses)[keyof typeof WidgetStatuses]

export interface WidgetSessionGrant {
  token: string
  expiresInSeconds: number
}

// What the bridge needs of an iframe: the window it can post the port to
export interface WidgetFrame {
  contentWindow: Pick<Window, 'postMessage'> | null
}

export interface WidgetBridgeOptions {
  frame: WidgetFrame
  // The origin of the manifest's url: the port is offered to a document of this origin and to no other
  widgetOrigin: string
  widgetId: string
  conversationId: string
  openSession: () => Promise<WidgetSessionGrant>
  // The session token and the request the frame made, forwarded to the api on the agent's own session
  call: (token: string, request: PluginBridgeRequest) => Promise<PluginBridgeResponse>
  onStatus: (status: WidgetStatus) => void
  // Injectable for the tests
  createChannel?: () => MessageChannel
}

export interface WidgetBridge {
  close: () => void
}

// The url the frame loads: the manifest's, plus the conversation and the widget as query parameters (an id is not a
// secret; the token is never in the url)
export function widgetFrameUrl(base: string, widgetId: string, conversationId: string): string {
  const url = new URL(base)
  url.searchParams.set(PluginWidgetQuery.CONVERSATION_ID, conversationId)
  url.searchParams.set(PluginWidgetQuery.WIDGET_ID, widgetId)
  return url.toString()
}

// What a frame is told when its request did not return data: a code it can act on, never the api's own text
export function failureOf(error: unknown): PluginBridgeFailure {
  if (!(error instanceof ApiError)) return PluginBridgeFailures.FAILED
  if (error.code === ErrorCodes.PLUGIN_WIDGET_SESSION_INVALID) {
    return PluginBridgeFailures.SESSION_INVALID
  }
  if (error.code === ErrorCodes.PLUGIN_SCOPE_DENIED || error.status === HttpStatusCodes.FORBIDDEN) {
    return PluginBridgeFailures.SCOPE_DENIED
  }
  if (error.status === HttpStatusCodes.TOO_MANY_REQUESTS) return PluginBridgeFailures.RATE_LIMITED
  if (error.status === HttpStatusCodes.NOT_FOUND) return PluginBridgeFailures.NOT_FOUND
  return PluginBridgeFailures.FAILED
}

// Opens the channel, offers one port to the frame, and keeps the session fresh over it until closed. Call it when the
// frame has loaded (again on every load: a frame that navigates loses its port) and close it when the panel goes away.
export function connectWidget(options: WidgetBridgeOptions): WidgetBridge {
  const { frame, widgetOrigin, widgetId, conversationId, openSession, call, onStatus } = options
  const target = frame.contentWindow
  if (target === null) {
    // No window to offer a port to: nothing was opened, so there is nothing to close
    onStatus(WidgetStatuses.CONNECTING)
    onStatus(WidgetStatuses.UNRESPONSIVE)
    return { close: () => undefined }
  }
  const channel = (options.createChannel ?? (() => new MessageChannel()))()
  const port = channel.port1
  let closed = false
  let ready = false
  let token: string | null = null
  const timers: { renew?: ReturnType<typeof setTimeout>; ready?: ReturnType<typeof setTimeout> } =
    {}

  const say = (status: WidgetStatus): void => {
    if (!closed) onStatus(status)
  }

  const sendSession = (grant: WidgetSessionGrant): void => {
    token = grant.token
    const message: PluginBridgeSessionMessage = {
      type: PluginBridgeMessages.SESSION,
      token: grant.token,
      expiresInSeconds: grant.expiresInSeconds,
      widgetId,
      conversationId
    }
    port.postMessage(message)
  }

  // A new session before the old one ends; if it cannot be opened the old one keeps working until it expires, and
  // the page tries again soon, so a blip of the network does not blank the widget
  // It keeps trying while there is no session at all (a first failure says FAILED once, a later success clears it) and
  // is also what a request answered "session invalid" asks for, so a tab that slept past the lifetime recovers at once
  // and not when its frozen timer wakes. One at a time.
  let renewing = false
  let failed = false
  const renew = async (): Promise<void> => {
    if (closed || renewing) return
    renewing = true
    clearTimeout(timers.renew)
    try {
      const grant = await openSession()
      if (closed) return
      sendSession(grant)
      if (failed) {
        failed = false
        say(ready ? WidgetStatuses.READY : WidgetStatuses.CONNECTING)
      }
      // Half the lifetime at the least: a short lifetime must not become a loop with no pause
      const wait = Math.max(
        grant.expiresInSeconds * 1000 - PluginWidgetTimings.RENEW_MARGIN_MS,
        grant.expiresInSeconds * 500
      )
      timers.renew = setTimeout(() => void renew(), wait)
    } catch (error) {
      if (closed) return
      // The widget is gone (hidden, uninstalled, revoked): trying again changes nothing, and the panel is told once
      if (
        error instanceof ApiError &&
        (error.status === HttpStatusCodes.NOT_FOUND || error.status === HttpStatusCodes.GONE)
      ) {
        failed = true
        token = null
        say(WidgetStatuses.FAILED)
        return
      }
      if (token === null && !failed) {
        failed = true
        say(WidgetStatuses.FAILED)
      }
      timers.renew = setTimeout(() => void renew(), PluginWidgetTimings.RENEW_RETRY_MS)
    } finally {
      renewing = false
    }
  }

  const answer = (response: PluginBridgeResponse): void => {
    if (!closed) port.postMessage(response)
  }

  port.onmessage = (event: MessageEvent<unknown>): void => {
    if (closed) return
    if (pluginBridgeReadySchema.safeParse(event.data).success) {
      if (!ready) {
        ready = true
        clearTimeout(timers.ready)
        say(WidgetStatuses.READY)
      }
      return
    }
    const request = pluginBridgeRequestSchema.safeParse(event.data)
    if (!request.success) return
    const current = token
    if (current === null) {
      answer({
        type: PluginBridgeMessages.RESPONSE,
        id: request.data.id,
        ok: false,
        failure: PluginBridgeFailures.SESSION_INVALID
      })
      return
    }
    // A frame that asks before it said READY is still a frame that took the port
    if (!ready) {
      ready = true
      clearTimeout(timers.ready)
      say(WidgetStatuses.READY)
    }
    void call(current, request.data).then(
      response => answer(response),
      (error: unknown) => {
        const failure = failureOf(error)
        answer({
          type: PluginBridgeMessages.RESPONSE,
          id: request.data.id,
          ok: false,
          failure
        })
        if (failure === PluginBridgeFailures.SESSION_INVALID) void renew()
      }
    )
  }

  say(WidgetStatuses.CONNECTING)
  // targetOrigin is the widget's origin: if the frame has navigated elsewhere the browser drops the message and the
  // port never leaves this page
  target.postMessage({ type: PluginBridgeMessages.INIT }, widgetOrigin, [channel.port2])
  timers.ready = setTimeout(() => {
    if (!ready) say(WidgetStatuses.UNRESPONSIVE)
  }, PluginWidgetTimings.INIT_TIMEOUT_MS)
  void renew()

  return {
    close: () => {
      closed = true
      token = null
      clearTimeout(timers.renew)
      clearTimeout(timers.ready)
      port.onmessage = null
      port.close()
    }
  }
}
