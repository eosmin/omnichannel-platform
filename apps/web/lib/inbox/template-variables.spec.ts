import { MessageLimits } from '@platform/core/domain'

import { fillTemplate, variableCountOf } from './template-variables'

describe('variableCountOf', () => {
  it('is zero for a body with no placeholder', () => {
    expect(variableCountOf('Hello')).toBe(0)
  })

  it('counts up to the highest number the body names, even when it repeats or skips', () => {
    expect(variableCountOf('Hi {{1}}, order {{2}}, {{1}} again')).toBe(2)
    expect(variableCountOf('Only {{3}}')).toBe(3)
  })
})

describe('variableCountOf with a body that asks for too many', () => {
  it('stops at the most the api accepts, so a hostile body cannot draw thousands of inputs', () => {
    expect(variableCountOf('Hi {{99999}}')).toBe(MessageLimits.TEMPLATE_MAX_VARIABLES)
  })
})

describe('fillTemplate', () => {
  it('puts each value where its number is, every time it appears', () => {
    expect(fillTemplate('Hi {{1}}, order {{2}}. Bye {{1}}', ['Ana', '42'])).toBe(
      'Hi Ana, order 42. Bye Ana'
    )
  })

  it('leaves a placeholder with nothing typed', () => {
    expect(fillTemplate('Hi {{1}} {{2}}', ['Ana', '  '])).toBe('Hi Ana {{2}}')
    expect(fillTemplate('Hi {{1}}', [])).toBe('Hi {{1}}')
  })
})
