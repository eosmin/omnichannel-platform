import { Injectable } from '@nestjs/common'
import { render } from 'react-email'

import type { Locale } from '@platform/core/i18n'
import type { EmailTemplate } from '@platform/core/queues'

import { templateRegistry } from './templates/template-registry'

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

@Injectable()
export class TemplateRenderer {
  // Every email carries a plain-text alternative (TDD_07 §5.5)
  async render(template: EmailTemplate, locale: Locale, data: unknown): Promise<RenderedEmail> {
    const { subject, element } = templateRegistry[template].build(data, locale)
    const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
    return { subject, html, text }
  }
}
