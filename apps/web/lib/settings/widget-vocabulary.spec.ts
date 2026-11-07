import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const texts = (locale: string): string[] => {
  const found: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') found.push(value)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(JSON.parse(readFileSync(resolve(__dirname, `../../messages/${locale}.json`), 'utf8')))
  return found
}

// The owner's vocabulary: the channel of the page is the "Web widget" ("Widget web" in Spanish), never a
// "chat widget" ("widget de chat", "widget del chat"). The text of the whole message file is checked, so a
// new screen cannot bring the other name back.
describe.each([
  ['en', [/chat widget/i, /live chat widget/i]],
  ['es', [/widget de chat/i, /widget del chat/i, /chat widget/i]]
] as const)('the name of the web widget in %s', (locale, banned) => {
  const all = texts(locale)

  it('has texts to check', () => {
    expect(all.length).toBeGreaterThan(1000)
  })

  it.each(banned)('never uses %s', pattern => {
    expect(all.filter(text => pattern.test(text))).toEqual([])
  })
})
