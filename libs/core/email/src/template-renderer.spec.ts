import { Locales } from '@platform/core/i18n'
import { EmailTemplates } from '@platform/core/queues'

import { TemplateRenderer } from './template-renderer'

const renderer = new TemplateRenderer()
const data = { url: 'https://app.example.com/auth/magic?token=abc123', expiresInMinutes: 15 }

describe('TemplateRenderer', () => {
  it('renders the magic link in English, with the link in the html and in the text', async () => {
    const email = await renderer.render(EmailTemplates.MAGIC_LINK, Locales.EN, data)
    expect(email.subject).toBe('Your sign-in link')
    expect(email.html).toContain('lang="en"')
    expect(email.html).toContain('href="https://app.example.com/auth/magic?token=abc123"')
    expect(email.html).toContain('This link expires in 15 minutes.')
    expect(email.text).toContain('https://app.example.com/auth/magic?token=abc123')
    expect(email.text).not.toContain('<')
  })

  it('renders it in Spanish', async () => {
    const email = await renderer.render(EmailTemplates.MAGIC_LINK, Locales.ES, data)
    expect(email.subject).toBe('Tu enlace para iniciar sesión')
    expect(email.html).toContain('lang="es"')
    expect(email.text).toContain('Este enlace caduca en 15 minutos.')
  })

  // Golden renders of the plain-text version (TDD_07 §5.2): the html changes with every upgrade of
  // react-email, the text is what the copy of the email looks like to a person
  it('renders the same text for the magic link in English every time', async () => {
    const email = await renderer.render(EmailTemplates.MAGIC_LINK, Locales.EN, data)
    expect(email.text).toMatchInlineSnapshot(`
      "Sign in to your account

      Use the button below to sign in. It works once.

      Sign in https://app.example.com/auth/magic?token=abc123

      If the button does not work, copy this link into your browser:

      https://app.example.com/auth/magic?token=abc123

      ----------------------------------------

      This link expires in 15 minutes.

      If you did not ask for it, you can ignore this email."
    `)
  })

  it('renders the same text for the magic link in Spanish every time', async () => {
    const email = await renderer.render(EmailTemplates.MAGIC_LINK, Locales.ES, data)
    expect(email.text).toMatchInlineSnapshot(`
      "Inicia sesión en tu cuenta

      Usa el botón de abajo para iniciar sesión. Funciona una sola vez.

      Iniciar sesión https://app.example.com/auth/magic?token=abc123

      Si el botón no funciona, copia este enlace en tu navegador:

      https://app.example.com/auth/magic?token=abc123

      ----------------------------------------

      Este enlace caduca en 15 minutos.

      Si no lo solicitaste, puedes ignorar este correo."
    `)
  })

  it('rejects data that is not what the template needs', async () => {
    await expect(
      renderer.render(EmailTemplates.MAGIC_LINK, Locales.EN, { url: 'not a url' })
    ).rejects.toThrow()
  })

  it('refuses a link that is not http or https, so a job cannot smuggle a javascript: URL', async () => {
    await expect(
      renderer.render(EmailTemplates.MAGIC_LINK, Locales.EN, {
        url: 'javascript:alert(1)',
        expiresInMinutes: 15
      })
    ).rejects.toThrow()
  })
})
