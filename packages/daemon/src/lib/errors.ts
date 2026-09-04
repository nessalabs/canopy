import { ApiError } from '@canopy/shared'

export { ApiError }

export const notFound = (what: string, id: string) => new ApiError(404, `${what}_not_found`, `${what} ${id} not found`)
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details)
export const badRequest = (code: string, message: string, details?: unknown) => new ApiError(400, code, message, details)
