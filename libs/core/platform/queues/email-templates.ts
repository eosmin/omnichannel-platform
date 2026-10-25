// One entry per template that exists. A template joins this list in the step that sends it, together
// with its component and its messages (libs/core/email), so the type never names a template that
// cannot be rendered.
export const EmailTemplates = {
  MAGIC_LINK: 'magic-link',
  INVITATION: 'invitation'
} as const

export type EmailTemplate = (typeof EmailTemplates)[keyof typeof EmailTemplates]
