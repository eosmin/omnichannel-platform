import {
  DEFAULT_SIDEBAR_LAYOUT,
  moveWidget,
  parseSidebarLayout,
  setWidgetHidden,
  SidebarWidgets
} from './sidebar-widgets'

describe('parseSidebarLayout', () => {
  it('gives the default when nothing is stored or what is stored is not a layout', () => {
    expect(parseSidebarLayout(null)).toEqual(DEFAULT_SIDEBAR_LAYOUT)
    expect(parseSidebarLayout('not json')).toEqual(DEFAULT_SIDEBAR_LAYOUT)
    expect(parseSidebarLayout('{"id":"teamStatus"}')).toEqual(DEFAULT_SIDEBAR_LAYOUT)
  })

  it('keeps the order and the hidden widgets that were stored', () => {
    const stored = JSON.stringify([
      { id: SidebarWidgets.TEAM_STATUS, isHidden: true },
      { id: SidebarWidgets.UNASSIGNED_QUEUE, isHidden: false }
    ])

    expect(parseSidebarLayout(stored)).toEqual([
      { id: SidebarWidgets.TEAM_STATUS, isHidden: true },
      { id: SidebarWidgets.UNASSIGNED_QUEUE, isHidden: false },
      { id: SidebarWidgets.QUICK_ACTIONS, isHidden: false }
    ])
  })

  it('drops unknown and repeated widgets and appends the ones it lacks, shown', () => {
    const stored = JSON.stringify([
      'junk',
      null,
      { id: 'gone', isHidden: false },
      { id: SidebarWidgets.TEAM_STATUS, isHidden: true },
      { id: SidebarWidgets.TEAM_STATUS, isHidden: false }
    ])

    expect(parseSidebarLayout(stored)).toEqual([
      { id: SidebarWidgets.TEAM_STATUS, isHidden: true },
      { id: SidebarWidgets.QUICK_ACTIONS, isHidden: false },
      { id: SidebarWidgets.UNASSIGNED_QUEUE, isHidden: false }
    ])
  })
})

describe('moveWidget', () => {
  it('swaps a widget with its neighbour', () => {
    const moved = moveWidget(DEFAULT_SIDEBAR_LAYOUT, SidebarWidgets.TEAM_STATUS, -1)

    expect(moved.map(entry => entry.id)).toEqual([
      SidebarWidgets.QUICK_ACTIONS,
      SidebarWidgets.TEAM_STATUS,
      SidebarWidgets.UNASSIGNED_QUEUE
    ])
  })

  it('leaves the layout as it is at either end', () => {
    expect(moveWidget(DEFAULT_SIDEBAR_LAYOUT, SidebarWidgets.QUICK_ACTIONS, -1)).toBe(
      DEFAULT_SIDEBAR_LAYOUT
    )
    expect(moveWidget(DEFAULT_SIDEBAR_LAYOUT, SidebarWidgets.TEAM_STATUS, 1)).toBe(
      DEFAULT_SIDEBAR_LAYOUT
    )
  })
})

describe('setWidgetHidden', () => {
  it('hides and shows one widget without touching the others', () => {
    const hidden = setWidgetHidden(DEFAULT_SIDEBAR_LAYOUT, SidebarWidgets.TEAM_STATUS, true)

    expect(hidden.find(entry => entry.id === SidebarWidgets.TEAM_STATUS)?.isHidden).toBe(true)
    expect(hidden.find(entry => entry.id === SidebarWidgets.UNASSIGNED_QUEUE)?.isHidden).toBe(false)
    expect(setWidgetHidden(hidden, SidebarWidgets.TEAM_STATUS, false)).toEqual(
      DEFAULT_SIDEBAR_LAYOUT.map(entry => ({ ...entry, isHidden: false }))
    )
  })
})
