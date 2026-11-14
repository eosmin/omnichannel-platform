// One entry per template that exists. A template joins this list in the step that sends it, together
// with its component and its messages (libs/core/email), so the type never names a template that
// cannot be rendered.
export const EmailTemplates = {
  MAGIC_LINK: 'magic-link',
  INVITATION: 'invitation',
  NOTIFICATION_DIGEST: 'notification-digest',
  // The generic order email: the rendered text of an order message that could not go through its channel (TDD_17 §4.7)
  ORDER_MESSAGE: 'order-message',
  // A scheduled analytics report: the summary of the period in the body and the file attached (TDD_11 §7.4)
  SCHEDULED_REPORT: 'scheduled-report'
} as const

export type EmailTemplate = (typeof EmailTemplates)[keyof typeof EmailTemplates]
