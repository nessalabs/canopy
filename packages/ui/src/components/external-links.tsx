import { useEffect } from 'react'

import { usePlatform } from '@/providers/platform'

/**
 * Sends clicks on links that leave the app (agent replies, docs) to the system browser
 * instead of navigating the window. In-app hash links are left alone.
 */
export function ExternalLinks(): null {
  const { openExternal } = usePlatform()
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return
      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      const url = new URL(anchor.href, location.href)
      if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return
      event.preventDefault()
      openExternal(url.href)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [openExternal])
  return null
}
