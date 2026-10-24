import { RealtimeEvents, realtimeEventMapIsComplete } from './realtime-events'
import { RealtimeNamespaces, RoomNames } from './room-names'

describe('RealtimeEvents', () => {
  it('keeps its payload map complete (checked at compile time)', () => {
    expect(realtimeEventMapIsComplete).toBe(true)
  })

  it('uses unique event names', () => {
    const names: string[] = Object.values(RealtimeEvents)
    expect(new Set(names).size).toBe(names.length)
  })

  it('has no impersonation banner event', () => {
    expect(Object.keys(RealtimeEvents)).not.toContain('IMPERSONATION_STATUS')
  })
})

describe('RoomNames', () => {
  it('prefixes every room so ids of different kinds never collide', () => {
    expect(RoomNames.store('s1')).toBe('store:s1')
    expect(RoomNames.user('u1')).toBe('user:u1')
    expect(RoomNames.conversation('c1')).toBe('conv:c1')
    expect(RoomNames.widgetVisitor('conn', 'v1')).toBe('widget:conn:v1')
  })

  it('keeps the agent and widget namespaces apart', () => {
    expect(RealtimeNamespaces.AGENTS).not.toBe(RealtimeNamespaces.WIDGET)
  })
})
