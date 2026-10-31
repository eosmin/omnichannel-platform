import { io } from 'socket.io-client'

import { WidgetApi } from './api'
import { ChatLog } from './chat-log'
import { readOptions } from './config'
import { resolveLocale, textFor } from './i18n'
import { Session, type SocketFactory } from './session'
import { mountPanel } from './ui/panel'
import { browserStorage, loadVisitorId, markPreChatDone, preChatDone } from './visitor'

// Replies come on a socket of their own namespace, over websocket alone: no long polling, so the api
// needs no sticky sessions
const createSocket: SocketFactory = (url, namespace, auth) =>
  io(`${url}${namespace}`, { transports: ['websocket'], auth })

// Captured now: `document.currentScript` is empty once this script has run
const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null

async function run(): Promise<void> {
  const options = readOptions(script)
  if (options === null) return
  const storage = browserStorage()
  const log = new ChatLog()
  const session = new Session({
    siteKey: options.siteKey,
    visitorId: loadVisitorId(storage),
    api: new WidgetApi(options.apiUrl),
    log,
    socketUrl: new URL(options.apiUrl).origin,
    createSocket,
    newMessageId: () => crypto.randomUUID(),
    // Answered for good only once the api has the data: a tab closed before the first message asks again
    onProfileSent: () => markPreChatDone(storage)
  })
  const boot = await session.start()
  if (boot === null) return
  const panel = mountPanel({
    storeName: boot.store.name,
    text: textFor(resolveLocale(options.locale, boot.store.locale, navigator.language)),
    away: boot.away,
    // Asked once, and only of someone who has not spoken yet: a visitor with a history is not a stranger
    preChat: boot.preChat && !preChatDone(storage) && log.messages.length === 0,
    onProfile: profile => {
      session.setProfile(profile)
      // Nothing typed, nothing to send: the visitor skipped the form
      if (Object.keys(profile).length === 0) markPreChatDone(storage)
    },
    onSend: content => void session.send(content),
    onRetry: key => void session.retry(key),
    onTyping: () => session.typing()
  })
  if (panel === null) {
    session.stop()
    return
  }
  session.onAgentTyping(active => panel.setAgentTyping(active))
  panel.update(log.messages)
  log.subscribe(messages => panel.update(messages))
}

void run()
