// Where the integration suite finds Redis: the variable CI and .env.example define, with the local
// docker compose address as the default. The one file of this library that reads process.env.
export const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'
