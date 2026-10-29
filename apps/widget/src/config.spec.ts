import { readOptions } from './config'

const KEY = `pk_widget_${'A'.repeat(24)}`

function scriptWith(attributes: Record<string, string>): HTMLScriptElement {
  const script = document.createElement('script')
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value)
  return script
}

describe('readOptions', () => {
  it('reads the key, the api and the language of the snippet', () => {
    const options = readOptions(
      scriptWith({
        'data-site-key': KEY,
        'data-api-url': 'https://api.example.com/api/v1/',
        'data-locale': 'en'
      })
    )

    expect(options).toEqual({
      siteKey: KEY,
      apiUrl: 'https://api.example.com/api/v1',
      locale: 'en'
    })
  })

  it('leaves the language empty when the snippet does not name one', () => {
    const options = readOptions(
      scriptWith({ 'data-site-key': KEY, 'data-api-url': 'http://localhost:8080/api/v1' })
    )

    expect(options?.locale).toBeNull()
  })

  it.each([
    ['no script', null],
    ['no key', scriptWith({ 'data-api-url': 'https://api.example.com' })],
    [
      'a key of another kind',
      scriptWith({ 'data-site-key': 'abc', 'data-api-url': 'https://a.co' })
    ],
    ['no api', scriptWith({ 'data-site-key': KEY })],
    ['an api that is not a url', scriptWith({ 'data-site-key': KEY, 'data-api-url': 'api' })],
    [
      'an api in plain http outside the laptop',
      scriptWith({ 'data-site-key': KEY, 'data-api-url': 'http://api.example.com' })
    ]
  ])('stays out of the page with %s', (_name, script) => {
    expect(readOptions(script)).toBeNull()
  })
})
