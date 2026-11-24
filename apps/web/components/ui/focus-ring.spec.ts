import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const WEB = resolve(__dirname, '../..')
const read = (path: string): string => readFileSync(resolve(WEB, path), 'utf8')

// WCAG 1.4.11: the ring that shows where the focus is must be 3:1 against what it is drawn on. The tokens are greys, so the luminance
// of oklch(L 0 0) is L cubed (the grey of Oklab is linear L^3).
const luminanceOf = (lightness: number): number => lightness ** 3
const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

function tokenIn(block: string, name: string): number {
  const found = new RegExp(`${name}:\\s*oklch\\(([0-9.]+) 0 0\\)`).exec(block)
  if (found?.[1] === undefined) throw new Error(`${name} is not a grey oklch in the block`)
  return Number(found[1])
}

describe('the focus ring', () => {
  const css = read('app/globals.css')
  const light = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const dark = /\.dark\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''

  it.each([
    ['light', light],
    ['dark', dark]
  ])('has 3:1 against the page in the %s theme', (_name, block) => {
    const ring = tokenIn(block, '--ring')
    const background = tokenIn(block, '--background')
    expect(contrast(luminanceOf(ring), luminanceOf(background))).toBeGreaterThanOrEqual(3)
  })

  // A ring drawn at half opacity on white is about 1.8:1 whatever the token: the controls draw it whole
  it.each([
    'components/ui/button.tsx',
    'components/ui/input.tsx',
    'components/ui/textarea.tsx',
    'components/ui/field-classes.ts',
    'components/search/search-box.tsx'
  ])('is not drawn at half opacity in %s', path => {
    const source = read(path)
    expect(source).toContain('focus-visible:ring-ring')
    expect(source).not.toMatch(/ring-ring\/\d+/)
  })
})
