import type { OwnerClient } from '@platform/core/database-testing'

export const BUSINESS_HOURS_TIMEZONE = 'America/El_Salvador'

const OPEN_DAY = [{ from: '09:00', to: '18:00' }]

// The id of a row that exists once per store is the store: that is what the isolation suite hands
// to the paths and to `untouched`
export async function createBusinessHours(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  await owner.businessHours.upsert({
    where: { storeId: input.storeId },
    create: {
      storeId: input.storeId,
      timezone: BUSINESS_HOURS_TIMEZONE,
      schedule: {
        mon: OPEN_DAY,
        tue: OPEN_DAY,
        wed: OPEN_DAY,
        thu: OPEN_DAY,
        fri: OPEN_DAY,
        sat: [],
        sun: []
      }
    },
    update: { timezone: BUSINESS_HOURS_TIMEZONE }
  })
  return { id: input.storeId }
}

// A store always has its settings; the builder brings them to the factory state by writing the row
// again, so the defaults come from the schema and from nowhere else
export async function resetStoreSettings(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  await owner.storeSettings.deleteMany({ where: { storeId: input.storeId } })
  await owner.storeSettings.create({ data: { storeId: input.storeId } })
  return { id: input.storeId }
}
