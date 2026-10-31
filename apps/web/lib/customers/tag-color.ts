import { DEFAULT_TAG_COLOR, TAG_COLOR_PATTERN } from '@platform/core/domain'

// A color the page may paint: one that does not match the pattern falls back to the default
export const tagDotColor = (color: string): string =>
  TAG_COLOR_PATTERN.test(color) ? color : DEFAULT_TAG_COLOR
