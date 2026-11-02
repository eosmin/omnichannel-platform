import { DEFAULT_LOCALE, Locales } from '@platform/core/i18n'

// The words of the widget. The script is a bundle of its own and cannot read the message files of the
// web app, so the two languages live here; a key missing from one fails the type-check.
const MESSAGES = {
  [Locales.ES]: {
    open: 'Abrir el chat',
    close: 'Cerrar el chat',
    inputLabel: 'Escribe un mensaje',
    send: 'Enviar',
    away: 'Ahora no estamos en línea. Deja tu mensaje y te responderemos en cuanto volvamos.',
    failed: 'No se envió.',
    retry: 'Reintentar',
    empty: 'Escríbenos, con gusto te ayudamos.',
    team: 'Equipo',
    you: 'Tú',
    teamTyping: 'El equipo está escribiendo…',
    seen: 'Visto',
    preChatIntro: 'Cuéntanos quién eres para atenderte mejor. Todo es opcional.',
    nameLabel: 'Nombre',
    emailLabel: 'Correo electrónico',
    phoneLabel: 'Teléfono',
    startChat: 'Empezar el chat',
    invalidEmail: 'Revisa el correo.',
    invalidPhone: 'Revisa el teléfono.',
    attach: 'Adjuntar un archivo',
    removeFile: 'Quitar el archivo',
    fileTypeNotAllowed: 'Ese tipo de archivo no se puede enviar.',
    fileTooLarge: 'El archivo pesa más de {max}.',
    fileEmpty: 'El archivo está vacío.',
    tooManyFiles: 'Puedes enviar hasta {max} archivos a la vez.',
    fileUnavailable: 'No se pudo abrir el archivo. Inténtalo de nuevo.',
    uploading: 'Subiendo'
  },
  [Locales.EN]: {
    open: 'Open the chat',
    close: 'Close the chat',
    inputLabel: 'Write a message',
    send: 'Send',
    away: 'We are away right now. Leave a message and we will answer as soon as we are back.',
    failed: 'Not sent.',
    retry: 'Retry',
    empty: 'Write to us, we are happy to help.',
    team: 'Team',
    you: 'You',
    teamTyping: 'The team is typing…',
    seen: 'Seen',
    preChatIntro: 'Tell us who you are so we can help you better. Everything is optional.',
    nameLabel: 'Name',
    emailLabel: 'Email',
    phoneLabel: 'Phone',
    startChat: 'Start the chat',
    invalidEmail: 'Check the email.',
    invalidPhone: 'Check the phone.',
    attach: 'Attach a file',
    removeFile: 'Remove the file',
    fileTypeNotAllowed: 'That type of file cannot be sent.',
    fileTooLarge: 'The file is larger than {max}.',
    fileEmpty: 'The file is empty.',
    tooManyFiles: 'You can send up to {max} files at a time.',
    fileUnavailable: 'The file could not be opened. Try again.',
    uploading: 'Uploading'
  }
} as const

export type WidgetLocale = keyof typeof MESSAGES
export type WidgetText = (typeof MESSAGES)[WidgetLocale]

function supported(candidate: string | null | undefined): WidgetLocale | null {
  const language = candidate?.toLowerCase().split('-')[0]
  if (language === Locales.ES) return Locales.ES
  if (language === Locales.EN) return Locales.EN
  return null
}

// The first candidate the widget speaks, in the order the owner would expect: what the snippet of the
// site says, then the language of the store, then the browser of the visitor. `pt-BR` and the like
// are not translated, so they fall through to the next candidate.
export function resolveLocale(...candidates: (string | null | undefined)[]): WidgetLocale {
  for (const candidate of candidates) {
    const locale = supported(candidate)
    if (locale !== null) return locale
  }
  return supported(DEFAULT_LOCALE) ?? Locales.ES
}

export function textFor(locale: WidgetLocale): WidgetText {
  return MESSAGES[locale]
}
