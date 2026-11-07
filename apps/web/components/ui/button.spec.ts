import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { Button } from './button'

describe('Button', () => {
  it('renders a link given as the child of an asChild button (Slot takes one child)', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { asChild: true }, createElement('a', { href: '/x' }, 'Go'))
    )
    expect(html).toContain('<a ')
    expect(html).toContain('href="/x"')
  })

  it('ignores busy on an asChild button: a link has no such state', () => {
    const html = renderToStaticMarkup(
      createElement(Button, { asChild: true, busy: true }, createElement('a', { href: '/x' }, 'Go'))
    )
    expect(html).not.toContain('busy-spinner')
    expect(html).not.toContain('aria-busy')
  })

  it('turns a busy button off and shows the spinner before its label', () => {
    const html = renderToStaticMarkup(createElement(Button, { busy: true }, 'Save'))
    expect(html).toContain('disabled=""')
    expect(html).toContain('aria-busy="true"')
    expect(html.indexOf('busy-spinner')).toBeLessThan(html.indexOf('Save'))
  })

  it('renders a plain button with no spinner', () => {
    const html = renderToStaticMarkup(createElement(Button, null, 'Save'))
    expect(html).not.toContain('busy-spinner')
    expect(html).toContain('type="button"')
  })

  // The size of a busy button must not change when the spinner shows (a layout jump). jsdom has no layout, so
  // the case that measures it is in `apps/web-e2e/specs/busy-button.spec.ts`; this one keeps the rule from
  // being undone in the CSS: the spinner is laid over the button, never beside the label
  it('lays the spinner over the button and keeps the label in the flow, so the size never changes', () => {
    const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8')
    const rule = (selector: string): string =>
      new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    expect(rule('.busy-spinner')).toMatch(/position:\s*absolute/)
    expect(rule('.busy-spinner')).not.toMatch(/max-width|margin/)
    const html = renderToStaticMarkup(createElement(Button, { busy: true }, 'Save'))
    expect(html).toContain('class="busy-label"')
  })
})
