import { MessageLimits } from '@platform/core/domain'

// {{1}}, {{2}}: the numbered placeholders of a template body
const PLACEHOLDER = /\{\{(\d+)\}\}/g

// How many values the template asks for: the api sends them in order, one for each number up to the
// highest that the body names, and takes no more than TEMPLATE_MAX_VARIABLES (a body comes from a
// provider: it cannot make the dialog draw thousands of inputs)
export function variableCountOf(body: string): number {
  const numbers = [...body.matchAll(PLACEHOLDER)].map(match => Number(match[1]))
  return numbers.length === 0
    ? 0
    : Math.min(
        numbers.reduce((highest, number) => Math.max(highest, number), 0),
        MessageLimits.TEMPLATE_MAX_VARIABLES
      )
}

// The body with the values typed so far; a placeholder with nothing typed stays as it is
export function fillTemplate(body: string, values: readonly string[]): string {
  return body.replace(PLACEHOLDER, (placeholder, digits: string) => {
    const value = values[Number(digits) - 1]?.trim()
    return value === undefined || value === '' ? placeholder : value
  })
}
