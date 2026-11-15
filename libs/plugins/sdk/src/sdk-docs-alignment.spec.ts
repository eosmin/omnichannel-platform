import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type InterfaceDeclaration,
  ScriptTarget,
  createSourceFile,
  isIdentifier,
  isInterfaceDeclaration
} from 'typescript'

import { ShipmentCreationModes } from './carrier-plugin.interface'
import { ChannelCapability } from './channel-capability'
import { ChannelEventTypes } from './channel-types'

// The SDK is the contract of a third-party plugin (TDD_10 §2, TDD_17 §4.1). What the core relies on has to be
// declared there and written in the TDD, so that nothing exists only for the official plugins. This reads the
// documents and the sources as text: adding a capability, an event type or a plugin member without documenting
// it, in the place it belongs, fails here (Step 5.6, SDK audit).
const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

// The text between a heading and the next one of the same level, so a value is looked for where it is documented
function section(doc: string, heading: string, next: string): string {
  const start = doc.indexOf(heading)
  const end = doc.indexOf(next, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return doc.slice(start, end)
}

// The members of an interface, read with the compiler (not a pattern: modifiers, nesting and formatting do not matter)
function membersOf(path: string, interfaceName: string): string[] {
  const file = createSourceFile(path, read(path), ScriptTarget.Latest, true)
  const found = file.statements.find(
    (statement): statement is InterfaceDeclaration =>
      isInterfaceDeclaration(statement) && statement.name.text === interfaceName
  )
  expect(found).toBeDefined()
  return (found?.members ?? []).flatMap(member =>
    member.name !== undefined && isIdentifier(member.name) ? [member.name.text] : []
  )
}

const declares = (doc: string, member: string): boolean =>
  new RegExp(`\\b${member}\\??[(:]`).test(doc)

describe('SDK and TDD alignment', () => {
  const channelDoc = read('docs/TDD_10_Plugins.md')
  const sdkSection = section(channelDoc, '## 2. Plugin SDK', '## 3. Plugin registry')
  const carrierDoc = read('docs/TDD_17_Shipping.md')

  it('documents every channel capability, key and value, in the SDK section', () => {
    for (const [key, value] of Object.entries(ChannelCapability)) {
      expect(sdkSection).toContain(`${key}: '${value}'`)
    }
  })

  it('documents every channel event type, key and value, in the SDK section', () => {
    for (const [key, value] of Object.entries(ChannelEventTypes)) {
      expect(sdkSection).toContain(`${key}: '${value}'`)
    }
  })

  it('documents every member of ChannelPlugin in the SDK section', () => {
    const members = membersOf('libs/plugins/sdk/src/channel-plugin.interface.ts', 'ChannelPlugin')
    expect(members.length).toBeGreaterThan(20)
    expect(members.filter(member => !declares(sdkSection, member))).toEqual([])
  })

  it('lists in the registry snippet every capability the registry checks a method for', () => {
    const registry = read('libs/plugins/runtime/src/plugin-registry.ts')
    const pairs = [...registry.matchAll(/\[ChannelCapability\.([A-Z_]+), '([A-Za-z]+)'\]/g)]
    expect(pairs.length).toBeGreaterThan(5)
    const snippet = section(channelDoc, '## 3. Plugin registry', '## 4. ')
    for (const [, capability, method] of pairs) {
      expect(snippet).toContain(`[ChannelCapability.${capability}, '${method}']`)
    }
  })

  it('documents every member of CarrierPlugin and every creation mode', () => {
    const members = membersOf('libs/plugins/sdk/src/carrier-plugin.interface.ts', 'CarrierPlugin')
    expect(members.length).toBeGreaterThan(20)
    expect(members.filter(member => !declares(carrierDoc, member))).toEqual([])
    for (const mode of Object.values(ShipmentCreationModes)) {
      expect(carrierDoc).toContain(mode)
    }
  })
})
