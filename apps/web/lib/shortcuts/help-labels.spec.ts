import { AvailableShortcuts, Shortcuts } from '@platform/core/domain'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

type Labels = Record<string, Record<string, string>>

describe.each([
  ['en', en],
  ['es', es]
])('help sheet texts (%s)', (_name, messages) => {
  const labels = messages.inbox.shortcuts.labels as Labels

  it('has a label for each binding the sheet lists, and none for one it does not', () => {
    for (const [group, names] of Object.entries(AvailableShortcuts)) {
      expect(Object.keys(labels[group] ?? {}).sort()).toEqual([...names].sort())
    }
  })

  it('lists only bindings that exist in the table', () => {
    for (const [group, names] of Object.entries(AvailableShortcuts)) {
      const table = Shortcuts[group as keyof typeof Shortcuts] as Record<string, string>
      for (const name of names) expect(table[name]).toBeDefined()
    }
  })
})
