// One entry per template that exists. A template joins this list in the step that sends it, together
// with its component and its messages (libs/core/email), so the type never names a template that
// cannot be rendered.
export const EmailTemplates = {
  MAGIC_LINK: 'magic-link',
  INVITATION: 'invitation',
  NOTIFICATION_DIGEST: 'notification-digest',
  // The generic order email: the rendered text of an order message that could not go through its channel (TDD_17 §4.7)
  ORDER_MESSAGE: 'order-message'
} as const

export type EmailTemplate = (typeof EmailTemplates)[keyof typeof EmailTemplates]
