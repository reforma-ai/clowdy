# Real checks: message actions

Stage 3 of `.briefback/message-actions/plan.md`. The question: does `session/fork` with `_meta.jetbrains.air.fork` (`{ version: 1, messageId }`) work end to end through the daemon's own engine, at the message id the daemon stored at a turn end? Date: 2026-11-20 (local evening). Nothing here is a test: it spends the owner's subscription, so it is run by hand, and rerun on every bump of an adapter pin (`catalog.ts`, `AgentSpec.fork`).

## Verdict

| Agent | Pin | Result | Flag |
| --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp@0.107.0`, the user's `claude` 2.1.312 (`CLAUDE_CODE_EXECUTABLE`), model `haiku` | **Pass.** The stored point of each turn is the real `msg_...` id, a fork at it copies the session through that message and no further, and the fork answers from the cut history | `fork: true` |
| Codex | `@agentclientprotocol/codex-acp@2.8.0`, the user's `codex` 0.166.0 | **Not run.** `bun x` of the pin is blocked by the machine's `minimumReleaseAge` (3 days; 2.8.0 is from 2026-11-19), not bypassed | `fork` stays off |

## Setup

A scratch daemon made of the daemon's own modules in one Bun process (script in the appendix), so nothing of the owner's is touched: data dir, projects dir and personal dir are folders under the session scratchpad, port `47311` (not the default random one), token `scratch-token`, user skill folders pointed at an empty folder, `CLOWDY_PROFILE=scratch`. The agent is started exactly as a run starts it (`AcpEngine` over the real `AgentRegistry`: `bun x --bun <pinned package>`, `CLAUDE_CODE_EXECUTABLE` pointing at the user's `claude`). The project folder is an empty scratch folder. Claude Code keeps its session files under `~/.claude/projects/<scratch folder>/`; they stay there (three small files per run).

```
cd <a scratch folder that holds only the script>
bun fork-check.ts claude <scratch dir>
```

Prompts (tiny; the system prompt of the orchestrator and its skill make the first turn about 27k input tokens, which is the daemon's own overhead):

1. Run 1 (the two prompts of the brief): `Remember the word PINEAPPLE. Reply OK.`, then `Say the word I asked you to remember.`
2. Run 2 (a cut that can be told from no cut: the number comes only in turn 2, and turn 2 calls a tool): `Remember the word PINEAPPLE. Reply OK.`, then `Run \`echo MANGO\` in the shell, then reply with the word it printed. Also remember the number 417.`

Both through `chat.send` on one chat (`engine: claude`, `model: haiku`), so every turn is a real `RunDriver` turn that resumes the one session.

## Claude Code, run 2 (the one that decides)

Stream as a client reads it (`streamItems`, with the stored point beside it):

```
#1 user      canEdit        "Remember the word PINEAPPLE. Reply OK."
#2 assistant canFork  ref=msg_011ChFJmoXJ7TW4XDwFLgBac  "OK"
#3 user      canEdit        "Run `echo MANGO` in the shell, ..."
#4 tool                      Bash done
#5 assistant canFork  ref=msg_011ChFJnF4CFwihy47V5MP6b  "MANGO\n\nI'll keep 417 in mind for the rest of this chat."
```

| Step | Observed |
| --- | --- |
| Points stored | Only on the two final answers (#2, #5). The tool item and the user messages hold none. `canEdit` is on both user messages: the first is the first item, the second follows a turn that ended at a point |
| The id is the provider's own | In the session file `~/.claude/projects/<scratch folder>/<session>.jsonl` both ids are `message.id` of `assistant` entries (`msg_...`, stop reason `end_turn`). One message is two entries there (an empty one, then the text) under the same id, which is why the adapter's fork "ends at the last entry of that message" |
| Fork at turn 1's point (`msg_011ChFJmoXJ7TW4XDwFLgBac`) | New session `c576b639-...` in 653 ms. Asked once: `Which word and which number did I ask you to remember? Answer as "<word>, <number>", with "none" for anything I did not ask you to remember.` Answer: `PINEAPPLE, none`. The number said only in turn 2 is cut |
| Fork at turn 2's point (`msg_011ChFJnF4CFwihy47V5MP6b`) | New session `d15699c3-...` in 833 ms. Same question: `PINEAPPLE, 417` |
| The tool call of turn 2 is in that copy | A second fork at the same point, asked `What did the shell command print? Answer with the word only.`: `MANGO`. The `tool_use` and its result were kept as a pair; no dangling call |
| The source session is untouched | The same question in the source: `PINEAPPLE, 417` |
| Fork with what a turn gives a resume | `fork({ tools: [ping], systemPrompt, additionalDirectories: [extra] })` (the bridge's MCP server, a prompt, another folder; `real-check3` in the scratchpad, on the run's session): new session in 1176 ms, and a prompt in it (resumed with the same tools) answers `PINEAPPLE` |
| Process after the call | None left: `fork` returns after the adapter's process has exited (`test/acp-fork.test.ts` asserts it with the fake agent, and `ps` showed no `claude-agent-acp` after the runs) |

Claude Code, run 1 (the brief's prompts), for the record: points `msg_011ChFJdJqeLaTGJ3YbPxJy1` and `msg_011ChFJdZuGo6NDbW6wqGRzA`; the fork at turn 1 answered `PINEAPPLE`, the fork at turn 2 quoted `Say the word I asked you to remember.` as the second thing asked, the source answered. Its "was it cut" question did not tell a cut from no cut (the last thing asked before the question is the same either way), which is why run 2 exists.

### Surprises and things to know

- **Title of the fork.** The adapter names the fork `<source's title> (fork)`: the fork's transcript has `custom-title` = `Clowdy:orchestrate autopilot (fork)`, where the source's own `ai-title` is `Clowdy:orchestrate autopilot` (the model named the session from its first message). The fork sends no `session_info_update` when it is resumed and prompted (`onTitle` was never called), so the daemon never sees the title. Clowdy titles the new chat itself (`(n) <source title>`), so this is only what shows in the user's own `claude --resume` list.
- **Usage reported first.** The first prompt of a fork reports `usage` with tokens (`inputTokens` 27767, `outputTokens` 12 in run 2) and **no `costUsd`**: the daemon keeps a session's cumulative cost per session id, a fork is a session id it has never measured, so the first turn has no baseline (the same as any resumed session after a daemon restart). From the second prompt on `costUsd` is there (0.0042 on the next one in run 1). The first turn's cost of a fork is therefore not counted in `Run.usage` (its tokens are). Not a blocker; Stage 4 may want to seed the baseline.
- **Models.** Each resumed turn starts on the adapter's default model and the daemon switches it (`/model sonnet`, then `/model haiku`, appear as local-command entries in the transcript, one pair per turn); a fork that is resumed does the same. Harmless: the first prompt of a forked chat goes through `applyChoices` like any turn.
- **No dangling `tool_use` was tested, and none can come from the daemon.** A point is only ever the last message of a turn that ended at it (`end_turn`), so it never ends on a call without a result. A fork at a message that is followed by its own tool call was not tried.
- **Speed.** A fork is 0.6 to 1.2 s with a conversation this small. BB forks large Claude transcripts in a worker because loading one ran out of memory; a long chat was not tried, and `forkTimeoutMs` (2 minutes) bounds the call.
- **The adapter advertises it.** An `initialize` of the pin over v2 (piped by hand, no model call) answers `capabilities.session.fork: {}`, `delete`, `additionalDirectories`, `systemPrompt`, `title` and `options`.

## Codex: not run

```
cd <a scratch folder>
CODEX_PATH=$(which codex) bun x --bun @agentclientprotocol/codex-acp@2.8.0 --version          # warm cache: killed at once, exit 137, no output
CODEX_PATH=$(which codex) BUN_INSTALL_CACHE_DIR=<empty folder> bun x --bun @agentclientprotocol/codex-acp@2.8.0 --version
  error: No version matching "2.8.0" found for specifier "@agentclientprotocol/codex-acp" (blocked by minimum-release-age: 259200 seconds)
bun x --bun @agentclientprotocol/codex-acp@2.7.0 --version                                       # works (two other cached pins, 2.6.0 and 2.7.0, also work)
```

- Through the daemon (`bun fork-check.ts codex <scratch dir>`): both turns failed with `Codex stopped unexpectedly (ACP connection closed)`, 54 to 70 s each, no session, so no point could be stored. The cause is the one above. With a cold cache the failure is the documented one (`INSTALL_BLOCKED` in `failure.ts` matches it); **with the pin already in Bun's cache `bun x` is killed with SIGKILL and says nothing**, which the daemon reports as a crash with no hint of the cause. That is existing behavior, not part of this stage; it is worth a line to the owner (the app tells nobody that the age setting is why).
- The setting was not lowered, no other version was used, and the cached files of 2.8.0 were not run by hand. **`fork` stays off for Codex.** Rerun on or after 2026-11-22 (2.8.0 turns three days old), or the next time the pin is bumped: `bun fork-check.ts codex <scratch dir>` from the appendix. What the Codex check has to show when it runs: that the `messageId` its v2 mapper gives an assistant message is the item id the adapter's `thread/fork` looks up (`SessionFork.ts` reads `item.id`), that the fork keeps the turn through its end, and that the thread of the user's `codex` 0.166.0 honors `lastTurnId`. None of that was observed; the pin's own `initialize` was not either.
- Codex's turns store points as soon as they run (the stamp does not look at the flag), so a chat made while the flag is off is forkable the day it goes on, if the ids prove to be the right ones.

## Appendix: the script (`fork-check.ts`, throwaway, kept in the session scratchpad)

```ts
/**
 * Real check of Stage 3 (message-actions): rewind points and the engine fork against a real agent, through the daemon's own modules, on a scratch
 * data directory and a non-default port. Usage: `bun fork-check.ts <claude|codex> <scratch dir>`.
 *
 *  1. Starts a daemon (own data dir, projects dir, personal dir, port 47311, token) with the real engine registry.
 *  2. Two turns in one chat through `chat.send`: the daemon's run driver stamps each turn's last message.
 *  3. Prints the stored points (`provider_ref`) and the flags the stream carries.
 *  4. `AgentEngine.fork` at turn 1's point and at turn 2's point; each fork is asked a question through the engine's `start` (a resume of the fork).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAEMON = '/Users/bionic/WORK/My/@kachurun/clowdy-message-actions/apps/daemon/src';
const { startDaemon } = await import(`${ DAEMON }/daemon`);
const { loadConfig } = await import(`${ DAEMON }/config`);
const { AgentRegistry } = await import(`${ DAEMON }/engine/acp/registry`);
const { createEngines } = await import(`${ DAEMON }/engine`);
const { installShimOrWarn } = await import(`${ DAEMON }/cli/shim`);
const { executeCommand } = await import(`${ DAEMON }/commands`);
const { streamItems } = await import(`${ DAEMON }/domain/items`);
const { itemRef } = await import(`${ DAEMON }/db/items`);

const agentId = process.argv[2] ?? 'claude';
const scratch = process.argv[3] as string;
const root = mkdtempSync(join(scratch, `real-${ agentId }-`));
const dataDir = join(root, 'data');
const work = join(root, 'work');

mkdirSync(dataDir, { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(join(root, 'skills'), { recursive: true });

const out: string[] = [];
const say = (line: string) => {
    out.push(line);
    console.log(line);
};

const config = loadConfig({
    ...process.env,
    CLOWDY_DATA_DIR: dataDir,
    CLOWDY_PROJECTS_DIR: join(root, 'projects'),
    CLOWDY_PERSONAL_DIR: join(root, 'personal'),
    CLOWDY_PORT: '47311',
    CLOWDY_TOKEN: 'scratch-token',
    CLOWDY_ENGINE: agentId,
    CLOWDY_USER_SKILLS_DIRS: join(root, 'skills'),
    CLOWDY_PROFILE: 'scratch',
});

say(`root ${ root }`);
say(`dataDir ${ config.dataDir }, port ${ config.port }`);

const agents = new AgentRegistry({ dataDir: config.dataDir });
const shim = installShimOrWarn(config.dataDir);
const engines = createEngines(config, agents, process.env, shim);
const daemon = await startDaemon(config, { engines, agents });
const { services } = daemon;
const { store } = services;
let n = 0;
const send = (type: string, fields: Record<string, unknown> = {}) => {
    const result = executeCommand(services, { requestId: `real-${ ++n }`, type, ...fields });

    if (!result.ok) {
        throw new Error(`${ type } failed: ${ result.error.code } ${ result.error.message }`);
    }

    return result.data as any;
};
const waitFor = async (check: () => boolean, what: string, ms = 240_000) => {
    const deadline = Date.now() + ms;

    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out: ${ what }`);
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }
};

try {
    const engine = engines.get(agentId);

    say(`engine ${ agentId }: canFork=${ engine?.canFork }, store.forkable=${ store.forkable(agentId) }`);

    const { project } = send('project.add', { folders: [work] });
    const { chat } = send('chat.create', { projectId: project.id, engine: agentId, ...(agentId === 'claude' && { model: 'haiku' }) });
    const turn = async (text: string, count: number) => {
        const started = Date.now();
        const { runId } = send('chat.send', { chatId: chat.id, text });

        await waitFor(() => services.runs.require(runId).status === 'succeeded' || services.runs.require(runId).status === 'failed', `turn ${ count }`);

        const run = services.runs.require(runId);

        say(`turn ${ count } (${ Math.round((Date.now() - started) / 1000) } s): run ${ run.status }${ run.error ? ` error=${ run.error }` : '' } session=${ run.sessionId } result=${ JSON.stringify(run.result) }`);

        return run;
    };

    await turn('Remember the word PINEAPPLE. Reply OK.', 1);

    const run = services.runs.require((store.db.query('SELECT orchestrator_run_id AS id FROM chats WHERE id = ?').get(chat.id) as { id: string }).id);

    await turn('Run `echo MANGO` in the shell, then reply with the word it printed. Also remember the number 417.', 2);

    const runNow = services.runs.require(run.id);
    const items = streamItems(store, run.id, 0);

    say('--- stream as a client reads it');

    for (const item of items) {
        const body = item.body;

        say(`#${ item.seq } ${ body.kind }${ item.canFork ? ' canFork' : '' }${ item.canEdit ? ' canEdit' : '' } ref=${ itemRef(store.db, run.id, item.seq) ?? '-' } ${ body.kind === 'user' || body.kind === 'assistant' ? JSON.stringify(body.text.slice(0, 80)) : body.kind === 'tool' ? `${ body.name } ${ body.state }` : '' }`);
    }

    const points = items.flatMap(item => ({ seq: item.seq, ref: itemRef(store.db, run.id, item.seq) })).filter(point => point.ref);

    say(`points ${ JSON.stringify(points) }`);

    if (points.length < 2 || !runNow.sessionId) {
        throw new Error('no two points recorded: cannot fork');
    }

    const cwd = work;
    const askIn = async (sessionId: string, prompt: string) => {
        const abort = new AbortController();
        const titles: string[] = [];
        const events: any[] = [];
        const session = (engine as any).start({ cwd, prompt, resumeSessionId: sessionId, tools: [], signal: abort.signal, title: { onTitle: (title: string) => (titles.push(title), true) } });
        const started = Date.now();

        for await (const event of session) {
            events.push(event);

            if (event.type === 'done' || event.type === 'error') {
                break;
            }
        }

        await session.close();

        const said = events.flatMap(event => event.type === 'text' ? [event.delta] : []).join('');
        const usage = events.find(event => event.type === 'usage');
        const sessionEvent = events.find(event => event.type === 'session');

        say(`  asked ${ JSON.stringify(prompt) } in ${ sessionId } (${ Math.round((Date.now() - started) / 1000) } s): events ${ events.map(event => event.type).join(',') }`);
        say(`  said ${ JSON.stringify(said) }; usage ${ JSON.stringify(usage) }; session event ${ sessionEvent?.sessionId }; titles ${ JSON.stringify(titles) }; error ${ JSON.stringify(events.find(event => event.type === 'error')) }`);

        return said;
    };

    const forkAt = async (label: string, ref: string) => {
        const started = Date.now();
        const forked = await (engine as any).fork({ sessionId: runNow.sessionId, ref, cwd });

        say(`fork at ${ label } (${ ref }): new session ${ forked.sessionId } in ${ Date.now() - started } ms`);

        return forked.sessionId as string;
    };
    const question = 'Which word and which number did I ask you to remember? Answer as "<word>, <number>", with "none" for anything I did not ask you to remember.';

    say('--- fork at turn 1 point: the number came only in turn 2');
    await askIn(await forkAt('turn 1', points[0].ref as string), question);

    say('--- fork at turn 2 point: both, and the shell call of turn 2 is in the copy');
    const late = await forkAt('turn 2', points[1].ref as string);

    await askIn(late, question);
    await askIn(await forkAt('turn 2 again', points[1].ref as string), 'What did the shell command print? Answer with the word only.');

    say('--- the source session is untouched');
    await askIn(runNow.sessionId, question);

    writeFileSync(join(root, 'summary.json'), JSON.stringify({ source: runNow.sessionId, points }, null, 2));
}
finally {
    await daemon.stop();
    engines.stop();
    writeFileSync(join(root, 'log.txt'), out.join('\n'));
}
```


---

# Stage 4: `chat.fork` on Claude Code

Stage 4 of `.briefback/message-actions/plan.md`. The question: does `chat.fork` (provider fork first, then the chat, the run holding the copy's session and the copied history) work end to end on the real Claude Code adapter, and do the copy's later turns, a fork of a fork, and a fork made while the source works behave? Date: 2026-11-21 (local). `claude-agent-acp@0.107.0`, the user's `claude` 2.1.312, model `haiku`. Codex was not run (its flag is off). Like Stage 3 it spends the owner's subscription, so it is run by hand.

## Verdict

**Pass.** Everything below worked on the first run, and the one thing the stage had to measure (the first prompt's cost in a fork) came out as expected.

| Check | Observed |
| --- | --- |
| `chat.fork` at turn 1's answer | `ok` in 566 ms (573 ms in a second run). New chat `(1) <source title>`, `forkedFrom { chatId, atSeq: 2 }`, no `parentChatId`, no queue, a run `succeeded` holding the copy's session id (`085b0305-...`, the source's is `66675423-...`) |
| The fork's stream before any message | Turn 1 only: `#1 user canEdit`, `#2 assistant canFork ref=msg_011ChFNqWhqHrLSziur4Mh3N`, the same id the source's item holds (the copy keeps `provider_ref`) |
| The first message of the fork | `Which word and which number did I ask you to remember? Answer as "<word>, <number>", with "none" for anything I did not ask you to remember.` Answer: `PINEAPPLE, none`. The number said only in turn 2 of the source is not in the copy. The message went through the ordinary resume path, 2 s (the daemon sends the bare text: the first-message prefix is made only for a chat that has no orchestrator, which a fork never lacks; not observed on the wire, covered by `test/fork.test.ts`) |
| Title | The source's title was the agent's own name for it (`Clowdy orchestrate autopilot session`), so the fork is `(1) Clowdy orchestrate autopilot session`. After the fork's own turns (two prompts) the title was unchanged |
| Fork of the fork, at an **inherited** answer | `chat.fork` on the fork at its copied answer (`#2`, `msg_011ChFNqWhqHrLSziur4Mh3N`): `ok`, `(2) <title>`, `forkedFrom { chatId: <fork 1>, atSeq: 2 }`; asked the same question, it answered `PINEAPPLE, none`. So a rewind point copied with the items is still a message id of the copied session |
| Fork at an answer the fork wrote **itself** | `chat.fork` on fork 1 at its own `#6` (`msg_011ChFNrN7vwAhxARu7cABjm`, minted by the forked session): `ok`, `forkedFrom { atSeq: 6 }`; the question was answered `PINEAPPLE, none` |
| Fork of the source while a source turn runs | The source turn 3 was `Run \`sleep 20\` in the shell, then reply with the word DONE.`; with the `Bash` call `running` and the run `running`, `chat.fork` at turn 1's answer: `ok` in 617 ms, the source run still `running` after it. The fork's stream held turn 1 only. The source turn then ended `succeeded` with `DONE` and its stream (`#6` user, `#7` Bash done, `#8` assistant `msg_011ChFNthGfcT3Jkaf9NRvZx` canFork) is intact. The fork made meanwhile answered its first message `PINEAPPLE, none` afterwards |
| Cost baseline | See below: the first prompt of a fork reports its own cost as the session's cumulative cost, so the baseline is seeded with 0 where `AcpEngine.fork` returns |

## Setup and commands

Same scratch daemon as Stage 3 (the daemon's own modules in one Bun process, the real `AgentRegistry` and engines): data dir, projects dir and personal dir are folders under the session scratchpad, port `47312` (not the default random one), token `scratch-token`, user skills pointed at an empty folder, `CLOWDY_PROFILE=scratch`. The script (appendix) runs every command through `executeCommandAsync`, as the HTTP route does. The project folder is an empty scratch folder; Claude Code keeps its session files under `~/.claude/projects/<scratch folder>/` (a handful of small files per run; they stay).

```
cd <a scratch folder that holds only the script>
bun fork-chat-check.ts <scratch dir>            # the whole check
QUICK=1 bun fork-chat-check.ts <scratch dir>    # source turns 1 and 2, one fork, one prompt in it: the cost line only
```

Prompts (tiny, as in Stage 3): turn 1 `Remember the word PINEAPPLE. Reply OK.`; turn 2 `Run \`echo MANGO\` in the shell, then reply with the word it printed. Also remember the number 417.`; in the forks the question above, then `Say OK.`; in the busy case `Run \`sleep 20\` in the shell, then reply with the word DONE.`

## The cost of a fork's first prompt

Measured through the engine's own map (`AcpEngine.costs`, the cumulative cost per session id the daemon keeps), on the run before the seed existed (the first prompt of a fork then reported tokens and no `costUsd`):

| Session and prompt | Cumulative cost the adapter reported |
| --- | --- |
| Source, after turn 1 (27.4k input tokens) | 0.0034170 |
| Source, after turn 2 | 0.0041484 (turn 2 own: 0.00073) |
| **Fork 1, first prompt** (27.9k input tokens) | **0.00038672** |
| Fork 1, second prompt (`Say OK.`) | 0.00073694, its own: 0.00035022 |
| Fork 2 (fork of the fork), first prompt | 0.00028602 |
| Fork 3, first prompt | 0.00035923 |

The first prompt of a fork reports about what a second prompt of the same size costs on its own (0.00039 against 0.00035), and nothing like the source's 0.0034 plus its own: the agent counts a copy's cost from zero. So the baseline is 0 for a fork's session id, which is what `session/new` seeds, and `AcpEngine.fork` now sets it where it returns. Rerun with the seed (`QUICK=1`): the first prompt of the fork reported `usage {"inputTokens":27911,"outputTokens":12,"costUsd":0.00037972}`, equal to the cumulative cost measured (0.00037972). `test/acp-fork.test.ts` covers it with the fake agent, and fails without the seed.

### Something this check showed that is not Stage 4's

The adapter's cumulative cost does not reliably survive a resume in a new process. In the first run turn 2 of the source reported a cumulative cost above turn 1's (0.00342, then 0.00415), so the daemon counted turn 2's 0.00073. In the `QUICK` run the same two turns went 0.00339 and then 0.00072: the counter had started again, below the baseline the daemon holds (`costBefore`), and `max(0, cost - costBefore)` dropped that turn's cost to 0 (the run's total stayed at 0.00339246 after turn 2). The cause was not investigated (a guess: Claude Code saves a session's cost when its process exits, and the daemon stops that process, so a resume restores it only when the save won the race), so the cost of a resumed turn is sometimes lost. This is existing behavior for every Claude Code session and is not changed here; it is worth a line to the owner, and a fix would have to compare per process (a baseline of 0 for each new process, or the adapter's per-turn figure) rather than per session id.

## What was not tried

- A fork of a long chat (a few turns of a few tokens each were enough for the question; the speed with a large transcript is as unknown as after Stage 3, `forkTimeoutMs` bounds it).
- A fork at a message whose turn used a sub-agent (the unit tests cover the copy, not the adapter's cut through one).
- Codex.

## Appendix: the script (`fork-chat-check.ts`, throwaway, kept in the session scratchpad)

```ts
/**
 * Real check of Stage 4 (message-actions): `chat.fork` against the real Claude Code adapter, through the daemon's own modules, on a scratch data
 * directory and a non-default port. Usage: `bun fork-chat-check.ts <scratch dir>`.
 *
 *  1. A daemon (own data dir, projects dir, personal dir, port 47312, token) with the real engine registry.
 *  2. A 2-turn Claude Code chat: turn 1 remembers a word, turn 2 runs a shell echo and remembers a number.
 *  3. `chat.fork` at turn 1's answer; the fork's stream holds turn 1 only; a question in the fork (word yes, number no); a second tiny prompt in
 *     the fork, and the cumulative cost the daemon measured for the fork's session after each prompt (the cost baseline question).
 *  4. A fork of the fork at the inherited answer, asked the same question; a fork at the fork's own answer.
 *  5. A fork of the source at turn 1's answer while a turn of the source (a `sleep 20` shell call) is running.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAEMON = '/Users/bionic/WORK/My/@kachurun/clowdy-message-actions/apps/daemon/src';
const { startDaemon } = await import(`${ DAEMON }/daemon`);
const { loadConfig } = await import(`${ DAEMON }/config`);
const { AgentRegistry } = await import(`${ DAEMON }/engine/acp/registry`);
const { createEngines } = await import(`${ DAEMON }/engine`);
const { installShimOrWarn } = await import(`${ DAEMON }/cli/shim`);
const { executeCommandAsync, executeCommand } = await import(`${ DAEMON }/commands`);
const { streamItems } = await import(`${ DAEMON }/domain/items`);
const { itemRef } = await import(`${ DAEMON }/db/items`);

const scratch = process.argv[2] as string;
const root = mkdtempSync(join(scratch, 'real-fork-'));
const dataDir = join(root, 'data');
const work = join(root, 'work');

mkdirSync(dataDir, { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(join(root, 'skills'), { recursive: true });

const out: string[] = [];
const say = (line: string) => {
    out.push(line);
    console.log(line);
};

const config = loadConfig({
    ...process.env,
    CLOWDY_DATA_DIR: dataDir,
    CLOWDY_PROJECTS_DIR: join(root, 'projects'),
    CLOWDY_PERSONAL_DIR: join(root, 'personal'),
    CLOWDY_PORT: '47312',
    CLOWDY_TOKEN: 'scratch-token',
    CLOWDY_ENGINE: 'claude',
    CLOWDY_USER_SKILLS_DIRS: join(root, 'skills'),
    CLOWDY_PROFILE: 'scratch',
});

say(`root ${ root }`);
say(`dataDir ${ config.dataDir }, port ${ config.port }`);

const agents = new AgentRegistry({ dataDir: config.dataDir });
const shim = installShimOrWarn(config.dataDir);
const engines = createEngines(config, agents, process.env, shim);
const daemon = await startDaemon(config, { engines, agents });
const { services } = daemon;
const { store } = services;
const engine = engines.get('claude') as any;
let n = 0;
const run = async (type: string, fields: Record<string, unknown> = {}, expectOk = true) => {
    const result = await executeCommandAsync(services, { requestId: `real-${ ++n }-${ Date.now() }`, type, ...fields } as any);

    if (expectOk && !result.ok) {
        throw new Error(`${ type } failed: ${ result.error.code } ${ result.error.message }`);
    }

    return result as any;
};
const waitFor = async (check: () => boolean, what: string, ms = 240_000) => {
    const deadline = Date.now() + ms;

    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out: ${ what }`);
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }
};
const chatRow = (id: string) => store.db.query('SELECT * FROM chats WHERE id = ?').get(id) as any;
const runOfChat = (chatId: string) => services.runs.require(chatRow(chatId).orchestrator_run_id);
const itemsOfChat = (chatId: string) => streamItems(store, chatRow(chatId).orchestrator_run_id, 0);
const describe = (chatId: string) => itemsOfChat(chatId).map((item) => {
    const body = item.body as any;

    return `#${ item.seq } ${ body.kind }${ item.canFork ? ' canFork' : '' }${ item.canEdit ? ' canEdit' : '' } ref=${ itemRef(store.db, item.runId, item.seq) ?? '-' } ${ body.kind === 'user' || body.kind === 'assistant' ? JSON.stringify(body.text.slice(0, 70)) : body.kind === 'tool' ? `${ body.name } ${ body.state }` : '' }`;
});
const lastAnswer = (chatId: string) => (itemsOfChat(chatId).filter(item => item.body.kind === 'assistant').at(-1)?.body as any)?.text as string | undefined;
const costOf = (sessionId: string | undefined) => (sessionId ? engine.costs.get(sessionId) : undefined) as number | undefined;

async function turn(chatId: string, text: string, label: string) {
    const started = Date.now();
    const { data } = await run('chat.send', { chatId, text });

    await waitFor(() => ['succeeded', 'failed'].includes(services.runs.require(data.runId).status), label);

    const r = services.runs.require(data.runId);

    say(`${ label } (${ Math.round((Date.now() - started) / 1000) } s): run ${ r.status }${ r.error ? ` error=${ r.error }` : '' } session=${ r.sessionId } answer=${ JSON.stringify(lastAnswer(chatId)) } usage=${ JSON.stringify(r.usage) } cumulativeCost(session)=${ costOf(r.sessionId) }`);

    if (r.status !== 'succeeded') {
        throw new Error(`${ label } failed`);
    }

    return r;
}

try {
    say(`engine claude: canFork=${ engine.canFork }, store.forkable=${ store.forkable('claude') }`);

    const { data: added } = await run('project.add', { folders: [work] });
    const project = added.project;
    const { data: created } = await run('chat.create', { projectId: project.id, engine: 'claude', model: 'haiku' });
    const source = created.chat.id as string;

    const r1 = await turn(source, 'Remember the word PINEAPPLE. Reply OK.', 'source turn 1');
    const costAfter1 = costOf(r1.sessionId);
    const r2 = await turn(source, 'Run `echo MANGO` in the shell, then reply with the word it printed. Also remember the number 417.', 'source turn 2');
    const costAfter2 = costOf(r2.sessionId);

    say(`source cumulative cost: after turn 1 ${ costAfter1 }, after turn 2 ${ costAfter2 } (turn 2 own ${ (costAfter2 ?? 0) - (costAfter1 ?? 0) })`);
    say('--- source stream');
    describe(source).forEach(say);

    const answer1 = itemsOfChat(source).find(item => item.canFork);

    if (!answer1) {
        throw new Error('no forkable answer');
    }

    // ---- fork at turn 1's answer
    say(`--- chat.fork at turn 1's answer (#${ answer1.seq })`);

    const started = Date.now();
    const forkResult = await run('chat.fork', { chatId: source, itemId: answer1.id }, false);

    say(`chat.fork -> ${ forkResult.ok ? `ok in ${ Date.now() - started } ms` : `FAILED ${ JSON.stringify(forkResult.error) }` }`);

    if (!forkResult.ok) {
        throw new Error('fork failed');
    }

    const fork1 = forkResult.data.chat;

    say(`new chat: ${ JSON.stringify({ id: fork1.id, title: fork1.title, mode: fork1.mode, engine: fork1.engine, model: fork1.model, forkedFrom: fork1.forkedFrom, parentChatId: fork1.parentChatId, queue: fork1.queue }) }`);

    const forkRun = services.runs.require(fork1.orchestratorRunId);

    say(`fork run: ${ JSON.stringify({ status: forkRun.status, sessionId: forkRun.sessionId, usage: forkRun.usage, rootRunId: forkRun.rootRunId === forkRun.id }) }; source session ${ r1.sessionId }`);
    say('--- fork stream before any message (turn 1 only)');
    describe(fork1.id).forEach(say);

    const QUESTION = 'Which word and which number did I ask you to remember? Answer as "<word>, <number>", with "none" for anything I did not ask you to remember.';
    const f1 = await turn(fork1.id, QUESTION, 'fork 1 prompt 1 (first prompt in a fork)');
    const costF1 = costOf(f1.sessionId);
    const usageF1 = f1.usage;

    if (process.env.QUICK) {
        say(`QUICK: the first prompt of the fork reported usage ${ JSON.stringify(usageF1) } (cumulative cost measured ${ costF1 })`);

        throw new Error('quick check done');
    }

    await turn(fork1.id, 'Say OK.', 'fork 1 prompt 2 (tiny)');

    const costF2 = costOf(f1.sessionId);
    const usageF2 = services.runs.require(fork1.orchestratorRunId).usage;

    say(`fork cost: cumulative after prompt 1 = ${ costF1 }, after prompt 2 = ${ costF2 }, prompt 2 own = ${ (costF2 ?? 0) - (costF1 ?? 0) }; run usage after prompt 1 = ${ JSON.stringify(usageF1) }, after prompt 2 = ${ JSON.stringify(usageF2) }`);
    say('--- fork 1 stream');
    describe(fork1.id).forEach(say);
    say(`title after the fork's messages: ${ JSON.stringify(chatRow(fork1.id).title) } (was ${ JSON.stringify(fork1.title) })`);

    // ---- fork of the fork at the inherited answer
    const inherited = itemsOfChat(fork1.id).find(item => item.canFork && item.seq === answer1.seq);

    say(`--- fork of the fork at the INHERITED answer (#${ inherited?.seq }, ref ${ inherited ? itemRef(store.db, inherited.runId, inherited.seq) : '-' })`);

    const f2Result = await run('chat.fork', { chatId: fork1.id, itemId: inherited?.id }, false);

    say(`chat.fork of the fork -> ${ f2Result.ok ? 'ok' : `FAILED ${ JSON.stringify(f2Result.error) }` }`);

    if (f2Result.ok) {
        const fork2 = f2Result.data.chat;

        say(`fork 2: ${ JSON.stringify({ title: fork2.title, forkedFrom: fork2.forkedFrom }) }`);
        await turn(fork2.id, QUESTION, 'fork 2 (fork of the fork) prompt');

        // ---- fork at the fork's own answer (a message that the forked session wrote itself)
        const own = itemsOfChat(fork1.id).filter(item => item.canFork).at(-1);

        say(`--- fork of fork 1 at ITS OWN answer (#${ own?.seq }, ref ${ own ? itemRef(store.db, own.runId, own.seq) : '-' })`);

        const f3Result = await run('chat.fork', { chatId: fork1.id, itemId: own?.id }, false);

        say(`chat.fork at an answer the fork wrote itself -> ${ f3Result.ok ? 'ok' : `FAILED ${ JSON.stringify(f3Result.error) }` }`);

        if (f3Result.ok) {
            say(`fork 3: ${ JSON.stringify({ title: f3Result.data.chat.title, forkedFrom: f3Result.data.chat.forkedFrom }) }`);
            await turn(f3Result.data.chat.id, QUESTION, 'fork 3 prompt');
        }
    }

    // ---- fork while a turn of the source is running
    say('--- fork of the source at turn 1 while a source turn runs');

    const { data: busy } = await run('chat.send', { chatId: source, text: 'Run `sleep 20` in the shell, then reply with the word DONE.' });

    await waitFor(() => itemsOfChat(source).some(item => item.body.kind === 'tool' && (item.body as any).state === 'running'), 'the sleep call to start');

    const sourceRun = services.runs.require(busy.runId);

    say(`source run while forking: ${ sourceRun.status }`);

    const startedBusy = Date.now();
    const busyFork = await run('chat.fork', { chatId: source, itemId: answer1.id }, false);

    say(`chat.fork while the source runs -> ${ busyFork.ok ? `ok in ${ Date.now() - startedBusy } ms` : `FAILED ${ JSON.stringify(busyFork.error) }` }; source run now ${ services.runs.require(busy.runId).status }`);

    if (busyFork.ok) {
        say('--- the fork made while the source ran');
        describe(busyFork.data.chat.id).forEach(say);
    }

    await waitFor(() => ['succeeded', 'failed'].includes(services.runs.require(busy.runId).status), 'the source turn 3', 120_000);
    say(`source turn 3 ended: ${ services.runs.require(busy.runId).status }, answer ${ JSON.stringify(lastAnswer(source)) }`);
    say('--- source stream at the end');
    describe(source).forEach(say);

    if (busyFork.ok) {
        await turn(busyFork.data.chat.id, QUESTION, 'fork made while the source ran: prompt');
    }
}
finally {
    await daemon.stop();
    engines.stop();
    writeFileSync(join(root, 'log.txt'), out.join('\n'));
    say(`log: ${ join(root, 'log.txt') }`);
}
```


---

# Stage 5: `chat.edit` on Claude Code

Stage 5 of `.briefback/message-actions/plan.md`. The question: does `chat.edit` (provider fork at the point before the edited message, one transaction that cuts the stream and sends the new text on the copy; a fresh session with the first-message prefix for the first message) work end to end on the real Claude Code adapter, and is the cut chat consistent afterwards? Date: 2026-11-21 (local). `claude-agent-acp@0.107.0`, the user's `claude` 2.1.312, model `haiku`. Codex was not run (its flag is off). It spends the owner's subscription, so it is run by hand: nine tiny prompts.

## Verdict

**Pass**, on the first run. The edited chat answered from the cut history in both cases, the stream and the rows are consistent, and a fork made earlier from an answer of the cut part kept working with its own copy.

| Check | Observed |
| --- | --- |
| Source chat | 3 turns (a word, a number, a color), each answered `OK`, one session `e33712d9-...`; items 1 to 6 with `canEdit` on 1, 3 and 5, `canFork` and a stored `msg_...` point on 2, 4 and 6 |
| Fork made **before** the edit, at turn 2's answer (`#4`, part of what the edit cuts) | `ok`, `(1) <title>`, `forkedFrom { atSeq: 4 }`, its own session `a91ee773-...` |
| `chat.edit` of the **second** user message (`#3`: `417` becomes `903`) | `ok` in 579 ms: the agent copied session `e33712d9-...` at turn 1's point `msg_011ChFSjssc2So6YefjyTs3H` in 575 ms, giving `e51e55db-...`; the new turn started with the bare text `Remember the number 903. Reply OK.` and `resumeSessionId=e51e55db-...` (no first-message prefix). The run's session after it is the copy's |
| Transaction events | `stream.truncated { fromSeq: 3, removedRunIds: [] }`, `run.upserted`, `stream.item`, `chat.upserted`, `run.upserted`, in that order |
| Stream after it | `#1 user`, `#2 assistant (point msg_011ChFSjssc2So6YefjyTs3H)`, `#3 user "...903..."` with a **new item id** at the freed number, `#4 assistant (a new point)`; turns 2 and 3 of the old stream are gone. The rows hold points on `#2` and `#4` only; the chat still has its one run (no sub-agent in this check) |
| Question after the edit: `List what I asked you to remember, as "<word>, <number>, <color>"...` | `PINEAPPLE, 903, none`: the word, the **new** number, and neither the old number nor the color |
| The earlier fork, asked the same question after the edit | `PINEAPPLE, 417, none`: its copy is independent and still has turn 2 as it was |
| `chat.edit` of the **first** user message (`#1`: `PINEAPPLE` becomes `BANANA`) | `ok` in 2 ms (no fork: nothing to copy). No `fork` call was made. The new turn started with `Follow clowdy:orchestrate. Mode: autopilot` + blank line + `Remember the word BANANA. Reply OK.` and `resumeSessionId=undefined`; a fresh session `58dd8610-...` replaced `e51e55db-...`. Stream: `#1 user (BANANA)`, `#2 assistant`, nothing else |
| Question after it | `BANANA, none, none`: only the new text is known |
| The earlier fork once more, after both edits | `PINEAPPLE, 417, none` |
| Title | The chat's title was the agent's own name for it, so it was left alone by the first-message edit (the rule retitles only a chat still named for the first words of its first message; covered by `test/edit.test.ts`) |

## Setup and commands

Same scratch daemon as Stages 3 and 4 (the daemon's own modules in one Bun process, the real `AgentRegistry` and engines): data dir, projects dir and personal dir are folders under the session scratchpad, port `47313` (not the default random one), token `scratch-token`, user skills pointed at an empty folder, `CLOWDY_PROFILE=scratch`. The script (appendix) runs every command through `executeCommandAsync`, as the HTTP route does, and wraps `engine.start` and `engine.fork` to log what the daemon asks of the agent (prompt, resumed session, fork point). The project folder is an empty scratch folder; Claude Code keeps its session files under `~/.claude/projects/<scratch folder>/` (a handful of small files; they stay).

```
cd <a scratch folder that holds only the script>
bun edit-chat-check.ts <scratch dir>
```

Prompts: turn 1 `Remember the word PINEAPPLE. Reply OK.`; turn 2 `Remember the number 417. Reply OK.`; turn 3 `Remember the color TEAL. Reply OK.`; the edit of message 2 `Remember the number 903. Reply OK.`; the edit of message 1 `Remember the word BANANA. Reply OK.`; the question `List what I asked you to remember, as "<word>, <number>, <color>", using "none" for anything I did not ask you to remember. Answer with that line only.`

## What was not tried

- An edit of a message whose dropped part used a sub-agent or files (the unit tests cover the cut of child runs and files, not the adapter).
- An edit after the agent's own compact turn (the flag rules say it is not offered).
- An edit of a long chat (the fork time with a large transcript is as unknown as after Stage 3; `forkTimeoutMs` bounds it).
- Codex.

## Appendix: the script (`edit-chat-check.ts`, throwaway, kept in the session scratchpad)

```ts
/**
 * Real check of Stage 5 (message-actions): `chat.edit` against the real Claude Code adapter, through the daemon's own modules, on a scratch data
 * directory and a non-default port. Usage: `bun edit-chat-check.ts <scratch dir>`.
 *
 *  1. A daemon (own data dir, projects dir, personal dir, port 47313, token) with the real engine registry.
 *  2. A 3-turn Claude Code chat: a word, a number, a color (tiny prompts).
 *  3. A fork of the source at turn 2's answer (a message that the edit will cut away), made before the edit.
 *  4. `chat.edit` of the SECOND user message (another number); then a question: the answer must know the word and the new number, and neither the old number nor the color.
 *  5. The stream and the daemon's rows after it; the earlier fork asked the same question (independent copy).
 *  6. `chat.edit` of the FIRST user message (a fresh session with the first-message prefix); a question: only the new word is known.
 *  7. The earlier fork once more after both edits.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAEMON = '/Users/bionic/WORK/My/@kachurun/clowdy-message-actions/apps/daemon/src';
const { startDaemon } = await import(`${ DAEMON }/daemon`);
const { loadConfig } = await import(`${ DAEMON }/config`);
const { AgentRegistry } = await import(`${ DAEMON }/engine/acp/registry`);
const { createEngines } = await import(`${ DAEMON }/engine`);
const { installShimOrWarn } = await import(`${ DAEMON }/cli/shim`);
const { executeCommandAsync } = await import(`${ DAEMON }/commands`);
const { streamItems } = await import(`${ DAEMON }/domain/items`);
const { itemRef } = await import(`${ DAEMON }/db/items`);

const scratch = process.argv[2] as string;
const root = mkdtempSync(join(scratch, 'real-edit-'));
const dataDir = join(root, 'data');
const work = join(root, 'work');

mkdirSync(dataDir, { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(join(root, 'skills'), { recursive: true });

const out: string[] = [];
const say = (line: string) => {
    out.push(line);
    console.log(line);
};

const config = loadConfig({
    ...process.env,
    CLOWDY_DATA_DIR: dataDir,
    CLOWDY_PROJECTS_DIR: join(root, 'projects'),
    CLOWDY_PERSONAL_DIR: join(root, 'personal'),
    CLOWDY_PORT: '47313',
    CLOWDY_TOKEN: 'scratch-token',
    CLOWDY_ENGINE: 'claude',
    CLOWDY_USER_SKILLS_DIRS: join(root, 'skills'),
    CLOWDY_PROFILE: 'scratch',
});

say(`root ${ root }`);
say(`dataDir ${ config.dataDir }, port ${ config.port }`);

const agents = new AgentRegistry({ dataDir: config.dataDir });
const shim = installShimOrWarn(config.dataDir);
const engines = createEngines(config, agents, process.env, shim);
const daemon = await startDaemon(config, { engines, agents });
const { services } = daemon;
const { store } = services;
const engine = engines.get('claude') as any;

// What the engine is asked for, as the daemon asks it: the turns (prompt and resumed session) and the forks (session and point).
const asked: string[] = [];
const start = engine.start.bind(engine);
const fork = engine.fork.bind(engine);

engine.start = (options: any) => {
    asked.push(`start prompt=${ JSON.stringify(String(options.prompt).slice(0, 70)) } resumeSessionId=${ options.resumeSessionId }`);

    return start(options);
};
engine.fork = async (options: any) => {
    const started = Date.now();
    const result = await fork(options);

    asked.push(`fork sessionId=${ options.sessionId } ref=${ options.ref } -> ${ result.sessionId } (${ Date.now() - started } ms)`);

    return result;
};

let n = 0;
const run = async (type: string, fields: Record<string, unknown> = {}, expectOk = true) => {
    const result = await executeCommandAsync(services, { requestId: `real-${ ++n }-${ Date.now() }`, type, ...fields } as any);

    if (expectOk && !result.ok) {
        throw new Error(`${ type } failed: ${ result.error.code } ${ result.error.message }`);
    }

    return result as any;
};
const waitFor = async (check: () => boolean, what: string, ms = 240_000) => {
    const deadline = Date.now() + ms;

    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out: ${ what }`);
        }

        await new Promise(resolve => setTimeout(resolve, 250));
    }
};
const chatRow = (id: string) => store.db.query('SELECT * FROM chats WHERE id = ?').get(id) as any;
const runIdOf = (chatId: string) => chatRow(chatId).orchestrator_run_id as string;
const itemsOfChat = (chatId: string) => streamItems(store, runIdOf(chatId), 0);
const describe = (chatId: string) => itemsOfChat(chatId).map((item) => {
    const body = item.body as any;

    return `#${ item.seq } ${ item.id } ${ body.kind }${ item.canFork ? ' canFork' : '' }${ item.canEdit ? ' canEdit' : '' } ref=${ itemRef(store.db, item.runId, item.seq) ?? '-' } ${ body.kind === 'user' || body.kind === 'assistant' ? JSON.stringify(body.text.slice(0, 90)) : body.kind === 'tool' ? `${ body.name } ${ body.state }` : '' }`;
});
const lastAnswer = (chatId: string) => (itemsOfChat(chatId).filter(item => item.body.kind === 'assistant').at(-1)?.body as any)?.text as string | undefined;
const rest = (runId: string) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(services.runs.require(runId).status);

async function turn(chatId: string, text: string, label: string) {
    const started = Date.now();
    const { data } = await run('chat.send', { chatId, text });

    await waitFor(() => rest(data.runId), label);

    const r = services.runs.require(data.runId);

    say(`${ label } (${ Math.round((Date.now() - started) / 1000) } s): run ${ r.status }${ r.error ? ` error=${ r.error }` : '' } session=${ r.sessionId } answer=${ JSON.stringify(lastAnswer(chatId)) }`);

    if (r.status !== 'succeeded') {
        throw new Error(`${ label } failed`);
    }

    return r;
}

/** An edit as the app sends it, then wait for the turn it starts. */
async function edit(chatId: string, itemId: string, text: string, label: string) {
    const started = Date.now();
    const cursor = store.headCursor();
    const result = await run('chat.edit', { chatId, itemId, text }, false);

    say(`${ label }: chat.edit -> ${ result.ok ? `ok in ${ Date.now() - started } ms` : `FAILED ${ JSON.stringify(result.error) }` }`);

    if (!result.ok) {
        throw new Error(`${ label } failed`);
    }

    const events = store.eventsAfter(cursor, undefined, 1000).map(event => event.data as any);

    say(`  events of the edit's transaction (first five): ${ events.slice(0, 5).map(data => data.type === 'stream.truncated' ? `stream.truncated ${ JSON.stringify({ fromSeq: data.fromSeq, removedRunIds: data.removedRunIds }) }` : data.type).join(', ') }`);

    await waitFor(() => rest(result.data.runId) && services.runs.require(result.data.runId).status === 'succeeded' && lastAnswer(chatId) !== undefined && !itemsOfChat(chatId).some(item => (item.body as any).kind === 'assistant' && (item.body as any).done === false), `${ label }: the new turn`);

    const r = services.runs.require(result.data.runId);

    say(`  the new turn: run ${ r.status } session=${ r.sessionId } answer=${ JSON.stringify(lastAnswer(chatId)) }`);

    return r;
}

const QUESTION = 'List what I asked you to remember, as "<word>, <number>, <color>", using "none" for anything I did not ask you to remember. Answer with that line only.';

try {
    say(`engine claude: canFork=${ engine.canFork }, store.forkable=${ store.forkable('claude') }`);

    const { data: added } = await run('project.add', { folders: [work] });
    const { data: created } = await run('chat.create', { projectId: added.project.id, engine: 'claude', model: 'haiku' });
    const source = created.chat.id as string;

    const r1 = await turn(source, 'Remember the word PINEAPPLE. Reply OK.', 'source turn 1 (word)');

    await turn(source, 'Remember the number 417. Reply OK.', 'source turn 2 (number)');
    await turn(source, 'Remember the color TEAL. Reply OK.', 'source turn 3 (color)');

    say('--- source stream before any edit');
    describe(source).forEach(say);

    const before = itemsOfChat(source);
    const answer2 = before.filter(item => item.canFork)[1];
    const message2 = before.filter(item => item.canEdit)[1];

    say(`source session before the edits: ${ services.runs.require(runIdOf(source)).sessionId } (turn 1's: ${ r1.sessionId })`);

    // ---- a fork made from an answer of the part the edit will cut away
    say(`--- chat.fork at turn 2's answer (#${ answer2.seq }), the part that the edit of message #${ message2.seq } will cut`);

    const forkResult = await run('chat.fork', { chatId: source, itemId: answer2.id });
    const earlier = forkResult.data.chat;

    say(`fork made before the edit: ${ JSON.stringify({ id: earlier.id, title: earlier.title, forkedFrom: earlier.forkedFrom }) }, session ${ services.runs.require(earlier.orchestratorRunId).sessionId }`);

    // ---- edit of the second message
    say(`--- chat.edit of the SECOND user message (#${ message2.seq }): 417 becomes 903`);

    const asking = asked.length;
    const r2 = await edit(source, message2.id, 'Remember the number 903. Reply OK.', 'edit 2');

    say('  engine calls of the edit:');
    asked.slice(asking).forEach(line => say(`    ${ line }`));
    say(`  session of the run after the edit: ${ r2.sessionId } (the fork's, not the original)`);
    say('--- source stream after the edit of message 2');
    describe(source).forEach(say);

    const afterRows = store.db.query('SELECT seq, provider_ref FROM stream_items WHERE run_id = ? ORDER BY seq').all(runIdOf(source)) as any[];

    say(`rows: ${ afterRows.map(row => `#${ row.seq }:${ row.provider_ref ? 'point' : '-' }`).join(' ') }; runs of the chat: ${ (store.db.query('SELECT COUNT(*) AS n FROM runs WHERE chat_id = ? OR root_run_id = ?').get(source, runIdOf(source)) as any).n }`);

    await turn(source, QUESTION, 'source question after edit 2 (expect PINEAPPLE, 903, none)');
    say('--- the earlier fork, asked the same question (expect PINEAPPLE, 417, none)');
    await turn(earlier.id, QUESTION, 'earlier fork question');

    // ---- edit of the first message
    const firstNow = itemsOfChat(source).find(item => item.canEdit && item.seq === 1);

    say(`--- chat.edit of the FIRST user message (#${ firstNow?.seq }): PINEAPPLE becomes BANANA`);

    const asking2 = asked.length;
    const sessionBefore = services.runs.require(runIdOf(source)).sessionId;
    const r3 = await edit(source, firstNow?.id as string, 'Remember the word BANANA. Reply OK.', 'edit 1');

    say('  engine calls of the edit:');
    asked.slice(asking2).forEach(line => say(`    ${ line }`));
    say(`  session of the run after the edit: ${ r3.sessionId } (before: ${ sessionBefore }); title ${ JSON.stringify(chatRow(source).title) }`);
    say('--- source stream after the edit of message 1');
    describe(source).forEach(say);
    await turn(source, QUESTION, 'source question after edit 1 (expect BANANA, none, none)');

    say('--- the earlier fork once more, after both edits (expect PINEAPPLE, 417, none)');
    await turn(earlier.id, QUESTION, 'earlier fork question, again');
    say('--- engine calls, all');
    asked.forEach(line => say(`  ${ line }`));
}
finally {
    await daemon.stop();
    engines.stop();
    writeFileSync(join(root, 'log.txt'), out.join('\n'));
    say(`log: ${ join(root, 'log.txt') }`);
}
```
