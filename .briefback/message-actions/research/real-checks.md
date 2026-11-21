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
