# Reforma reference: context usage and compaction

Reference repo: `/Users/bionic/WORK/Reforma/reforma` (read-only). All paths below are relative to it.

## Summary

Reforma shows context fill as a small ring in the composer's bottom row, but only once the
conversation alone passes 50K tokens. The ring opens a popover with a per-bucket breakdown, a meter,
and a `Compact` button. Compact does not call a special endpoint: it sends `/summarize` as an ordinary
user turn (queued as a next turn if the agent is busy). In the transcript, compaction is a single line
of text inside the assistant message: a shimmer `Summarizing chat context` while it runs on the live
tail, then a quiet `Chat context summarized`. There is no divider and no visible summary block; the
summary itself is persisted for the model and stripped before it reaches the client.

Everything that decides *when* to compact (thresholds, reasons, microcompaction, the summarizer
prompt) lives in Reforma's own agent loop and does not carry over to an ACP client.

## What the user sees

### Usage ring (`ChatComposerContextUsage`)

File: `apps/front/src/editor/chat/composer/ChatComposerGrade.tsx`.

- Rendered by `ChatComposerInput` in the `composerMode` row: bottom-right of the composer, left of the
  model picker (`ChatComposerGrade`), which sits left of the send button. Not shown in ephemeral
  (comment) composers.
- Visible only when `thread.contextUsage` exists, `window > 0`, the `conversation` bucket is above
  `COMPACT_CONVERSATION_TOKENS = 50_000`, and the composer controller has `runSlashCommand`.
- Button: `size="sm" iconOnly rounded variant="filling"`, tooltip `Show context usage`, aria-label
  `Context usage, N% full`. Opacity 0.4 at rest, 1 on hover or press (`.composerUsage`).
- `UsageRing`: 16×16 SVG, track circle at 35% opacity plus an arc with `strokeDasharray` for
  `total / window`, both `stroke: currentColor`, width 1.5, round caps, starting at 12 o'clock.

### Popover (`ContextUsagePanel`)

`Popover placement="top" spacing="lg" width={224}`, title `Context usage` (`typography-heading-6`).

- One row per non-empty bucket: colour swatch, label (`Instructions`, `Tools`, `Conversation`),
  tokens formatted as `12.3K` (`formatTokenCount`, trailing `.0` dropped).
- Footer, separated by a top border: `N% full` and `~X.XK / Y.YK`, then a segmented meter
  (`role="meter"`, flex-grow per bucket, grey remainder), then a full-width `Compact` button
  (`size="sm" variant="bordered" color="secondary"`) that runs `/summarize` and closes the popover.
- Bucket colours: instructions `--color-secondary-border`, tools `--color-accent`, conversation
  `--color-warning`. Track `--color-secondary-muted`.

### Other ways to compact

- Slash command `/summarize` in the composer picker and in the Plus menu under Commands, both with
  the description `Compact the conversation to free context` (`ChatComposerInput.tsx`
  `slashCommands`, `ChatComposerPlus.tsx`).
- `ChatComposerSession.runSlashCommand('summarize')` → `useComposerSend().sendOutOfBand('/summarize')`:
  builds a throwaway draft so the live composer text stays, sends it as a turn, or enqueues it as
  `next-turn` while a run works. The `/summarize` user message then shows as a normal user bubble.

### In the chat stream

The agent writes a `data-context-compaction` part into the assistant message:
`{ done: false, trigger }` when it starts, `{ done: true, trigger, … }` when the summary is ready.

- `MessageContextCompactionSegment`
  (`packages/components/src/chat/Message/segments/MessageContextCompactionSegment.tsx`) renders one
  line for a run of compaction parts:
  - not done, streaming, and this is the message tail → `<Shimmer as={Text} duration={1}>Summarizing
    chat context</Shimmer>`;
  - done and the reason is not `idle` or `onboarding` → `<Text color="secondary">Chat context
    summarized</Text>`;
  - otherwise nothing (background passes stay silent: `isCompactionNoticeShown` in
    `parts/contextCompactionPart.ts`).
- Grouping (`normalizeMessageParts.ts`): consecutive compaction parts merge into one `compaction`
  group. A trailing compaction group renders outside the collapsed "worked for" fold; one in the middle
  of a turn (mid-turn compaction) sits inside the fold with the tool steps.
- `ConversationPendingLoader.messagePartShowsPendingActivity` treats an unfinished compaction part as
  live activity, so the generic pending shimmer hides while the compaction shimmer shows.
- `ChatThread.isFinishedReply` (`apps/front/src/runtime/chat/ChatThread.ts`) counts a reply that ends
  on a finished compaction with reason `command` as complete, so `/summarize` does not trigger the
  Resume banner. Automatic compactions precede a real reply.
- Story: `apps/front/src/editor/chat/Chat.stories.tsx` → `ContextCompaction`.

## Data shapes

```ts
// packages/types/src/sandbox/usage-metadata.ts
type ReformaContextUsage = {
    window: number;  // product context ceiling, not the vendor window (hard cap 200K)
    total: number;   // prompt tokens in the last model step
    buckets: { id: 'instructions' | 'tools' | 'conversation'; tokens: number }[];
};

// packages/types/src/sandbox/ui-message.ts
type ReformaChatContextCompactionReason =
    | 'command' | 'max-messages' | 'token-threshold' | 'token-threshold-turn'
    | 'provider-context-limit' | 'idle' | 'onboarding';

interface ReformaChatDataContextCompactionPayload {
    done: boolean;
    trigger?: { reason; tokens?; threshold?; contextWindow?; messageCount: number; detail? };
    messages?: ReformaUIMessage[]; // the summary window for the model; persisted, stripped before the client
    resumeMessageId?: string;
}
```

`contextUsage` reaches the front on the thread snapshot (`chat-thread:<id>`, same channel as the queue)
and on thread detail; the front stores it as `ChatThread.contextUsage`. After a compaction outside a
model step the server re-measures only the conversation bucket (`withCompactedConversation`).

## Server side (Reforma-agent-specific)

- `apps/sandbox/src/chat/agent/context-usage.ts`: `measureContextUsage` takes the provider's last-step
  input tokens as the total and splits it across buckets by character weight (system prompt, tool
  schemas, messages since the last compaction), with largest-remainder rounding (`calibrateBuckets`).
  `buildRunMetadata` publishes it to the thread after each step.
- `apps/sandbox/src/chat/agent/compaction/chat-compaction.ts`:
  - Caps: soft 130K, hard 200K (`models/model-options.ts`), both clamped to `contextWindow − 15K`.
  - `chatSummarizeRequired` before a reply: `/summarize` → `command`; more than 50 messages and at
    least 60% of the soft threshold → `max-messages`; last-step tokens ≥ soft threshold →
    `token-threshold`; ≥ 50% of soft and 30 minutes idle → `idle`.
  - Mid-turn: `stepsExceedCompactionThreshold` against the hard threshold →
    `token-threshold-turn`; a provider context-limit error → `provider-context-limit`.
  - `summarizeMessages` keeps the latest turn (40K budget) and older microcompacted turns up to 30K,
    summarizes the rest into at most 5K tokens with the `subagents/context-compaction.md` prompt, and
    resumes mid-turn work with the synthetic user text `Continue from the handoff.`
- `compaction/microcompact.ts`: shrinks old tool results by age tier (as-is, lite, heavy, extreme)
  before summarizing.
- `agent.ts` `runCompaction`: writes the `done: false` part, runs the summary as its own billed phase,
  writes the `done: true` part, and attaches it to the live assistant message.

## Components, styles, dependencies

| Piece | Source | Notes |
| --- | --- | --- |
| `ChatComposerContextUsage`, `UsageRing`, `ContextUsagePanel`, `formatTokenCount` | `apps/front/src/editor/chat/composer/ChatComposerGrade.tsx` | Reads `useOptionalThread().contextUsage`, `useOptionalComposerController().runSlashCommand`. |
| Usage styles | `ChatComposerGrade.module.css` (`.usageRing`, `.usageTrack`, `.usageArc`, `.usage`, `.rows`, `.row`, `.swatch`, `.label`, `.tokens`, `.footer`, `.percent`, `.total`, `.bar`, `.barSegment`, `.barRest`, `.compact`); `ChatComposer.module.css` (`.composerMode`, `.composerUsage`) | CSS modules + tokens (`--spacing-*`, `--radius-xs/full`, colour tokens above, `@ruleset typography-text-sm`). |
| `MessageContextCompactionSegment`, `isContextCompactionUIPart`, `isCompactionNoticeShown` | `packages/components/src/chat/Message/segments/…`, `…/parts/contextCompactionPart.ts` | Uses `Shimmer`, `Text`. |
| UI kit | `@reforma/components` | `PopoverTrigger`, `Popover`, `OverlayTriggerStateContext`, `Button`, `Box`, `Text`, `For`, `Show`, `Shimmer`. |

## Agent-specific vs portable to an ACP client

Portable:

- The ring, the popover layout, the meter, the copy, and the "only show when it matters" rule. With
  ACP the client usually gets a single used/size pair rather than buckets, so the panel reduces to one
  row (or a bar without a breakdown) and the visibility rule should key on `used / size` instead of
  the conversation bucket.
- "Compact" as a normal turn: send the agent's own compact command through the same send path, so it
  queues while the agent works. Claude Code and the Codex CLI both call it `/compact`; check what each
  adapter actually advertises in its available commands. Clowdy already
  has a compact-turn concept (commit `09960f2`, "retry a compact turn as the compact command").
- The stream notice: one shimmer line while compaction runs, one secondary line after, no divider.
  Porting needs a signal that compaction started and finished. Reforma gets it from its own
  `data-context-compaction` part; Clowdy has to derive it from what the adapter reports for a
  compact turn (its command run, or an agent notice), and stay silent when it cannot tell.
- The rule that a manual compact ending on the notice is a finished turn (no Resume prompt).

Not portable (Reforma decides inside its agent):

- Thresholds, reasons, idle compaction, microcompaction tiers, the summarizer prompt and budgets, the
  mid-turn handoff resume. Claude Code and Codex auto-compact on their own rules; Clowdy can only show
  the result.
- The bucket breakdown (instructions / tools / conversation) depends on Reforma knowing its own
  system prompt and tool schemas.
