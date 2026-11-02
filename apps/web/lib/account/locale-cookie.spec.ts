import { hasLocaleCookie, localeCookieValue, localeToAdopt } from './locale-cookie'

describe('locale cookie', () => {
  it('writes a lax cookie for the whole site that lasts a year', () => {
    expect(localeCookieValue('es')).toBe(
      'platform_locale=es; Path=/; Max-Age=31536000; SameSite=Lax'
    )
  })

  it('finds its own cookie among others and not a lookalike', () => {
    expect(hasLocaleCookie('a=1; platform_locale=en; b=2')).toBe(true)
    expect(hasLocaleCookie('a=1; xplatform_locale=en')).toBe(false)
    expect(hasLocaleCookie('')).toBe(false)
  })

  it('adopts the saved language only on a browser with no cookie and a different language', () => {
    expect(localeToAdopt('', 'en', 'es')).toBe('en')
    expect(localeToAdopt('', 'es', 'es')).toBeNull()
    expect(localeToAdopt('platform_locale=es', 'en', 'es')).toBeNull()
  })

  it('never adopts a language the app has no messages for', () => {
    expect(localeToAdopt('', 'pt-BR', 'es')).toBeNull()
    expect(localeToAdopt('', 'xx', 'es')).toBeNull()
  })
})
