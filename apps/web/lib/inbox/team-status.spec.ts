import { PresenceStatus } from '@platform/core/realtime'

import { buildTeamRows } from './team-status'

const role = { id: 'r', name: 'Agent' }
const members = [
  { id: 'u1', name: 'Carlos', avatarMediaId: null, role },
  { id: 'u2', name: 'Ana', avatarMediaId: null, role },
  { id: 'u3', name: 'Maria', avatarMediaId: null, role }
]
const presence = [
  { userId: 'u1', status: PresenceStatus.ONLINE },
  { userId: 'u3', status: PresenceStatus.AWAY }
]

describe('buildTeamRows', () => {
  it('puts who is online first, then away, then offline, each by name', () => {
    const rows = buildTeamRows({
      members,
      presence,
      activeByAgent: [],
      threshold: null,
      showLoad: false
    })

    expect(rows.map(row => row.name)).toEqual(['Carlos', 'Maria', 'Ana'])
    expect(rows.map(row => row.status)).toEqual([
      PresenceStatus.ONLINE,
      PresenceStatus.AWAY,
      PresenceStatus.OFFLINE
    ])
  })

  it('gives no load to who may not see every conversation', () => {
    const rows = buildTeamRows({
      members,
      presence,
      activeByAgent: [{ userId: 'u1', count: 9 }],
      threshold: 8,
      showLoad: false
    })

    expect(rows.every(row => row.active === null && !row.isOverThreshold)).toBe(true)
  })

  it('counts zero for who holds nothing and flags a load that reached the threshold', () => {
    const rows = buildTeamRows({
      members,
      presence,
      activeByAgent: [
        { userId: 'u1', count: 8 },
        { userId: 'u3', count: 7 }
      ],
      threshold: 8,
      showLoad: true
    })

    expect(rows.map(row => [row.name, row.active, row.isOverThreshold])).toEqual([
      ['Carlos', 8, true],
      ['Maria', 7, false],
      ['Ana', 0, false]
    ])
  })

  it('does not flag anyone while the threshold is unknown', () => {
    const rows = buildTeamRows({
      members,
      presence,
      activeByAgent: [{ userId: 'u1', count: 50 }],
      threshold: null,
      showLoad: true
    })

    expect(rows.some(row => row.isOverThreshold)).toBe(false)
  })
})
