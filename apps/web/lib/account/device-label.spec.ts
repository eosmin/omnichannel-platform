import { deviceLabel, rawDeviceText } from './device-label'

const FIREFOX_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/130.0.0.0`
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

describe('device label', () => {
  it.each([
    [FIREFOX_MAC, 'Firefox', 'macOS'],
    [CHROME_WINDOWS, 'Chrome', 'Windows'],
    [EDGE_WINDOWS, 'Edge', 'Windows'],
    [SAFARI_IPHONE, 'Safari', 'iOS'],
    [CHROME_ANDROID, 'Chrome', 'Android']
  ])('names %#', (userAgent, browser, system) => {
    expect(deviceLabel(userAgent)).toEqual({ browser, system })
  })

  it('gives null for no user agent or one it does not know', () => {
    expect(deviceLabel(null)).toBeNull()
    expect(deviceLabel('curl/8.4.0')).toBeNull()
  })

  it('cuts a long raw text and drops an empty one', () => {
    expect(rawDeviceText('x'.repeat(200))).toHaveLength(81)
    expect(rawDeviceText('curl/8.4.0')).toBe('curl/8.4.0')
    expect(rawDeviceText('  ')).toBeNull()
    expect(rawDeviceText(null)).toBeNull()
  })
})
