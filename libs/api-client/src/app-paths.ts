// The paths live in the shared domain lib because the api builds them too (the actionPath of a
// notification); the web keeps importing them from here.
export {
  AppPaths,
  DSR_VERIFY_FRAGMENT_KEY,
  StoreSettingsSections,
  type StoreSettingsSection
} from '@platform/core/domain'
