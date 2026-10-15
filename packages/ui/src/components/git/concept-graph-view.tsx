import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitCommitHorizontal,
  MessageSquare,
  Trash2,
} from "lucide-react";

import {
  parentOf,
  trailTo,
  walkConcepts,
  type AgentProvider,
  type ChangedFile,
  type Concept,
  type ConceptEffect,
  type ConceptGraph,
  type DiffSpec,
  type PartStatus,
  type ReviewComment,
} from "@canopy/shared";

import {
  FileRefLinks,
  LinkedMarkdown,
  type OpenFileRef,
} from "@/components/agent/answer-links";
import { ErrorNote } from "@/components/error-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChangeMap, type ChangeMapNode } from "@/components/ui/change-map";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  SegmentedControl,
  SegmentedControlOption,
} from "@/components/ui/segmented-control";
import type { DiffMode } from "@/components/worktree-diff";
import { useDiffFiles, useFilePatches, usePullRequest } from "@/lib/api-hooks";
import {
  affectedCards,
  cardOf,
  conceptFiles,
  isStale,
  mapTitle,
  reviewedKey,
  type ConceptCard,
} from "@/lib/concept-graph";
import { networkOf, type NetNode } from "@/lib/concept-network";
import { relativeTime } from "@/lib/format";
import { slicePatch } from "@/lib/patch";
import type { useConceptGraph } from "@/lib/use-concept-graph";
import { useHotkeys } from "@/lib/use-hotkeys";
import { cn } from "@/lib/utils";

import { ConceptInspector } from "./concept-inspector";
import {
  ConceptNetwork,
  NetworkLegend,
  type NetworkLayout,
} from "./concept-network";
import { ContentPane } from "./content-pane";

type Graph = ReturnType<typeof useConceptGraph>;
/** The whole map as a living network, or one rung of it as cards. */
type View = "network" | "cards";

const PROVIDER_NAME = { claude: "Claude", codex: "Codex" } as const;

/** What the change did to a concept, in the statuses the map draws with. */
const STATUS_OF: Record<ConceptEffect, PartStatus> = {
  added: "added",
  reshaped: "modified",
  replaced: "modified",
  removed: "deleted",
  context: "external",
};

/** The words for an effect on a concept's own card, where "modified" would be vague. */
const EFFECT_WORD: Record<ConceptEffect, string> = {
  added: "Added by this change",
  reshaped: "Reshaped by this change",
  replaced: "Replaces something older",
  removed: "Removed by this change",
  context: "Already existed — only leaned on",
};

/** Which of the worktree's maps is on screen, and the way to drop the one that is. */
function MapPicker({ graph }: { graph: Graph }): React.JSX.Element | null {
  const { map, maps } = graph;
  if (!map) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 max-w-56 min-w-0 gap-1.5 px-2 text-xs"
          title="Concept maps of this pull request"
        >
          <span className="truncate">{mapTitle(map)}</span>
          <span className="shrink-0 text-muted-foreground">
            {relativeTime(map.createdAt)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-96 w-80 overflow-y-auto"
      >
        <DropdownMenuLabel className="text-xs">Concept maps</DropdownMenuLabel>
        {maps.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => graph.pick(item.id)}
            className={cn("gap-2 text-xs", item.id === map.id && "bg-accent")}
          >
            <span className="min-w-0 flex-1 truncate">{mapTitle(item)}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {relativeTime(item.createdAt)}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void graph.remove(map.id)}
          className="gap-2 text-xs text-muted-foreground"
        >
          <Trash2 className="size-3.5" />
          Delete this map
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The bar over everything: which map is shown, how to map it, which agent does it, and the way to its chat. */
function GraphBar({
  graph,
  stale,
}: {
  graph: Graph;
  stale: boolean;
}): React.JSX.Element {
  const [wording, setWording] = useState(graph.instructions);
  const [provider, setProvider] = useState<AgentProvider | undefined>(
    undefined,
  );
  const chosen = provider ?? graph.providers[0];
  const has = graph.map !== undefined;
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen) void graph.build(wording, chosen);
      }}
    >
      <MapPicker graph={graph} />
      <Input
        value={wording}
        onChange={(event) => setWording(event.target.value)}
        placeholder="Anything to focus on? For example: what this puts at risk, or the data model"
        aria-label="How to map the pull request"
        className="h-8 min-w-48 flex-1 text-xs"
      />
      {graph.providers.length > 1 ? (
        <SegmentedControl
          value={chosen}
          onValueChange={(value) => setProvider(value as AgentProvider)}
          aria-label="Agent that maps the change"
          className="text-xs"
        >
          {graph.providers.map((name) => (
            <SegmentedControlOption key={name} value={name}>
              {PROVIDER_NAME[name]}
            </SegmentedControlOption>
          ))}
        </SegmentedControl>
      ) : null}
      <Button
        type="submit"
        size="sm"
        variant={has ? "outline" : "default"}
        disabled={graph.running || !chosen}
      >
        {graph.running ? "Mapping…" : has ? "New map" : "Map concepts"}
      </Button>
      {graph.openChat ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={graph.openChat}
          title="The mapping conversation, in the Git Agent: ask it to split, merge or rename concepts"
        >
          <MessageSquare className="size-3.5" />
          Open chat
        </Button>
      ) : null}
      {stale && !graph.running ? (
        <p className="basis-full text-xs text-muted-foreground">
          The pull request has moved on since this map was made. It shows the
          change as it was then; make a new map to include the new work.
        </p>
      ) : null}
    </form>
  );
}

/**
 * Where in the hierarchy the map is looking, and the way back up. Clicking a box with anything
 * inside it goes a level deeper into *that* box, so the trail is how you climb out again — the
 * same gesture as opening a folder.
 */
function Trail({
  trail,
  onGo,
  up,
  done,
  total,
  view,
  onView,
  layout,
  onLayout,
}: {
  trail: Concept[];
  onGo: (id: string) => void;
  up?: () => void;
  done: number;
  total: number;
  view: View;
  onView: (view: View) => void;
  layout: NetworkLayout;
  onLayout: (layout: NetworkLayout) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1 border-b border-border px-4 py-2">
      <SegmentedControl
        value={view}
        onValueChange={(value) => onView(value as View)}
        aria-label="How the map is drawn"
        className="text-xs"
      >
        <SegmentedControlOption value="network">Network</SegmentedControlOption>
        <SegmentedControlOption value="cards">Cards</SegmentedControlOption>
      </SegmentedControl>
      {view === "network" ? (
        <SegmentedControl
          value={layout}
          onValueChange={(value) => onLayout(value as NetworkLayout)}
          aria-label="How the network is laid out"
          className="mr-2 text-xs"
        >
          <SegmentedControlOption value="radial">Radial</SegmentedControlOption>
          <SegmentedControlOption value="layered">
            Layered
          </SegmentedControlOption>
        </SegmentedControl>
      ) : (
        <span className="mr-1" />
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Up a level  ⌫"
        title="Up a level  ⌫"
        disabled={!up}
        onClick={up}
      >
        <ChevronLeft />
      </Button>
      <nav
        aria-label="Where you are in the map"
        className="flex min-w-0 flex-wrap items-center gap-0.5"
      >
        {trail.map((concept, i) => (
          <span key={concept.id} className="flex min-w-0 items-center gap-0.5">
            {i > 0 ? (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            <button
              type="button"
              onClick={() => onGo(concept.id)}
              aria-current={i === trail.length - 1}
              className={cn(
                "max-w-48 truncate rounded px-1.5 py-0.5 text-xs hover:bg-accent",
                i === trail.length - 1
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {i === 0 ? "Whole change" : concept.title}
            </button>
          </span>
        ))}
      </nav>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
        {done} of {total} reviewed here
      </span>
    </div>
  );
}

/** One concept's card on the map: what it is, how much code sits under it, and how far reviewed. */
function CardBody({
  card,
  reviewed,
}: {
  card: ConceptCard;
  reviewed: boolean;
}): React.JSX.Element {
  const { concept } = card;
  return (
    <>
      <span className="line-clamp-2 text-sm leading-snug font-semibold">
        {concept.title}
      </span>
      <span className="line-clamp-3 text-xs leading-snug text-muted-foreground">
        {concept.summary}
      </span>
      <span className="mt-auto flex items-center gap-2 pt-1 font-mono text-[10px] text-muted-foreground">
        <span>
          {concept.effect === "context"
            ? "no changed code"
            : `${card.files} ${card.files === 1 ? "file" : "files"} · ${card.hunks} ${card.hunks === 1 ? "hunk" : "hunks"}`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {card.deeper > 0 ? `${card.deeper} deeper` : null}
          {reviewed ? <Checkbox checked readOnly className="size-3" /> : null}
        </span>
      </span>
    </>
  );
}

/** A file's stub for the content pane when the diff list no longer has it (the map is older than the diff). */
const stub = (path: string): ChangedFile =>
  ({
    path,
    status: "M",
    additions: 0,
    deletions: 0,
    binary: false,
    staged: "unstaged",
    conflicted: false,
    headSha: null,
  }) as ChangedFile;

/**
 * One concept, opened: what it is on the left with the files under it, and on the right one file at
 * a time through the same pane Changes uses. Tracing works from any rung, so the files here are
 * everything beneath this concept, not only what it owns itself.
 */
function ConceptDetail({
  worktreeId,
  spec,
  card,
  files,
  comments,
  mode,
  reviewed,
  onReviewed,
  onOpen,
}: {
  worktreeId: string;
  spec: DiffSpec;
  card: ConceptCard;
  files: ChangedFile[];
  comments: ReviewComment[];
  mode: DiffMode;
  reviewed: boolean;
  onReviewed: (on: boolean) => void;
  onOpen: (concept: Concept) => void;
}): React.JSX.Element {
  const { concept } = card;
  const own = useMemo(() => conceptFiles(card.coverage), [card.coverage]);
  const patches = useFilePatches(
    worktreeId,
    spec,
    own.map((file) => file.path),
  );
  const [picked, setPicked] = useState(0);
  const shown = own[Math.min(picked, own.length - 1)];
  const changed = shown
    ? (files.find((file) => file.path === shown.path) ?? stub(shown.path))
    : undefined;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border px-5 py-5">
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {concept.id}
          </span>
          {concept.kind ? (
            <span className="text-xs text-muted-foreground">
              {concept.kind}
            </span>
          ) : null}
        </div>
        <h3 className="text-base leading-snug font-semibold">
          {concept.title}
        </h3>
        {concept.summary ? (
          <LinkedMarkdown className="text-sm text-muted-foreground">
            {concept.summary}
          </LinkedMarkdown>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {EFFECT_WORD[concept.effect]}
        </p>
        {concept.layers.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {concept.layers.map((layer) => (
              <Badge
                key={layer}
                variant="outline"
                className="font-normal text-muted-foreground"
              >
                {layer}
              </Badge>
            ))}
          </div>
        ) : null}

        {concept.children.length > 0 ? (
          <div className="flex flex-col gap-1 pt-1">
            <p className="text-xs text-muted-foreground">More precisely</p>
            {concept.children.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => onOpen(child)}
                className="rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                title={child.summary}
              >
                {child.title}
              </button>
            ))}
          </div>
        ) : null}

        {concept.commits.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <GitCommitHorizontal className="size-3.5 text-muted-foreground" />
            {concept.commits.map((sha) => (
              <span
                key={sha}
                className="font-mono text-[11px] text-muted-foreground"
              >
                {sha.slice(0, 7)}
              </span>
            ))}
          </div>
        ) : null}

        {concept.paths.length > 0 && own.length === 0 ? (
          <ul
            className="flex flex-col gap-0.5 pt-1"
            aria-label="Code this concept concerns"
          >
            <li className="px-1.5 text-xs text-muted-foreground">
              Lives in, unchanged by this PR
            </li>
            {concept.paths.map((path) => (
              <li
                key={path}
                className="truncate px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                title={path}
              >
                {path}
              </li>
            ))}
          </ul>
        ) : null}

        {own.length > 0 ? (
          <ul
            className="flex flex-col gap-0.5 pt-1"
            aria-label="Files under this concept"
          >
            {own.map(({ path, hunks }, i) => {
              const patch = patches[i]?.data?.patch;
              const stat = patch ? slicePatch(patch, hunks) : undefined;
              return (
                <li key={path}>
                  <button
                    type="button"
                    aria-current={i === picked}
                    onClick={() => setPicked(i)}
                    title={path}
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-accent",
                      i === picked && "bg-accent text-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {path.split("/").pop()}
                    </span>
                    {stat ? (
                      <span className="shrink-0 tabular-nums">
                        <span className="text-nessa-diff-addition">
                          +{stat.additions}
                        </span>{" "}
                        <span className="text-nessa-diff-deletion">
                          −{stat.deletions}
                        </span>
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={reviewed}
              onChange={() => onReviewed(!reviewed)}
              className="size-3.5"
            />
            Reviewed
          </label>
        </div>
      </aside>
      <div className="min-h-0 min-w-0">
        {changed && shown ? (
          <ContentPane
            key={`${concept.id}:${shown.path}`}
            worktreeId={worktreeId}
            spec={spec}
            file={changed}
            hunks={shown.hunks}
            comments={comments.filter((comment) => comment.file === shown.path)}
            mode={mode}
          />
        ) : (
          <p className="px-6 py-5 text-sm text-muted-foreground">
            This concept has no changed code of its own — it is here because the
            change leans on it.
          </p>
        )}
      </div>
    </div>
  );
}

/** What the change puts at risk without touching, derived from the leans-on links. */
function Affected({
  result,
  onOpen,
}: {
  result: ConceptGraph;
  onOpen: (concept: Concept) => void;
}): React.JSX.Element | null {
  const rows = useMemo(() => affectedCards(result), [result]);
  if (rows.length === 0) return null;
  return (
    <div className="border-t border-border px-4 py-3">
      <p className="text-xs text-muted-foreground">
        Worth a look — nothing changed here, but it leans on something that did.
        A prompt, not a proof: the map reaches as far as the agent read.
      </p>
      <div className="flex flex-wrap gap-1.5 pt-2">
        {rows.map(({ concept, because }) => (
          <Button
            key={concept.id}
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onOpen(concept)}
            title={`Leans on ${because.map((c) => c.title).join(", ")}`}
          >
            {concept.title}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The Git tab's Concept Graph pane. A pull request as a hierarchy of concepts: pick how precisely
 * to describe it, open a box to go finer, and the code is always one click below whatever you are
 * looking at.
 */
export function ConceptGraphView({
  worktreeId,
  graph,
  comments,
  mode,
  onOpenRef,
}: {
  worktreeId: string;
  graph: Graph;
  comments: ReviewComment[];
  mode: DiffMode;
  onOpenRef?: OpenFileRef;
}): React.JSX.Element {
  const result = graph.result;
  // The map's *own* files, between the two trees it was cut from — not the worktree's diff. A PR
  // map describes committed work, so the working tree says nothing about it: taken from there, a
  // file the PR adds reads as modified, a committed file cannot be opened at all, and the
  // staleness check compares two unrelated diffs.
  const own = useDiffFiles(
    worktreeId,
    graph.spec ?? { kind: "worktree", against: "base" },
  );
  const files = (graph.spec ? own.data?.files : undefined) ?? [];
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [view, setView] = useState<View>("network");
  const [layout, setLayout] = useState<NetworkLayout>("radial");
  /** The dot the inspector is open on, beside the network. */
  const [pickedNode, setPickedNode] = useState<string | undefined>(undefined);
  // ChangeMap is vendored and hands `onSelect` no mouse event, so the modifier is read on the way
  // down: ⌘/Ctrl-click means "show me the code", a plain click means "look inside".
  const deepClick = useRef(false);

  // Where the map is looking. A focus that no longer exists (a remap renumbered the spine) falls
  // back to the top rather than showing nothing.
  const trail = useMemo(
    () => (result ? trailTo(result.root, graph.focus) : []),
    [result, graph.focus],
  );
  const focused = trail.at(-1) ?? result?.root;
  const parents = useMemo(
    () => (result ? parentOf(result.root) : new Map<string, string>()),
    [result],
  );

  // Looking inside a box shows what is inside it; a box with nothing inside stands for itself.
  const shown = useMemo(
    () =>
      focused
        ? focused.children.length > 0
          ? focused.children
          : [focused]
        : [],
    [focused],
  );
  const cards = useMemo(() => shown.map((concept) => cardOf(concept)), [shown]);
  const affectedIds = useMemo(
    () =>
      new Set(
        result ? affectedCards(result).map(({ concept }) => concept.id) : [],
      ),
    [result],
  );
  // Built once per map and shared by the network and its inspector, so both see the same atoms.
  const network = useMemo(
    () => (result ? networkOf(result) : undefined),
    [result],
  );
  // A pick is an id in *this* network. Another map, or a newer result, can drop that id or give
  // it to a different concept, so the inspector lets go rather than showing the wrong one.
  useEffect(() => setPickedNode(undefined), [network]);

  const nodes = useMemo<ChangeMapNode[]>(
    () =>
      cards.map((card) => ({
        id: card.concept.id,
        label: card.concept.title,
        status: affectedIds.has(card.concept.id)
          ? "affected"
          : STATUS_OF[card.concept.effect],
        badge: card.concept.id === "root" ? undefined : card.concept.id,
        children: (
          <CardBody
            card={card}
            reviewed={graph.reviewed.has(reviewedKey(card.coverage))}
          />
        ),
      })),
    [cards, affectedIds, graph.reviewed],
  );
  const shownIds = useMemo(
    () => new Set(cards.map((card) => card.concept.id)),
    [cards],
  );
  const edges = useMemo(
    () =>
      result
        ? result.links
            .filter((link) => shownIds.has(link.from) && shownIds.has(link.to))
            .map(({ from, to }) => ({ from, to }))
        : [],
    [result, shownIds],
  );

  const byId = useMemo(
    () => new Map(cards.map((card) => [card.concept.id, card])),
    [cards],
  );
  const openedCard = opened ? byId.get(opened) : undefined;
  const done = cards.filter((card) =>
    graph.reviewed.has(reviewedKey(card.coverage)),
  ).length;
  // The live PR head, so a push past the one the map pinned is noticed as well as a reshaped diff.
  const prHead = usePullRequest(
    worktreeId,
    graph.map?.subject === "pull-request",
  ).data?.pr?.headSha;
  const stale =
    result && graph.map && files.length > 0
      ? isStale(graph.map, result, files, prHead)
      : false;

  const goTo = (id: string): void => {
    graph.setFocus(id);
    setOpened(undefined);
  };
  const parent = focused ? parents.get(focused.id) : undefined;
  const up = parent ? () => goTo(parent) : undefined;

  /** A plain click looks inside; ⌘/Ctrl-click, or a box with nothing inside, opens the code. */
  const onPick = (id: string): void => {
    const concept = byId.get(id)?.concept;
    if (!concept) return;
    if (deepClick.current || concept.children.length === 0) setOpened(id);
    else goTo(id);
  };

  /** Opening a concept from elsewhere (the affected list, a child link) walks the map to it first. */
  const open = (concept: Concept): void => {
    if (!shownIds.has(concept.id))
      graph.setFocus(parents.get(concept.id) ?? concept.id);
    setOpened(concept.id);
  };

  /** A dot on the network opens the inspector beside it; the same dot again closes it. */
  const pickNode = (node: NetNode): void =>
    setPickedNode((current) => (current === node.id ? undefined : node.id));

  // ⌫ climbs out of the box you are in; Esc closes whatever is open beside the map.
  // Bindings are matched on the raw key name, so these are capitalised as the browser reports them.
  useHotkeys({
    ...(opened || up
      ? { Backspace: () => (opened ? setOpened(undefined) : up?.()) }
      : {}),
    ...(pickedNode || opened
      ? {
          Escape: () =>
            pickedNode ? setPickedNode(undefined) : setOpened(undefined),
        }
      : {}),
  });

  return (
    // Every `path:line` a concept's summary mentions, in the cards and in the inspector alike,
    // opens where the reviewer is already reading.
    <FileRefLinks onOpen={onOpenRef}>
      <div className="flex min-h-0 flex-1 flex-col">
        <GraphBar key={graph.map?.id} graph={graph} stale={stale} />
        {graph.error ? (
          <div className="px-4 py-3">
            <ErrorNote error={graph.error} />
          </div>
        ) : null}

        {!result ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <p className="text-sm text-muted-foreground">
              {graph.running
                ? "Reading the pull request…"
                : "No concept map yet. Map concepts reads the pull request and draws what it does, as ideas you can open one rung at a time."}
            </p>
          </div>
        ) : (
          <>
            <Trail
              trail={trail}
              onGo={goTo}
              up={up}
              done={done}
              total={cards.length}
              view={view}
              onView={setView}
              layout={layout}
              onLayout={setLayout}
            />
            {openedCard && graph.spec ? (
              <>
                <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => setOpened(undefined)}
                  >
                    Back to the map
                  </Button>
                  <span className="truncate text-xs text-muted-foreground">
                    {openedCard.concept.title}
                  </span>
                </div>
                <ConceptDetail
                  worktreeId={worktreeId}
                  spec={graph.spec}
                  card={openedCard}
                  files={files}
                  comments={comments}
                  mode={mode}
                  reviewed={graph.reviewed.has(
                    reviewedKey(openedCard.coverage),
                  )}
                  onReviewed={(on) =>
                    graph.setReviewed(reviewedKey(openedCard.coverage), on)
                  }
                  onOpen={open}
                />
              </>
            ) : view === "network" && network ? (
              <div className="flex min-h-0 flex-1">
                <div className="relative min-h-0 min-w-0 flex-1">
                  <NetworkLegend affected={affectedIds.size} />
                  <ConceptNetwork
                    network={network}
                    layout={layout}
                    picked={pickedNode}
                    onPick={pickNode}
                    onClear={() => setPickedNode(undefined)}
                  />
                </div>
                {pickedNode && graph.spec ? (
                  <ConceptInspector
                    key={pickedNode}
                    network={network}
                    nodeId={pickedNode}
                    worktreeId={worktreeId}
                    spec={graph.spec}
                    comments={comments}
                    mode={mode}
                    reviewed={graph.reviewed}
                    onReviewed={graph.setReviewed}
                    onPick={setPickedNode}
                    onClose={() => setPickedNode(undefined)}
                  />
                ) : null}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* Capture phase: the modifier has to be read before ChangeMap's own click handler runs. */}
                <div
                  className="p-4"
                  onClickCapture={(event) =>
                    (deepClick.current = event.metaKey || event.ctrlKey)
                  }
                >
                  <ChangeMap
                    title={
                      focused?.id === "root"
                        ? "What this pull request does"
                        : (focused?.title ?? "")
                    }
                    nodes={nodes}
                    edges={edges}
                    arrangement="grid"
                    cardSize={{ width: 260, height: 136 }}
                    onSelect={(node) => onPick(node.id)}
                    caption="Click a box to look inside it; ⌘/Ctrl-click to jump straight to its code. ⌫ goes back up. Everything inside a box is still counted by it, so nothing is hidden by looking away."
                  />
                </div>
                <Affected result={result} onOpen={open} />
              </div>
            )}
          </>
        )}
      </div>
    </FileRefLinks>
  );
}
