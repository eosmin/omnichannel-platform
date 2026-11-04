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

  it.each([
    [EmailTemplates.MAGIC_LINK, data],
    [
      EmailTemplates.INVITATION,
      {
        url: 'https://app.example.com/invite?token=abc',
        inviterName: 'Ana',
        storeName: 'Shop',
        roleName: 'Agent',
        expiresInDays: 7
      }
    ],
    [
      EmailTemplates.NOTIFICATION_DIGEST,
      {
        items: [
          {
            storeName: 'Shop',
            title: 'T',
            body: 'B',
            url: 'https://app.example.com/s/1/inbox/2',
            count: 1,
            linkKind: 'conversation',
            at: '2 nov, 07:10'
          }
        ],
        moreCount: 0,
        appUrl: 'https://app.example.com/s/1/inbox',
        settingsUrl: 'https://app.example.com/account/notifications'
      }
    ]
  ] as const)(
    'says the language of the email on the page, the body and its cell: %s',
    async (template, input) => {
      const es = await renderer.render(template, Locales.ES, input)
      const en = await renderer.render(template, Locales.EN, input)

      expect(es.html).not.toContain('lang="en"')
      expect(es.html).toMatch(/<body[^>]*lang="es"/)
      expect(es.html).toMatch(/<td[^>]*lang="es"/)
      expect(en.html).not.toContain('lang="es"')
      expect(en.html).toMatch(/<body[^>]*lang="en"/)
    }
  )

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
      expect(email.subject).toBe('You have been invited to join Tienda Escalón')
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
      expect(email.subject).toBe('Te invitaron a unirte a Tienda Escalón')
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

    it('cuts and cleans the name of the store in the subject', async () => {
      const email = await renderer.render(EmailTemplates.INVITATION, Locales.EN, {
        ...invitation,
        storeName: `Pay now\r\nBcc: x@y.z ${'a'.repeat(200)}`
      })
      expect(email.subject).not.toMatch(/[\r\n]/)
      expect(Array.from(email.subject).length).toBeLessThan(120)
      expect(email.subject.startsWith('You have been invited to join Pay now Bcc: x@y.z')).toBe(
        true
      )
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

describe('TemplateRenderer: notification digest', () => {
  const digest = {
    items: [
      {
        storeName: 'Shop',
        title: 'Conversation assigned',
        body: 'Ana assigned you a conversation.',
        url: 'https://app.example.com/s/s1/inbox/c1',
        count: 1,
        linkKind: 'conversation',
        at: 'Nov 2, 07:10'
      },
      {
        storeName: 'Shop',
        title: 'Export ready',
        body: 'Your file is ready.',
        url: null,
        count: 1,
        linkKind: 'exports',
        at: 'Nov 2, 07:12'
      }
    ],
    moreCount: 3,
    appUrl: 'https://app.example.com/',
    settingsUrl: 'https://app.example.com/account/notifications'
  }

  it('lists every notification, counts the ones left out and links to the settings', async () => {
    const email = await renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.EN, digest)
    expect(email.subject).toBe('You have new notifications')
    expect(email.html).toContain('New notifications (5)')
    expect(email.html).toContain('href="https://app.example.com/s/s1/inbox/c1"')
    expect(email.text).toContain('Export ready')
    expect(email.text).toContain('And 3 more, waiting in the app.')
    expect(email.text).toContain('https://app.example.com/account/notifications')
  })

  it('says when each one happened, and words the link by where it goes', async () => {
    const email = await renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.EN, {
      ...digest,
      items: [
        {
          ...digest.items[0],
          url: 'https://app.example.com/s/s1/settings/channels',
          linkKind: 'channels'
        }
      ]
    })

    expect(email.text).toContain('Shop · Nov 2, 07:10')
    expect(email.text).toContain('Review channels')
    expect(email.text).not.toContain('Open conversation')
  })

  it('still renders a job queued before the time and the kind of link existed', async () => {
    const old = { ...digest.items[0] } as Record<string, unknown>
    delete old['at']
    delete old['linkKind']
    const email = await renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.EN, {
      ...digest,
      items: [old]
    })

    expect(email.text).toContain('Conversation assigned')
    expect(email.text).not.toContain('·')
  })

  it('renders it in Spanish', async () => {
    const email = await renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.ES, digest)
    expect(email.subject).toBe('Tienes notificaciones nuevas')
    expect(email.text).toContain('Y 3 más, esperando en la aplicación.')
  })

  it('says how many a block stands for even when the job has no time', async () => {
    const old = { ...digest.items[0], count: 3 } as Record<string, unknown>
    delete old['at']
    const email = await renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.EN, {
      ...digest,
      items: [old]
    })

    expect(email.text).toContain('3 notifications like this')
    expect(email.text).not.toContain('latest')
  })

  it('refuses a digest with nothing to list or a link that is not http', async () => {
    await expect(
      renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.EN, { ...digest, items: [] })
    ).rejects.toThrow()
    await expect(
      renderer.render(EmailTemplates.NOTIFICATION_DIGEST, Locales.EN, {
        ...digest,
        settingsUrl: 'javascript:alert(1)'
      })
    ).rejects.toThrow()
  })
})
