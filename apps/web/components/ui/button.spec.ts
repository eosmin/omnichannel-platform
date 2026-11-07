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
})
