import { hostOf } from './link-host'

describe('hostOf', () => {
  it('gives the host of an http or https link', () => {
    expect(hostOf('https://www.instagram.com/p/abc/?x=1')).toBe('www.instagram.com')
    expect(hostOf('http://example.com:8080/a')).toBe('example.com:8080')
  })

  it('gives null for what is not a plain web link', () => {
    expect(hostOf('javascript:alert(1)')).toBeNull()
    expect(hostOf('data:text/html,<b>x</b>')).toBeNull()
    expect(hostOf('not a link')).toBeNull()
  })
})
