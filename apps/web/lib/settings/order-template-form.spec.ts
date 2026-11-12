import type { OrderTemplateView } from '@platform/api-client'
import {
  OrderMessageKind,
  OrderMessageLimits,
  OrderMessageVariables,
  OrderMessageWarnings
} from '@platform/core/domain'

import {
  draftWarnings,
  insertVariable,
  KNOWN_VARIABLES,
  numberedPlaceholdersOf,
  showsAutoSend,
  templateChanged,
  templateDraftOf,
  templateInput,
  templateProblems,
  TemplateProblems,
  variablesForPlaceholders,
  variablesUsedBy
} from './order-template-form'

const view = (patch: Partial<OrderTemplateView> = {}): OrderTemplateView => ({
  id: 't1',
  kind: OrderMessageKind.ORDER_SHIPPED,
  locale: 'es',
  body: 'Hola {{customerName}}',
  autoSend: false,
  attachSummary: true,
  channelTemplate: null,
  variables: ['customerName'],
  warnings: [],
  updatedAt: '2026-11-12T10:00:00.000Z',
  ...patch
})

describe('the placeholders of a body', () => {
  // The same pattern as variablesUsedBy of the shipping library (message-template.ts), which the web cannot import: it
  // pulls the server's modules with it
  it.each([
    [
      'Hola {{customerName}}, tu pedido {{ orderNumber }} va {{customerName}}',
      ['customerName', 'orderNumber']
    ],
    ['{{unknown}} y {{1}}', ['unknown', '1']],
    ['sin variables', []],
    ['{{ }} {{a b}} {customerName}', []],
    ['{{customerName}}{{orderNumber}}', ['customerName', 'orderNumber']]
  ])('reads the names of %p', (body, names) => {
    expect(variablesUsedBy(body)).toEqual(names)
  })

  it('lists exactly the variables the api allows', () => {
    expect([...KNOWN_VARIABLES].sort()).toEqual(Object.values(OrderMessageVariables).sort())
  })
})

describe('the draft of a template', () => {
  it('starts empty, with the automatic sending its kind has by default', () => {
    expect(templateDraftOf(OrderMessageKind.ORDER_SHIPPED, undefined)).toEqual({
      body: '',
      autoSend: true,
      attachSummary: false,
      channelTemplate: null
    })
    expect(templateDraftOf(OrderMessageKind.RETURN_APPROVED, undefined).autoSend).toBe(false)
    expect(templateDraftOf(OrderMessageKind.ORDER_SUMMARY, undefined).autoSend).toBe(false)
  })

  it('starts from the saved template, copying its link', () => {
    const saved = view({
      channelTemplate: { pluginId: 'p', name: 'n', language: 'es', variables: ['total'] }
    })
    const draft = templateDraftOf(OrderMessageKind.ORDER_SHIPPED, saved)
    expect(draft).toEqual({
      body: 'Hola {{customerName}}',
      autoSend: false,
      attachSummary: true,
      channelTemplate: { pluginId: 'p', name: 'n', language: 'es', variables: ['total'] }
    })
    draft.channelTemplate?.variables.push('x')
    expect(saved.channelTemplate?.variables).toEqual(['total'])
  })
})

describe('which kinds have the automatic sending switch', () => {
  it('hides it for the two kinds a store preference decides', () => {
    expect(showsAutoSend(OrderMessageKind.ORDER_SUMMARY)).toBe(false)
    expect(showsAutoSend(OrderMessageKind.ORDER_FAILED_ATTEMPT)).toBe(false)
  })

  it('shows it for every other kind', () => {
    const others = Object.values(OrderMessageKind).filter(
      kind =>
        kind !== OrderMessageKind.ORDER_SUMMARY && kind !== OrderMessageKind.ORDER_FAILED_ATTEMPT
    )
    expect(others).toHaveLength(6)
    expect(others.every(showsAutoSend)).toBe(true)
  })
})

describe('templateProblems', () => {
  const draft = (patch = {}) => ({
    ...templateDraftOf(OrderMessageKind.ORDER_SHIPPED, view()),
    ...patch
  })

  it('finds none in a good template', () => {
    expect(templateProblems(draft())).toEqual([])
  })

  it('refuses a blank body, a long one and a variable that does not exist', () => {
    expect(templateProblems(draft({ body: '  \n ' }))).toEqual([TemplateProblems.BODY_BLANK])
    expect(
      templateProblems(draft({ body: 'x'.repeat(OrderMessageLimits.BODY_MAX_LENGTH + 1) }))
    ).toEqual([TemplateProblems.BODY_TOO_LONG])
    expect(templateProblems(draft({ body: 'Hola {{nombre}}' }))).toEqual([
      TemplateProblems.UNKNOWN_VARIABLE
    ])
  })

  it('accepts a body of exactly the limit', () => {
    expect(
      templateProblems(draft({ body: 'x'.repeat(OrderMessageLimits.BODY_MAX_LENGTH) }))
    ).toEqual([])
  })

  it('refuses a link with no name or language, and one whose placeholder has no variable yet', () => {
    const link = { pluginId: 'p', name: 'shipped', language: 'es', variables: ['total'] }
    expect(templateProblems(draft({ channelTemplate: link }))).toEqual([])
    expect(templateProblems(draft({ channelTemplate: { ...link, name: ' ' } }))).toEqual([
      TemplateProblems.LINK_FIELDS
    ])
    expect(templateProblems(draft({ channelTemplate: { ...link, pluginId: '' } }))).toEqual([
      TemplateProblems.LINK_FIELDS
    ])
    expect(
      templateProblems(draft({ channelTemplate: { ...link, variables: ['total', ''] } }))
    ).toEqual([TemplateProblems.LINK_VARIABLES])
    expect(
      templateProblems(
        draft({
          channelTemplate: {
            ...link,
            variables: Array.from(
              { length: OrderMessageLimits.CHANNEL_TEMPLATE_VARIABLES_MAX + 1 },
              () => 'total'
            )
          }
        })
      )
    ).toEqual([TemplateProblems.LINK_VARIABLES])
  })
})

describe('templateInput', () => {
  it('sends the whole template, with the switch of a kind that has one', () => {
    const draft = templateDraftOf(OrderMessageKind.ORDER_SHIPPED, view())
    expect(templateInput(OrderMessageKind.ORDER_SHIPPED, draft)).toEqual({
      body: 'Hola {{customerName}}',
      autoSend: false,
      attachSummary: true,
      channelTemplate: null
    })
  })

  it('sends no autoSend for a kind a store preference decides', () => {
    const draft = { ...templateDraftOf(OrderMessageKind.ORDER_SUMMARY, undefined), body: 'Hola' }
    expect(templateInput(OrderMessageKind.ORDER_SUMMARY, draft)).not.toHaveProperty('autoSend')
  })

  it('trims what the owner copied from the channel', () => {
    const draft = {
      ...templateDraftOf(OrderMessageKind.ORDER_SHIPPED, view()),
      channelTemplate: { pluginId: 'p', name: ' shipped ', language: ' es ', variables: ['total'] }
    }
    expect(templateInput(OrderMessageKind.ORDER_SHIPPED, draft).channelTemplate).toEqual({
      pluginId: 'p',
      name: 'shipped',
      language: 'es',
      variables: ['total']
    })
  })
})

describe('templateChanged', () => {
  it('is false for an untouched draft, saved or new', () => {
    const saved = view()
    expect(
      templateChanged(
        OrderMessageKind.ORDER_SHIPPED,
        saved,
        templateDraftOf(OrderMessageKind.ORDER_SHIPPED, saved)
      )
    ).toBe(false)
    expect(
      templateChanged(
        OrderMessageKind.ORDER_SHIPPED,
        undefined,
        templateDraftOf(OrderMessageKind.ORDER_SHIPPED, undefined)
      )
    ).toBe(false)
  })

  it('is true when the text, a switch or the link changed', () => {
    const saved = view()
    const base = templateDraftOf(OrderMessageKind.ORDER_SHIPPED, saved)
    expect(templateChanged(OrderMessageKind.ORDER_SHIPPED, saved, { ...base, body: 'Otro' })).toBe(
      true
    )
    expect(
      templateChanged(OrderMessageKind.ORDER_SHIPPED, saved, { ...base, autoSend: true })
    ).toBe(true)
    expect(
      templateChanged(OrderMessageKind.ORDER_SHIPPED, saved, { ...base, attachSummary: false })
    ).toBe(true)
    expect(
      templateChanged(OrderMessageKind.ORDER_SHIPPED, saved, {
        ...base,
        channelTemplate: { pluginId: 'p', name: 'n', language: 'es', variables: [] }
      })
    ).toBe(true)
  })

  it('ignores the switch of a kind that has none', () => {
    const saved = view({ kind: OrderMessageKind.ORDER_SUMMARY })
    const base = templateDraftOf(OrderMessageKind.ORDER_SUMMARY, saved)
    expect(
      templateChanged(OrderMessageKind.ORDER_SUMMARY, saved, { ...base, autoSend: !base.autoSend })
    ).toBe(false)
  })
})

describe('draftWarnings', () => {
  const draft = (patch = {}) => ({
    ...templateDraftOf(OrderMessageKind.ORDER_SHIPPED, view()),
    ...patch
  })

  it('warns when an automatic template uses the scheduled delivery date', () => {
    expect(
      draftWarnings(OrderMessageKind.ORDER_SHIPPED, draft({ autoSend: true }), [
        'scheduledDeliveryDate'
      ])
    ).toEqual([OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE])
  })

  it('also warns when the date fills a placeholder of the channel template', () => {
    const channelTemplate = {
      pluginId: 'p',
      name: 'n',
      language: 'es',
      variables: ['scheduledDeliveryDate']
    }
    expect(
      draftWarnings(OrderMessageKind.ORDER_SHIPPED, draft({ autoSend: true, channelTemplate }), [])
    ).toHaveLength(1)
  })

  it('stays quiet when it is not automatic, does not use the date, or the kind has no switch', () => {
    expect(
      draftWarnings(OrderMessageKind.ORDER_SHIPPED, draft({ autoSend: false }), [
        'scheduledDeliveryDate'
      ])
    ).toEqual([])
    expect(
      draftWarnings(OrderMessageKind.ORDER_SHIPPED, draft({ autoSend: true }), ['total'])
    ).toEqual([])
    expect(
      draftWarnings(OrderMessageKind.ORDER_SUMMARY, draft({ autoSend: true }), [
        'scheduledDeliveryDate'
      ])
    ).toEqual([])
  })
})

describe('insertVariable', () => {
  it('puts the variable at the caret and moves the caret after it', () => {
    expect(insertVariable('Hola ', 5, 5, OrderMessageVariables.CUSTOMER_NAME)).toEqual({
      body: 'Hola {{customerName}}',
      caret: 21
    })
  })

  it('replaces the selection', () => {
    expect(insertVariable('Hola NOMBRE!', 5, 11, OrderMessageVariables.CUSTOMER_NAME).body).toBe(
      'Hola {{customerName}}!'
    )
  })

  it('keeps a selection that lies outside the text inside it', () => {
    expect(insertVariable('ab', 9, 20, OrderMessageVariables.TOTAL).body).toBe('ab{{total}}')
    expect(insertVariable('ab', -3, 1, OrderMessageVariables.TOTAL).body).toBe('{{total}}b')
  })
})

describe('the placeholders of a channel template', () => {
  it('counts up to the highest number the text uses', () => {
    expect(numberedPlaceholdersOf('Hola {{1}}, tu pedido {{2}}')).toBe(2)
    expect(numberedPlaceholdersOf('{{3}}')).toBe(3)
    expect(numberedPlaceholdersOf('sin variables')).toBe(0)
    expect(numberedPlaceholdersOf('{{name}}')).toBe(0)
  })

  it('never asks for more than the api takes', () => {
    expect(numberedPlaceholdersOf('{{99}}')).toBe(OrderMessageLimits.CHANNEL_TEMPLATE_VARIABLES_MAX)
  })

  it('resizes the variables of a link keeping what was chosen', () => {
    expect(variablesForPlaceholders(['total'], 3)).toEqual(['total', '', ''])
    expect(variablesForPlaceholders(['total', 'storeName'], 1)).toEqual(['total'])
    expect(variablesForPlaceholders(['total'], 0)).toEqual([])
  })
})
