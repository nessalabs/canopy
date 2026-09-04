import { useState } from 'react'
import { KeyRound, Server, TreePine } from 'lucide-react'

import { createClient } from '@canopy/shared'

import { ErrorNote } from '@/components/error-note'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { DaemonConnection } from '@/providers/platform'

export function ConnectScreen({
  initial,
  hint,
  onConnect
}: {
  initial?: Partial<DaemonConnection>
  /** Shown under the form, e.g. the desktop app explaining that canopyd has not been started. */
  hint?: string
  onConnect: (connection: DaemonConnection) => void
}): React.JSX.Element {
  const [url, setUrl] = useState(initial?.url ?? 'http://127.0.0.1:9483')
  const [token, setToken] = useState(initial?.token ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const connection = { url: url.trim(), token: token.trim() }
    try {
      // /healthz proves the URL; /projects proves the token.
      const client = createClient({ baseUrl: connection.url, token: connection.token })
      await client.health()
      await client.listProjects()
      onConnect(connection)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <form
        className="w-full max-w-md"
        onSubmit={(event) => {
          event.preventDefault()
          void connect()
        }}
      >
        <div className="mb-6 flex items-center justify-center gap-2">
          <TreePine className="size-6 text-primary" />
          <span className="text-lg font-semibold tracking-tight">Canopy</span>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Connect to canopyd</CardTitle>
            <CardDescription>
              The daemon prints its token on start; it also lives in <span className="font-mono">~/.canopy/token</span> on the machine running it.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Server className="size-3.5" /> Server URL
              </span>
              <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://127.0.0.1:9483" className="font-mono" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeyRound className="size-3.5" /> Access token
              </span>
              <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} className="font-mono" />
            </label>
            <ErrorNote error={error} />
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={busy || url.trim() === '' || token.trim() === ''}>
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </CardFooter>
        </Card>
        {hint ? <p className="mt-4 text-center text-xs text-muted-foreground">{hint}</p> : null}
      </form>
    </div>
  )
}
