import type { OrderTemplateView, PutOrderTemplateInput } from '@platform/api-client'
import {
  defaultAutoSend,
  type OrderMessageKindType,
  OrderMessageKindsWithoutAutoSend,
  OrderMessageLimits,
  type OrderMessageVariable,
  OrderMessageVariables,
  type OrderMessageWarning,
  OrderMessageWarnings
} from '@platform/core/domain'

// The form of one message template (kind and language) as plain values, and the checks done before the request. The api
// checks the same and decides (TDD_17 §4.7).

export interface ChannelLinkDraft {
  pluginId: string
  name: string
  language: string
  // The variable of ours that fills each numbered placeholder, in order; empty text is one the person has not chosen yet
  variables: string[]
}

export interface TemplateDraft {
  body: string
  autoSend: boolean
  attachSummary: boolean
  channelTemplate: ChannelLinkDraft | null
}

export const TemplateProblems = {
  BODY_BLANK: 'bodyBlank',
  BODY_TOO_LONG: 'bodyTooLong',
  UNKNOWN_VARIABLE: 'unknownVariable',
  LINK_FIELDS: 'linkFields',
  LINK_VARIABLES: 'linkVariables'
} as const
export type TemplateProblem = (typeof TemplateProblems)[keyof typeof TemplateProblems]

export const KNOWN_VARIABLES: readonly OrderMessageVariable[] = Object.values(OrderMessageVariables)

// {{name}}, the one syntax of a template: the same pattern the api reads (variablesUsedBy of the shipping library, which a
// spec holds this one against). The names in order of first appearance, without repeats.
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

export function variablesUsedBy(body: string): string[] {
  const names = new Set<string>()
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name !== undefined) names.add(name)
  }
  return [...names]
}

function isKnownVariable(name: string): name is OrderMessageVariable {
  return (KNOWN_VARIABLES as readonly string[]).includes(name)
}

// A new template starts empty, with the automatic sending its kind has by default
export function templateDraftOf(
  kind: OrderMessageKindType,
  view: OrderTemplateView | undefined
): TemplateDraft {
  if (view === undefined) {
    return {
      body: '',
      autoSend: defaultAutoSend(kind),
      attachSummary: false,
      channelTemplate: null
    }
  }
  return {
    body: view.body,
    autoSend: view.autoSend,
    attachSummary: view.attachSummary,
    channelTemplate:
      view.channelTemplate === null
        ? null
        : { ...view.channelTemplate, variables: [...view.channelTemplate.variables] }
  }
}

// The summary and the failed attempt follow a store preference, so their template has no switch of its own
export function showsAutoSend(kind: OrderMessageKindType): boolean {
  return !OrderMessageKindsWithoutAutoSend.includes(kind)
}

export function templateProblems(draft: TemplateDraft): TemplateProblem[] {
  const problems: TemplateProblem[] = []
  if (draft.body.trim() === '') problems.push(TemplateProblems.BODY_BLANK)
  if (draft.body.length > OrderMessageLimits.BODY_MAX_LENGTH) {
    problems.push(TemplateProblems.BODY_TOO_LONG)
  }
  if (variablesUsedBy(draft.body).some(name => !isKnownVariable(name))) {
    problems.push(TemplateProblems.UNKNOWN_VARIABLE)
  }
  const link = draft.channelTemplate
  if (link !== null) {
    if (link.pluginId === '' || link.name.trim() === '' || link.language.trim() === '') {
      problems.push(TemplateProblems.LINK_FIELDS)
    }
    if (
      link.variables.length > OrderMessageLimits.CHANNEL_TEMPLATE_VARIABLES_MAX ||
      link.variables.some(name => !isKnownVariable(name))
    ) {
      problems.push(TemplateProblems.LINK_VARIABLES)
    }
  }
  return problems
}

// The whole template is the request (the api keeps nothing that is left out). A kind that follows a store preference sends no
// `autoSend`. Call it with a draft that has no problems.
export function templateInput(
  kind: OrderMessageKindType,
  draft: TemplateDraft
): PutOrderTemplateInput {
  const link = draft.channelTemplate
  return {
    body: draft.body,
    ...(showsAutoSend(kind) ? { autoSend: draft.autoSend } : {}),
    attachSummary: draft.attachSummary,
    channelTemplate:
      link === null
        ? null
        : {
            pluginId: link.pluginId,
            name: link.name.trim(),
            language: link.language.trim(),
            variables: link.variables.filter(isKnownVariable)
          }
  }
}

function sameLink(a: ChannelLinkDraft | null, b: ChannelLinkDraft | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Whether the draft differs from the template the person started from (or from an empty one, when there is none)
export function templateChanged(
  kind: OrderMessageKindType,
  saved: OrderTemplateView | undefined,
  draft: TemplateDraft
): boolean {
  const base = templateDraftOf(kind, saved)
  return (
    base.body !== draft.body ||
    (showsAutoSend(kind) && base.autoSend !== draft.autoSend) ||
    base.attachSummary !== draft.attachSummary ||
    !sameLink(base.channelTemplate, draft.channelTemplate)
  )
}

// What the editor tells the owner without refusing the template (TDD_17 §4.7): an automatic one that uses
// `scheduledDeliveryDate` leaves every order without a date unsent. It is the rule of the api, applied to what is being
// edited, so the notice appears before saving; `previewVariables` are the variables the preview found in the body.
export function draftWarnings(
  kind: OrderMessageKindType,
  draft: TemplateDraft,
  previewVariables: readonly string[]
): OrderMessageWarning[] {
  const needed = new Set<string>([...previewVariables, ...(draft.channelTemplate?.variables ?? [])])
  return showsAutoSend(kind) &&
    draft.autoSend &&
    needed.has(OrderMessageVariables.SCHEDULED_DELIVERY_DATE)
    ? [OrderMessageWarnings.AUTO_SEND_NEEDS_SCHEDULED_DATE]
    : []
}

// The text with `{{variable}}` put where the selection is (replacing it), and where the caret goes after it
export function insertVariable(
  body: string,
  selectionStart: number,
  selectionEnd: number,
  variable: OrderMessageVariable
): { body: string; caret: number } {
  const start = Math.max(0, Math.min(selectionStart, body.length))
  const end = Math.max(start, Math.min(selectionEnd, body.length))
  const token = `{{${variable}}}`
  return { body: body.slice(0, start) + token + body.slice(end), caret: start + token.length }
}

// A channel template numbers its placeholders {{1}}, {{2}}...: how many the text has is the highest number it uses
const NUMBERED = /\{\{\s*(\d+)\s*\}\}/g

export function numberedPlaceholdersOf(templateBody: string): number {
  let highest = 0
  for (const match of templateBody.matchAll(NUMBERED)) {
    highest = Math.max(highest, Number(match[1]))
  }
  return Math.min(highest, OrderMessageLimits.CHANNEL_TEMPLATE_VARIABLES_MAX)
}

// The variables of a link after the template it points at changed: as many slots as placeholders, keeping what was chosen
export function variablesForPlaceholders(current: readonly string[], count: number): string[] {
  return Array.from({ length: count }, (_, index) => current[index] ?? '')
}
