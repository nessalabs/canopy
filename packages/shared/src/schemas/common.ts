import { z } from 'zod'

export const Id = z.string().min(1)
/** Epoch milliseconds. */
export const Millis = z.number().int().nonnegative()
export const Sha = z.string().regex(/^[0-9a-f]{4,64}$/)
