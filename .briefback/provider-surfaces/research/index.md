# Provider surfaces: research index

Question: what the app needs to (1) show the usage of the providers in the window header, in bb's look, (2) let a chat pick its provider, model and every reasoning level the model supports, in Reforma's style (no Auto, no subscription footer), and (3) make the chats of a switched-off provider read-only with a hand-off. Snapshot 2026-11-18, `main` at `fe984fe`. Earlier work: `../../agent-accounts/` (Providers page, usage, model list).

## Summary

- **A chat has no provider, model or effort.** Only the orchestrator run has `engine` and `model`; effort exists nowhere. `chat.create` and `chat.send` carry none of them. Each turn is a new agent process that resumes the vendor session, so a choice has to be applied at the start of every turn. See `session-model-effort.md` sections 1 and 5.
- **Claude and Codex:** model and effort are `session/set_config_option` (`model`, then `effort` / `reasoning_effort`, category `thought_level`), live, probed on this machine without a prompt. Levels differ per model (0 to 6). A session starts on the user's own settings (`sonnet`, `gpt-6-sol` + `high` here), not on the catalog's default row. Claude's effort is not kept by a new process; Codex's is kept after a turn.
- **Cursor:** effort is a per-family option whose id varies; selectable over ACP only when the client advertises `_meta.parameterizedModelPicker`; its effect on a real turn is **unverified**. `ModelCatalog` parses `--list-models` (280 flattened variants); the ACP list has 48 families with typed options.
- **Reforma's picker** ("grade" picker): a 320px popover with a model button and a reasoning slider; the button swaps in a model list (a pane swap with an animated height). Levels stop at `high` because of one constant of four levels. Auto and the "Use my subscription" footer are cleanly separable. `motion` is not a dependency of `apps/desktop`. See `reforma-model-picker.md`.
- **Header:** `TitleBand` has a free slot left of the shortcuts button; all data is in `useAgents()`. See `header-usage-and-readonly.md`.
- **A switched-off provider** fails a chat only when a run starts ("`<Agent>` is switched off in Clowdy"); the desktop shows nothing in advance.

## Pages

- [session-verification.md](session-verification.md): real one-word turns on all three agents: what reaches a turn, what survives a resume, the context readings and `/compact`.

- [session-model-effort.md](session-model-effort.md): what a chat/run stores, how engine, model and effort are chosen and applied, the three adapters' options and probes, gaps in the daemon and protocol.
- [reforma-model-picker.md](reforma-model-picker.md): where the picker lives in Reforma, its exact look, data model, primitive parity, what to leave out, port checklist.
- [header-usage-and-readonly.md](header-usage-and-readonly.md): the header band, the data a status needs, bb's popover, chats and the provider, the composer's place.

## Important files

`packages/protocol/src/{domain,commands,agents}.ts`, `apps/daemon/src/{commands/chat.ts,runs/service.ts,runs/driver.ts,engine/acp/session.ts,providers/models.ts}`, `apps/desktop/src/renderer/{shell/TitleBand.tsx,features/chats/Composer.tsx,features/chats/ChatView.tsx,features/agents/DraftChat.tsx,features/settings/providers/}`; Reforma `apps/front/src/editor/chat/composer/ChatComposerGrade*.tsx`.

## Open questions research could not answer

- Real resume behaviour of model and effort for all three (no prompt was sent).
- Whether Cursor honours a model or effort set over ACP at runtime.
- Whether Claude's `_meta.claudeCode.options.{model,effort}` at resume changes a resumed session.

## Coverage and side effects

The probe run for Cursor walked all 48 model values in a throwaway session by mistake and restored the default; Cursor's default stayed `Auto`, and four empty sessions may remain in its history (details in `session-model-effort.md`). Nothing was run for Windows.
