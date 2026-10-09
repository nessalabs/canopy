# Working-tree changes — block diagram

Uncommitted work on `research/ai-code-review`, as of 2026-10-08.
**23 files modified** (+390 / −179) · **16 new files** (~850 lines of source, 4 test files).

Five independent features. Each section is before → after.

---

## 0. The whole change, at a glance

```mermaid
flowchart LR
  subgraph BEFORE
    direction TB
    B1["Dashboard screen<br/>owns review queue"]
    B2["Git tab<br/>4 panes, full width"]
    B3["Agent tab<br/>one pinned conversation"]
    B2 -- "Send for review" --> B1
    B1 -- "switch tab + pin session" --> B3
  end

  subgraph AFTER
    direction TB
    A1["Git tab<br/>owns useGitAgent"]
    A2["Git panes<br/>SplitView left"]
    A3["Git Agent dock<br/>SplitView right, N tabs"]
    A4["Agent tab<br/>pinned conversation, untouched"]
    A2 -- "review / highlight / drag" --> A3
    A3 -- "cited file refs" --> A2
    A1 --- A2
    A1 --- A3
  end

  BEFORE ==> AFTER
```

| Feature | Blast radius |
| --- | --- |
| A. Git Agent dock | `git-tab`, `git-chrome`, dashboard screen, 7 new files |
| B. Context staging & drag-drop | composer, selection-actions, file-tree, 4 new files |
| C. File-reference navigation | markdown, diff-view, worktree-diff, content-pane, 2 new files |
| D. Agent status language | `status-dot`, `globals.css`, 1 new file |
| E. Default-model surfacing | daemon + shared schema + `use-worktree-agent` |

---

## A. Git Agent dock

Review comments used to leave the Git tab. Now the agent comes to the diff, as a tab strip docked to the right of every Git pane.

### Before

```mermaid
flowchart TB
  DASH["worktree-dashboard-screen"]
  COM["useComments"]
  PEND["pending review state<br/>useEffect waits for ready"]
  GT["GitTab onSendForReview prop"]
  AT["AgentTab"]
  WA["useWorktreeAgent<br/>worktree pin"]

  GT -->|onSendForReview| DASH
  DASH --> COM
  DASH --> PEND
  PEND -->|"select or start session"| WA
  DASH -->|"setTab('agent')"| AT
  AT --> WA
  WA -.->|"moves the pin"| AT
```

Costs: sending a review yanked you out of the diff, hijacked the worktree's pinned session, and allowed exactly one conversation at a time.

### After

```mermaid
flowchart TB
  GT["GitTab"]
  UGA["useGitAgent(worktreeId)"]
  PURE["git-agent.ts — pure<br/>openTab · activate · closeTab<br/>bindSession · persisted"]
  LS[("localStorage<br/>canopy-git-agent:ID")]
  SV["SplitView"]
  PANES["Changes · History · PR · Comments"]
  PANEL["GitAgentPanel<br/>tab strip + drop zone"]
  CONV["GitAgentConversation xN<br/>follow: false"]
  TOG["GitAgentToggle<br/>in top-bar actions"]

  GT --> UGA
  UGA --> PURE
  PURE --> LS
  GT --> SV
  SV --> PANES
  SV --> PANEL
  PANEL --> CONV
  UGA -->|"status = mostPressing"| TOG
  PANES -->|"sendReview"| UGA
  UGA -->|"reviews[tabId]"| CONV
  CONV -->|"onMeta: title, status, seed"| PANEL
  CONV -->|"onSession"| PURE
```

Key decisions in the code:

- **Tabs are a pure reducer.** `git-agent.ts` holds no React — `closeTab` hands the panel to the next neighbour then the previous; `persisted` keeps only tabs whose session exists, so half-composed drafts die with the page.
- **Every tab stays mounted** (`hidden` when inactive), so a turn keeps streaming while you read another tab.
- **`follow: false`** is a new `useWorktreeAgent` mode: the conversation starts from *no* session and never reads or writes the worktree pin. That is what keeps the Agent tab independent.
- **Reviews are queued, not pushed.** `sendReview` routes to the tab already holding that session (else opens one); the tab fires it once `!busy` and the session matches, then calls `reviewSent`.
- `sending` on the CTA now reflects queued reviews, not the pinned agent's busy flag.

---

## B. Context staging & drag-and-drop

One quote slot became a typed context pipeline with four sources.

### Before

```mermaid
flowchart LR
  TR["Transcript selection"]
  SA["SelectionActions<br/>onAsk(text)"]
  ST["useState quote<br/>{ id, text }"]
  CP["AgentComposer<br/>one chip, fixed label"]

  TR --> SA --> ST --> CP
  CP -->|onQuoteStaged| ST
```

One slot, one source, one hard-coded label (`Quoted from the transcript (N lines)`). A second quote arriving before the composer took the first overwrote it.

### After

```mermaid
flowchart LR
  subgraph Sources
    S1["Transcript selection"]
    S2["Diff / PR code selection"]
    S3["File-tree row drag"]
    S4["Text dragged in from another app"]
  end

  AC["agent-context.ts<br/>AgentContext = path | snippet<br/>CONTEXT_MIME · readDrop · toStaged"]
  DS["dom-selection.ts<br/>selectionAt · closestAcross<br/>containsAcross · snippetSource<br/>useSnippetDrag"]
  CHIP["setDragChip<br/>custom drag ghost"]
  DZ["DropZone + useDragAnywhere<br/>window-wide drag awareness"]
  BOARD["useStagingBoard<br/>queue per tab key"]
  CPX["AgentComposer<br/>staged[] in, taken(ids) out"]

  S1 --> DS
  S2 --> DS
  S3 --> AC
  S4 --> AC
  DS --> AC
  AC --> CHIP
  AC --> DZ
  DZ --> BOARD
  AC --> BOARD
  BOARD --> CPX
  CPX -->|"taken(ids)"| BOARD
```

What this buys:

- **A queue, not a slot.** Two chips can arrive before the composer takes either (a new tab's own chip plus the snippet that opened it). The composer reports the exact ids it consumed.
- **Snippets know where they came from.** `data-file-path` on the content panes plus the renderer's `data-line` turn a highlight into a `src/a.ts:42–50` chip rather than loose text.
- **Shadow-DOM-aware selection.** The diff renderer draws into a shadow root, where `document.getSelection()` only sees the host. `selectionAt` / `closestAcross` / `containsAcross` climb across root boundaries — which is also what let `SelectionActions` be reused over diffs at all.
- **Drag grips are mode-sensitive.** In the commit panel the whole row sweeps a staging highlight, so only the file *icon* is draggable (`data-drag-handle`, which `useRowPointers` now skips); elsewhere the whole row drags.
- `SelectionActions` gained `askLabel` ("Ask Git Agent") and now hands back the `Range`, and releases the shadow root's own selection.

---

## C. File-reference navigation

An agent citing `routes/agents.ts:42` now gets you there.

### Before

```mermaid
flowchart LR
  MD["MessageMarkdown<br/>remarkPlugins = [gfm, math] fixed"]
  TXT["'see src/a.ts:42' — plain text"]
  EF["ExplorerFocus { path, commentId }"]
  WD["WorktreeDiff<br/>scrolls to a comment only"]

  MD --> TXT
  EF --> WD
```

### After

```mermaid
flowchart TB
  FR["file-refs.ts<br/>parseFileRef · resolvePath<br/>splitRefs · remarkFileRefs"]
  MD["MessageMarkdown<br/>+ remarkPlugins prop"]
  FRL["FileRefLinks<br/>context + onClickCapture"]
  OPEN["GitTab.openRef(href)"]
  TRACK["useWorktreeFiles<br/>known paths"]
  FOCUS["ExplorerFocus { path, commentId, lines }"]
  TRAIL["useFileTrail.go(path, 'L42')"]
  CPANE["ContentPane<br/>picks diff or file view via lineAt"]
  DV["DiffView<br/>+ selectedLines prop"]
  WD["WorktreeDiff<br/>focusLines → scrollToLine<br/>across shadow roots"]

  FR --> MD
  MD --> FRL
  FRL -->|"claims any anchor click"| OPEN
  OPEN --> TRACK
  OPEN --> FOCUS
  FOCUS --> TRAIL
  FOCUS --> CPANE
  CPANE --> DV
  DV --> WD
```

The careful bits:

- **Parsing is deliberately narrow.** The path pattern demands an extension starting with a letter, so `1.5:3`, version numbers and URLs never read as references. Both `:42-50` and `#L42-L50` are accepted — the two ways Claude Code and Codex cite.
- **`resolvePath` completes a unique tail.** Agents cite `routes/agents.ts`; the tab resolves it against the worktree's tracked paths to `packages/daemon/src/routes/agents.ts`, and leaves an ambiguous tail as written.
- **Links only exist where something can open them.** `useFileRefPlugins` returns `undefined` without a `FileRefLinks` host, so the Agent tab renders no dead links.
- **One click handler covers three link kinds** — markdown links, plugin-linked refs, and `click … href` inside a mermaid diagram — because all are anchors by paint time.
- **Scrolling is vertical-only and retried.** `scrollIntoView` would slide wide code sideways; the renderer paints after highlighting, so `scrollToLine` re-looks each frame for up to 60 frames and returns its own canceller.
- `ContentPane` auto-switches to the **file** view when the cited line isn't in any hunk.

---

## D. Agent status language

```mermaid
flowchart LR
  IN["busy + asking"] --> ST["agentStatus"]
  RUN["busy"] --> ST
  ERR["error"] --> ST
  UNS["unseen finish"] --> ST
  ST --> RANK["mostPressing<br/>input > running > error > done > idle"]
  RANK --> LOOK["STATUS_LOOK<br/>dot + tab tint + words"]
  LOOK --> DOT["StatusDot<br/>+ 'attention' variant"]
  LOOK --> TOGGLE["GitAgentToggle dot"]
  DOT --> TOK["--nessa-attention<br/>light + dark"]
```

Before: `running | success | error | idle` on the dot, and no notion of "needs you" or "finished but unread". After: a finish stays visible as news until the tab is actually looked at, and the closed panel's toggle still shows the most pressing state across all tabs.

---

## E. Default-model surfacing

```mermaid
flowchart TB
  subgraph Before
    RH["readHooks → AgentHook[]"]
    CAP1["AgentCapabilities { model }"]
    UI1["model = override ?? detected<br/>blank when the session has none"]
    RH --> CAP1 --> UI1
  end

  subgraph After
    RS["readSettings → { hooks, model }<br/>same cascade, no extra CLI"]
    CX["CodexAdapter.capabilities<br/>config/read → config.model"]
    CAP2["AgentCapabilities { model, defaultModel }"]
    UI2["shown = picked ?? defaultModel<br/>sent = picked only"]
    RS --> CAP2
    CX --> CAP2
    CAP2 --> UI2
  end

  Before ==> After
```

The nuance worth keeping: `defaultModel` is **shown, not sent**. The provider applies its own configured default anyway, so sending it would freeze today's setting into the turn and beat a later settings change.

---

## New files

| File | Lines | Role |
| --- | --- | --- |
| `lib/git-agent.ts` | 70 | Pure tab + status reducers |
| `lib/use-git-agent.ts` | 91 | Dock state, reviews, per-tab status |
| `lib/use-staging.ts` | 37 | Chip queues, one per composer |
| `lib/agent-context.ts` | 39 | Context type, MIME, drop reading |
| `lib/dom-selection.ts` | 79 | Shadow-DOM selection + snippet drag |
| `lib/file-refs.ts` | 91 | Reference parsing + remark plugin |
| `components/agent/file-ref-links.tsx` | 40 | Link claiming + plugin gating |
| `components/git/git-agent/panel.tsx` | 159 | Tab strip, drop handling |
| `components/git/git-agent/conversation.tsx` | 98 | One tab's conversation |
| `components/git/git-agent/status.tsx` | 41 | Status look + top-bar toggle |
| `components/git/git-agent/drop-zone.tsx` | 62 | Window-wide drag invitation |
| `components/git/git-agent/drag-chip.tsx` | 40 | Custom drag ghost |

Tests: `git-agent.test.ts`, `file-refs.test.ts`, `agent-context.test.ts`, `file-ref-links.test.tsx` — 18 cases, all against the pure modules.

## Gaps worth noting

- `useGitAgent` has no test; its routing logic (which tab a review lands on) is only covered indirectly.
- `dom-selection.ts` and the shadow-root `scrollToLine` retry loop are untested — both are the most environment-dependent code in the change.
- The `OPEN_KEY` for the dock is global, not per-worktree, unlike the tab state.
