export const WhatsAppLimits = {
  TEXT_MAX_LENGTH: 4096,
  // https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
  CAPTION_MAX_LENGTH: 1024,
  FILENAME_MAX_LENGTH: 240,
  BUTTONS_MAX: 3,
  BUTTON_TITLE_MAX_LENGTH: 20,
  BUTTON_ID_MAX_LENGTH: 256,
  BUTTONS_BODY_MAX_LENGTH: 1024,
  LOCATION_NAME_MAX_LENGTH: 1000,
  // A page of a listing (templates, phone numbers), and how many pages one reads before it stops
  PAGE_SIZE: 100,
  MAX_PAGES: 5
} as const
