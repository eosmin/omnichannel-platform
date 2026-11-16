import { z } from 'zod'

import { FiscalCustomerDataLimits, singleLineText } from '@platform/core/domain'

const text = (max: number) => singleLineText(max, 1)

// Core checks the size and that a value is one line of text; what a tax id or a kind of taxpayer must look like is the provider's rule,
// applied by the service when the data is saved
const addressSchema = z
  .record(
    // A field name of the provider: letters, digits and underscores, starting with a letter (no control character, no `__proto__`)
    z
      .string()
      .max(FiscalCustomerDataLimits.ADDRESS_KEY_MAX_LENGTH)
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    text(FiscalCustomerDataLimits.VALUE_MAX_LENGTH)
  )
  .refine(value => Object.keys(value).length <= FiscalCustomerDataLimits.ADDRESS_MAX_FIELDS, {
    message: 'too many address fields'
  })

// A field left out stays; a field sent as null is removed
export const customerFiscalDataSchema = z
  .object({
    name: text(FiscalCustomerDataLimits.VALUE_MAX_LENGTH).nullable(),
    taxId: text(FiscalCustomerDataLimits.ID_MAX_LENGTH).nullable(),
    registrationId: text(FiscalCustomerDataLimits.ID_MAX_LENGTH).nullable(),
    taxpayerType: text(FiscalCustomerDataLimits.ID_MAX_LENGTH).nullable(),
    economicActivity: text(FiscalCustomerDataLimits.VALUE_MAX_LENGTH).nullable(),
    documentType: text(FiscalCustomerDataLimits.ID_MAX_LENGTH).nullable(),
    address: addressSchema.nullable()
  })
  .partial()
  .strict()
  .refine(value => Object.keys(value).length > 0, { message: 'nothing to change' })
export type CustomerFiscalDataBody = z.output<typeof customerFiscalDataSchema>
