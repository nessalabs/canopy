import { z } from 'zod'

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
})
export type ApiErrorBody = z.infer<typeof ApiErrorBody>

/** The one error shape crossing the wire; daemon throws it, client rethrows it. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } }
  }
}
