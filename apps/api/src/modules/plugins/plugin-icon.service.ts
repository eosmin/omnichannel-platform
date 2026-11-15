import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PluginIconLimits, pluginIconKey } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { StorageService } from '@platform/core/storage-module'
import { BodyTooLarge, pinnedHttpsGet, readLimited } from '@platform/core/url-safety'
import { PluginIconRefused, renderPluginIcon } from '@platform/plugins/runtime'

const ACCEPT = 'image/png,image/jpeg,image/svg+xml'

function refused(message: string): PlatformException {
  return new PlatformException(ErrorCodes.PLUGIN_ICON_INVALID, message, HttpStatusCodes.BAD_REQUEST)
}

// The icon of a channel plugin: fetched once when the plugin is registered and kept as the platform's own 128 px PNG
// (TDD_10 §6.7.2). The address is the author's, so it is fetched like any link that came from outside: plain https, a
// public address that is resolved once and the only one connected to, no redirect, a time limit and a size limit.
@Injectable()
export class PluginIconService {
  constructor(
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginIconService.name)
  }

  // The PNG for the address, or a 400 `PLUGIN_ICON_INVALID`. Nothing is stored here.
  async fetch(address: string): Promise<Buffer> {
    // One deadline for the whole fetch, headers and body: the idle timeout of the socket alone lets a host that sends a
    // byte every few seconds hold the request for as long as it likes
    let timer: NodeJS.Timeout | undefined
    let body: { destroy: () => void } | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        body?.destroy()
        reject(refused('the icon took too long'))
      }, PluginIconLimits.FETCH_TIMEOUT_MS)
    })
    const work = async (): Promise<Buffer> => {
      const response = await pinnedHttpsGet(address, {
        accept: ACCEPT,
        timeoutMs: PluginIconLimits.FETCH_TIMEOUT_MS
      })
      body = response.stream
      if (response.contentLength !== null && response.contentLength > PluginIconLimits.MAX_BYTES) {
        response.stream.destroy()
        throw refused('the icon is bigger than the limit')
      }
      return renderPluginIcon(await readLimited(response.stream, PluginIconLimits.MAX_BYTES))
    }
    try {
      return await Promise.race([work(), deadline])
    } catch (error) {
      if (error instanceof PlatformException) throw error
      if (error instanceof BodyTooLarge) throw refused('the icon is bigger than the limit')
      if (error instanceof PluginIconRefused) throw refused(error.message)
      // The address is the author's and is not logged: it may carry a token
      this.logger.warn(
        { errorName: error instanceof Error ? error.name : 'unknown' },
        'a plugin icon could not be fetched'
      )
      throw refused('the icon could not be fetched')
    } finally {
      clearTimeout(timer)
    }
  }

  // Under a key of the platform, never under a store, and always the PNG the platform made
  async store(pluginId: string, png: Buffer): Promise<string> {
    const key = pluginIconKey(pluginId)
    await this.storage.put(key, png, PluginIconLimits.CONTENT_TYPE)
    return key
  }
}
