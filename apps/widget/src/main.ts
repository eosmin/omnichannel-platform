import { io } from 'socket.io-client'

import { WidgetApi } from './api'
import { ChatLog } from './chat-log'
import { readOptions } from './config'
import { resolveLocale, textFor } from './i18n'
import { Session, type SocketFactory } from './session'
import { mountPanel } from './ui/panel'
import { browserStorage, loadVisitorId } from './visitor'

// Replies come on a socket of their own namespace, over websocket alone: no long polling, so the api
// needs no sticky sessions
const createSocket: SocketFactory = (url, namespace, auth) =>
  io(`${url}${namespace}`, { transports: ['websocket'], auth })

// Captured now: `document.currentScript` is empty once this script has run
const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null

async function run(): Promise<void> {
  const options = readOptions(script)
  if (options === null) return
  const log = new ChatLog()
  const session = new Session({
    siteKey: options.siteKey,
    visitorId: loadVisitorId(browserStorage()),
    api: new WidgetApi(options.apiUrl),
    log,
    socketUrl: new URL(options.apiUrl).origin,
    createSocket,
    newMessageId: () => crypto.randomUUID()
  })
  const boot = await session.start()
  if (boot === null) return
  const panel = mountPanel({
    storeName: boot.store.name,
    text: textFor(resolveLocale(options.locale, boot.store.locale, navigator.language)),
    away: boot.away,
    onSend: content => void session.send(content),
    onRetry: key => void session.retry(key)
  })
  if (panel === null) {
    session.stop()
    return
  }
  panel.update(log.messages)
  log.subscribe(messages => panel.update(messages))
}

void run()
