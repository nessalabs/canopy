/** What a host spreads on the content a `ChatTabs` tab shows, to pair with that tab's `aria-controls`. */
export const tabPanelProps = (id: string) => ({ role: 'tabpanel', id: `chat-tab-panel-${id}`, 'aria-labelledby': `chat-tab-${id}` }) as const
