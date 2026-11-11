import { createRequire } from 'node:module'

import { Linter } from 'eslint'
import { parser } from 'typescript-eslint'

// The rule of eslint.config.js that keeps a checkbox or switch of apps/web from carrying its initial state (TDD_17
// §4.14), run as the linter runs it
const { webControlsPlugin } = createRequire(__filename)('../../eslint-web-controls.cjs') as {
  webControlsPlugin: { rules: Record<string, unknown> }
}

const linter = new Linter({ configType: 'flat' })

function messagesOf(code: string): { line: number; messageId: string | null }[] {
  return linter
    .verify(
      code,
      [
        {
          files: ['**/*.tsx'],
          languageOptions: { parser, parserOptions: { ecmaFeatures: { jsx: true } } },
          plugins: { 'web-controls': webControlsPlugin as never },
          rules: { 'web-controls/no-fixed-initial-checked': 'error' }
        }
      ],
      'probe.tsx'
    )
    .map(message => ({ line: message.line, messageId: message.messageId ?? null }))
}

describe('the ban on a fixed initial state of a checkbox or switch', () => {
  it.each([
    ['defaultChecked on a checkbox', '<input type="checkbox" defaultChecked />', 'defaultChecked'],
    [
      'defaultChecked with a value',
      '<input type="checkbox" defaultChecked={false} />',
      'defaultChecked'
    ],
    ['a bare checked', '<input type="checkbox" checked onChange={f} />', 'literalChecked'],
    [
      'checked as a literal true',
      '<input type="checkbox" checked={true} onChange={f} />',
      'literalChecked'
    ],
    [
      'checked as a literal false',
      '<input type="checkbox" checked={false} onChange={f} />',
      'literalChecked'
    ],
    ['a switch role', '<input role="switch" defaultChecked />', 'defaultChecked'],
    ['a Checkbox component', '<Checkbox defaultChecked />', 'defaultChecked'],
    ['a member Checkbox component', '<Primitive.Checkbox defaultChecked />', 'defaultChecked'],
    ['a nested Switch component', '<Ui.Kit.Switch checked={true} />', 'literalChecked'],
    ['a Switch component', '<Switch checked={true} />', 'literalChecked'],
    [
      'a type given as an expression string',
      '<input type={"checkbox"} defaultChecked />',
      'defaultChecked'
    ]
  ])('refuses %s', (_label, jsx, messageId) => {
    expect(messagesOf(`const a = ${jsx}`)).toEqual([{ line: 1, messageId }])
  })

  it.each([
    ['useState(true)', 'const [on, setOn] = useState(true)'],
    ['a typed useState(true)', 'const [on, setOn] = useState<boolean>(true)'],
    ['an arrow that returns true', 'const [on, setOn] = useState(() => true)'],
    ['a block that returns true', 'const [on, setOn] = useState(() => { return true })'],
    ['React.useState(true)', 'const [on, setOn] = React.useState(true)']
  ])('refuses a controlled checkbox that starts from %s', (_label, declaration) => {
    const code = `function C() {\n  ${declaration}\n  return <input type="checkbox" checked={on} onChange={f} />\n}`
    expect(messagesOf(code)).toEqual([{ line: 3, messageId: 'stateStartsChecked' }])
  })

  it('finds the state in an enclosing scope', () => {
    const code = `function C() {
  const [on, setOn] = useState(true)
  return list.map(() => <input type="checkbox" checked={on} onChange={f} />)
}`
    expect(messagesOf(code)).toEqual([{ line: 3, messageId: 'stateStartsChecked' }])
  })

  it.each([
    ['a control that starts unchecked', 'const [on, setOn] = useState(false)'],
    ['a state read from the preferences', 'const [on, setOn] = useState(preferences.confirm)'],
    ['a state with no initial value', 'const [on, setOn] = useState<boolean>()'],
    ['an arrow that reads a preference', 'const [on, setOn] = useState(() => preferences.confirm)'],
    ['a value from a hook', 'const on = useConfirm()']
  ])('allows a controlled checkbox with %s', (_label, declaration) => {
    const code = `function C() {\n  ${declaration}\n  return <input type="checkbox" checked={on} onChange={f} />\n}`
    expect(messagesOf(code)).toEqual([])
  })

  it('allows a true state that no checkbox shows', () => {
    const code = `function C() {
  const [open, setOpen] = useState(true)
  return <input type="text" value={open} checked={open} />
}`
    expect(messagesOf(code)).toEqual([])
  })

  it('allows a checkbox that is not controlled and one whose checked is a derived value', () => {
    expect(messagesOf('const a = <input type="checkbox" onChange={f} />')).toEqual([])
    expect(
      messagesOf('const a = <input type="checkbox" checked={rows.length > 0} onChange={f} />')
    ).toEqual([])
    expect(
      messagesOf('const a = <input type="checkbox" checked={selected.has(id)} onChange={f} />')
    ).toEqual([])
  })

  it('does not flag the same attributes on another element', () => {
    expect(messagesOf('const a = <input type="radio" defaultChecked />')).toEqual([])
    expect(messagesOf('const a = <details defaultChecked />')).toEqual([])
    expect(messagesOf('const a = <Primitive.Radio defaultChecked />')).toEqual([])
  })
})
