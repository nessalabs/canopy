/**
 * What a host spreads on the content a `ChatTabs` tab shows, to pair with that tab's
 * `aria-controls`. It is named by the tab's title rather than by `aria-labelledby`, which would
 * split an id with a space in it — a file path, say — into several references.
 */
export const tabPanelProps = (id: string, title: string) => ({ role: 'tabpanel', id: `chat-tab-panel-${id}`, 'aria-label': title }) as const
