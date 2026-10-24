import { Events } from './event-names'

describe('Events', () => {
  it('uses unique dotted names', () => {
    const names: string[] = Object.values(Events)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
  })

  it('has no billing, AI, staff or maintenance events', () => {
    const forbidden =
      /(subscription|invoice|trial|quota|ai_|impersonation|feature_flag|platform_setting|maintenance|password)/
    expect(Object.values(Events).filter(name => forbidden.test(name))).toEqual([])
  })

  it('names every key after its value', () => {
    for (const [key, value] of Object.entries(Events)) {
      expect(key).toBe(value.replace('.', '_').toUpperCase())
    }
  })
})
