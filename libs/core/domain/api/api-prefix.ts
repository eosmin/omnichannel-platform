// The version prefix of the tenant API. The server mounts it once (setGlobalPrefix) and the
// frontend apiClient prepends it once; no route constant contains it (TDD_02 §7).
export const API_PREFIX = '/api/v1'
