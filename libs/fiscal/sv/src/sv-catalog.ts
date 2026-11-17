import { ACTIVITIES } from './catalogs/activities'
import { DEPARTMENTS } from './catalogs/departments'
import { DISTRICTS } from './catalogs/districts'
import { ESTABLISHMENT_TYPES } from './catalogs/establishment-types'
import { IDENTITY_DOCUMENTS } from './catalogs/identity-documents'
import { MUNICIPALITIES } from './catalogs/municipalities'
import { UNITS } from './catalogs/units'

// Lookups over the catalogs of the authority (data in ./catalogs). Pure, and built once.

const activities = new Map<string, string>(ACTIVITIES.map(row => [row.code, row.name]))
const departments = new Set<string>(DEPARTMENTS.map(row => row.code))
const municipalities = new Set<string>(MUNICIPALITIES.map(row => `${row.department}:${row.code}`))
const districts = new Set<string>(DISTRICTS.map(row => row.code))
const units = new Set<number>(UNITS.map(row => Number(row.code)))
const identityDocuments = new Set<string>(IDENTITY_DOCUMENTS.map(row => row.code))
const establishmentTypes = new Set<string>(ESTABLISHMENT_TYPES.map(row => row.code))

// CAT-019: the name of an economic activity by its code, or null when the catalog has none
export const activityName = (code: string): string | null => activities.get(code) ?? null
export const isDepartment = (code: string): boolean => departments.has(code)
// A municipality is the pair (department, code): the same code is used in several departments
export const isMunicipality = (department: string, code: string): boolean =>
  municipalities.has(`${department}:${code}`)
export const isDistrict = (code: string): boolean => districts.has(code)
export const isUnit = (code: number): boolean => units.has(code)
export const isIdentityDocument = (code: string): boolean => identityDocuments.has(code)
export const isEstablishmentType = (code: string): boolean => establishmentTypes.has(code)
