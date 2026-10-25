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

  describe('the invitation', () => {
    const invitation = {
      url: 'https://app.example.com/invitations/abc123',
      inviterName: 'Ana Pérez',
      storeName: 'Tienda Escalón',
      roleName: 'Agent',
      expiresInDays: 7
    }

    it('renders the same text in English every time', async () => {
      const email = await renderer.render(EmailTemplates.INVITATION, Locales.EN, invitation)
      expect(email.subject).toBe('You have been invited to join a team')
      expect(email.text).toMatchInlineSnapshot(`
        "You are invited to join Tienda Escalón

        Ana Pérez invited you to join Tienda Escalón as Agent. Nothing changes until you accept.

        Review the invitation https://app.example.com/invitations/abc123

        If the button does not work, copy this link into your browser:

        https://app.example.com/invitations/abc123

        ----------------------------------------

        This invitation expires in 7 days.

        If you were not expecting it, you can ignore this email."
      `)
    })

    it('renders the same text in Spanish every time', async () => {
      const email = await renderer.render(EmailTemplates.INVITATION, Locales.ES, invitation)
      expect(email.subject).toBe('Te invitaron a unirte a un equipo')
      expect(email.text).toMatchInlineSnapshot(`
        "Te invitan a unirte a Tienda Escalón

        Ana Pérez te invitó a unirte a Tienda Escalón como Agent. Nada cambia hasta que aceptes.

        Revisar la invitación https://app.example.com/invitations/abc123

        Si el botón no funciona, copia este enlace en tu navegador:

        https://app.example.com/invitations/abc123

        ----------------------------------------

        Esta invitación caduca en 7 días.

        Si no la esperabas, puedes ignorar este correo."
      `)
    })

    it('shows the names as text and never as markup', async () => {
      const email = await renderer.render(EmailTemplates.INVITATION, Locales.EN, {
        ...invitation,
        inviterName: '<img src=x onerror=alert(1)>'
      })
      expect(email.html).not.toContain('<img src=x')
      expect(email.html).toContain('&lt;img src=x')
    })

    it('refuses a link that is not http or https', async () => {
      await expect(
        renderer.render(EmailTemplates.INVITATION, Locales.EN, {
          ...invitation,
          url: 'javascript:alert(1)'
        })
      ).rejects.toThrow()
    })
  })
})
