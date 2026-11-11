// A checkbox or switch in apps/web never carries its initial state in the component (TDD_17 §4.14): a control that
// starts checked reads that from the store's preferences, where its factory default lives in exactly one place
// (libs/core/platform/config/store-preferences.ts), so a new control has to add its key there. The rule lives in
// this file so that a spec can run it (scripts/lib/web-controls-rule.spec.ts).
//
// It reports, on `<input type="checkbox">`, `<input role="switch">` and the components named Checkbox or Switch:
//  - `defaultChecked`, with any value;
//  - `checked` given as a literal (`checked`, `checked={true}`, `checked={false}`);
//  - `checked={x}` where `x` comes from `useState(true)` (or `useState<boolean>(true)`, or `useState(() => true)`).
// A control that starts unchecked (`useState(false)`) is allowed: nothing is selected until the person chooses, which is
// not a default of the store. A value that is read (`useState(preference.confirmOnCreate)`) or derived is allowed.
const CONTROL_COMPONENTS = new Set(['Checkbox', 'Switch'])

function attributeNamed(node, name) {
  return node.attributes.find(
    attribute => attribute.type === 'JSXAttribute' && attribute.name.name === name
  )
}

function literalText(attribute) {
  const value = attribute.value
  if (value === null) return undefined
  if (value.type === 'Literal') return value.value
  if (
    value.type === 'JSXExpressionContainer' &&
    value.expression.type === 'Literal' &&
    typeof value.expression.value === 'string'
  ) {
    return value.expression.value
  }
  return undefined
}

function isControl(node) {
  const name = node.name
  // `<Primitive.Checkbox />`: the component is the last name of the chain
  if (name.type === 'JSXMemberExpression') return CONTROL_COMPONENTS.has(name.property.name)
  if (name.type !== 'JSXIdentifier') return false
  if (CONTROL_COMPONENTS.has(name.name)) return true
  if (name.name !== 'input') return false
  const type = attributeNamed(node, 'type')
  const role = attributeNamed(node, 'role')
  return (
    (type !== undefined && literalText(type) === 'checkbox') ||
    (role !== undefined && literalText(role) === 'switch')
  )
}

function isTrueLiteral(node) {
  return node !== null && node !== undefined && node.type === 'Literal' && node.value === true
}

function isTrueInitial(argument) {
  if (isTrueLiteral(argument)) return true
  return (
    argument !== undefined &&
    (argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression') &&
    (isTrueLiteral(argument.body) ||
      (argument.body.type === 'BlockStatement' &&
        argument.body.body.length === 1 &&
        argument.body.body[0].type === 'ReturnStatement' &&
        isTrueLiteral(argument.body.body[0].argument)))
  )
}

function findVariable(scope, name) {
  for (let current = scope; current !== null; current = current.upper) {
    const variable = current.set.get(name)
    if (variable !== undefined) return variable
  }
  return undefined
}

// `const [x, setX] = useState(true)`: the variable `x` starts as true
function startsChecked(variable) {
  return variable.defs.some(definition => {
    const declarator = definition.node
    if (
      declarator.type !== 'VariableDeclarator' ||
      declarator.id.type !== 'ArrayPattern' ||
      declarator.id.elements[0] === null ||
      declarator.id.elements[0].type !== 'Identifier' ||
      declarator.id.elements[0].name !== variable.name ||
      declarator.init === null ||
      declarator.init.type !== 'CallExpression'
    ) {
      return false
    }
    const callee = declarator.init.callee
    const isState =
      (callee.type === 'Identifier' && callee.name === 'useState') ||
      (callee.type === 'MemberExpression' && callee.property.name === 'useState')
    return isState && isTrueInitial(declarator.init.arguments[0])
  })
}

const noFixedInitialChecked = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      defaultChecked:
        'A checkbox or switch has no defaultChecked: read its initial state from the store preferences (libs/core/platform/config/store-preferences.ts)',
      literalChecked:
        'A checkbox or switch has no literal checked: read its state from the store preferences (libs/core/platform/config/store-preferences.ts)',
      stateStartsChecked:
        'A checkbox or switch does not start checked from useState(true): read its initial state from the store preferences (libs/core/platform/config/store-preferences.ts)'
    }
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!isControl(node)) return
        const defaultChecked = attributeNamed(node, 'defaultChecked')
        if (defaultChecked !== undefined) {
          context.report({ node: defaultChecked, messageId: 'defaultChecked' })
        }
        const checked = attributeNamed(node, 'checked')
        if (checked === undefined) return
        const value = checked.value
        if (value === null) {
          context.report({ node: checked, messageId: 'literalChecked' })
          return
        }
        if (value.type !== 'JSXExpressionContainer') return
        const expression = value.expression
        if (expression.type === 'Literal' && typeof expression.value === 'boolean') {
          context.report({ node: checked, messageId: 'literalChecked' })
          return
        }
        if (expression.type !== 'Identifier') return
        const variable = findVariable(context.sourceCode.getScope(expression), expression.name)
        if (variable !== undefined && startsChecked(variable)) {
          context.report({ node: checked, messageId: 'stateStartsChecked' })
        }
      }
    }
  }
}

const webControlsPlugin = { rules: { 'no-fixed-initial-checked': noFixedInitialChecked } }

module.exports = { webControlsPlugin }
