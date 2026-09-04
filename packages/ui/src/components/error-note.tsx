import { ApiError } from '@canopy/shared'

/** One place that turns a thrown error into a short inline message. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export function ErrorNote({ error, className = '' }: { error: unknown; className?: string }): React.JSX.Element | null {
  if (!error) return null
  return (
    <p role="alert" className={`text-xs text-destructive ${className}`}>
      {errorMessage(error)}
    </p>
  )
}
