import { ErrorCodes } from '@platform/core/errors'

import {
  assertKnownVariables,
  channelTemplateValues,
  isOrderMessageVariable,
  missingVariablesOf,
  renderOrderMessage,
  unknownVariablesOf,
  variablesNeededBy,
  variablesUsedBy
} from './message-template'

describe('variablesUsedBy', () => {
  it('lists each name once, in order, and tolerates spaces inside the braces', () => {
    expect(variablesUsedBy('Hi {{customerName}}, {{ orderNumber }} / {{customerName}}')).toEqual([
      'customerName',
      'orderNumber'
    ])
  })

  it('does not read single braces or other syntax as a variable', () => {
    expect(variablesUsedBy('{total} {{ }} {{a b}} ${x}')).toEqual([])
  })
})

describe('known variables', () => {
  it('accepts the allowlist, scheduledDeliveryDate included', () => {
    expect(isOrderMessageVariable('scheduledDeliveryDate')).toBe(true)
    expect(isOrderMessageVariable('constructor')).toBe(false)
    expect(isOrderMessageVariable('__proto__')).toBe(false)
  })

  it('refuses a body with a variable that does not exist and names it', () => {
    expect(unknownVariablesOf('{{total}} {{secret}} {{toString}}')).toEqual(['secret', 'toString'])
    expect(() => assertKnownVariables('{{total}} {{secret}}')).toThrow(
      expect.objectContaining({
        code: ErrorCodes.ORDER_MESSAGE_VARIABLE_UNKNOWN,
        metadata: { variables: ['secret'] }
      }) as Error
    )
    expect(() => assertKnownVariables('{{total}}')).not.toThrow()
  })
})

describe('renderOrderMessage', () => {
  it('substitutes every placeholder, repeats included', () => {
    expect(
      renderOrderMessage('{{customerName}}: {{orderNumber}} ({{customerName}})', {
        customerName: 'Ana',
        orderNumber: 'A-1'
      })
    ).toEqual({ ok: true, text: 'Ana: A-1 (Ana)' })
  })

  it('never evaluates a value: a placeholder inside a value stays as written, and $ patterns are literal', () => {
    expect(
      renderOrderMessage('{{customerName}} {{orderNumber}}', {
        customerName: '{{orderNumber}} $& $1',
        orderNumber: 'A-1'
      })
    ).toEqual({ ok: true, text: '{{orderNumber}} $& $1 A-1' })
  })

  it('refuses a message whose variable has no value, or an empty one, and lists what is missing', () => {
    expect(
      renderOrderMessage('Arrives {{scheduledDeliveryDate}} {{trackingUrl}}', {
        trackingUrl: '  '
      })
    ).toEqual({
      ok: false,
      reason: 'missing_variable',
      missing: ['scheduledDeliveryDate', 'trackingUrl']
    })
  })

  it('refuses a body with a name that is not a variable instead of sending it as written', () => {
    expect(renderOrderMessage('Hi {{foo}} {{orderNumber}}', { orderNumber: 'A-1' })).toEqual({
      ok: false,
      reason: 'missing_variable',
      missing: ['foo']
    })
  })

  it('counts the variables of the approved template as needed too', () => {
    expect(renderOrderMessage('Hi', {}, ['trackingUrl'])).toEqual({
      ok: false,
      reason: 'missing_variable',
      missing: ['trackingUrl']
    })
    expect(missingVariablesOf('{{foo}} {{total}}', ['orderNumber'], { total: '1' })).toEqual([
      'foo',
      'orderNumber'
    ])
  })

  it('refuses a text that, filled in, is longer than a channel takes', () => {
    const result = renderOrderMessage('{{itemsList}}', { itemsList: 'x'.repeat(4097) })
    expect(result).toEqual({ ok: false, reason: 'too_long', length: 4097 })
    expect(renderOrderMessage('{{itemsList}}', { itemsList: 'x'.repeat(4096) }).ok).toBe(true)
  })

  it('does not need a variable the body does not use', () => {
    expect(renderOrderMessage('Hello', {})).toEqual({ ok: true, text: 'Hello' })
  })
})

describe('what a template needs', () => {
  it('counts the variables of the channel-approved template too', () => {
    expect(variablesNeededBy('{{orderNumber}}', ['scheduledDeliveryDate', 'orderNumber'])).toEqual([
      'scheduledDeliveryDate',
      'orderNumber'
    ])
  })

  it('fills the approved template in the order it was mapped, or reports what is missing', () => {
    expect(
      channelTemplateValues(['orderNumber', 'customerName'], {
        orderNumber: '1',
        customerName: 'Ana'
      })
    ).toEqual({ ok: true, values: ['1', 'Ana'] })
    expect(
      channelTemplateValues(['orderNumber', 'trackingUrl', 'trackingUrl'], { orderNumber: '1' })
    ).toEqual({
      ok: false,
      missing: ['trackingUrl']
    })
  })
})
