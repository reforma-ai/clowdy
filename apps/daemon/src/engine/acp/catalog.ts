/** How an agent is started over ACP. */
export type Launch =
    /** The agent's own program speaks ACP when given these arguments (`cursor-agent acp`). */
    | { kind: 'binary'; args: string[] }
    /**
     * An adapter package wraps the agent. It is fetched on first use by `bun x --bun` (the daemon's own Bun; no Node is needed); `pathEnv` is the variable that points it at
     * the user's own installed program, so the adapter's bundled copy of the agent is neither downloaded nor used.
     */
    | { kind: 'package'; package: string; pathEnv: string };

/** What the agent is started with for one value of a setting. A variable that is `null` is taken out of the environment. */
export interface SettingEffect {
    env?: Record<string, string | null>;
    /** Tools the agent is not given (Claude's adapter reads them from `_meta.claudeCode.options.disallowedTools`). */
    disallowedTools?: string[];
    /** Codex config keys (dotted, as in `-c key=value`) for the session. They reach Codex's adapter in `CODEX_CONFIG`, one JSON object that every setting adds its keys to. */
    codexConfig?: Record<string, boolean | number | string>;
}

/** A switch of an agent that Clowdy can turn by itself: it changes the environment or the session options the agent starts with, or is read by the daemon alone. */
export interface AgentSettingSpec {
    id: string;
    label: string;
    description: string;
    default: boolean;
    /** What the agent is started with for a value; absent for a switch only the daemon reads (it does nothing to the agent). */
    effect?: (on: boolean) => SettingEffect;
}

/**
 * The switch of an agent that names a chat after its first message by itself (Claude Code and Codex send the name as `session_info_update`). An agent without it
 * is not known to name a chat well, and a chat of it keeps the first words of its first message. Off, the first words are the name the agent is told to keep.
 */
export const CHAT_TITLE_SETTING = 'chatTitle';

export const chatTitleSetting = (agent: string): AgentSettingSpec => ({
    id: CHAT_TITLE_SETTING,
    label: 'Chat titles',
    description: `Let ${ agent } name a new chat from its first message`,
    default: true,
});

/** The ACP version a layer of the engine speaks to an agent (`layer.ts`). */
export type AgentProtocol = 'v1' | 'v2';

/** A built-in agent: what finds it, how it starts, and what to tell the user about it. */
export interface AgentSpec {
    id: string;
    name: string;
    /** Program names that show the agent is installed; the first one found wins. */
    programs: string[];
    launch: Launch;
    /** Variables the agent is always started with. */
    env?: Record<string, string>;
    /** Variables it must not inherit: its provider's keys, so billing does not silently leave the user's login. */
    scrub?: RegExp[];
    /** What a person runs in a terminal to sign in. */
    login?: string;
    /** Sent as the `_meta` of `session/new`: options the agent's adapter reads (Claude's adapter takes SDK options under `claudeCode.options`). */
    sessionMeta?: Record<string, unknown>;
    /** The agent's own switches, shown with its account. */
    settings?: AgentSettingSpec[];
    /**
     * A folder of its own for what the agent keeps between runs (its settings, its session history and, for Cursor, the model every later process
     * starts on): `env` is the variable that moves it, `dir` its name under the daemon's data folder, `platforms` where moving it is verified to
     * leave the login alone (anywhere else the agent runs in the person's own folder, as before). Choosing a model for a run changes that default,
     * so without this a run of Clowdy would change the person's own agent. Only runs use it: reads of the account and the sign-in are the person's own.
     */
    isolation?: { env: string; dir: string; platforms: NodeJS.Platform[] };
    /** The `_meta` of the client capabilities in `initialize`: what this agent needs to hear to offer its full options (Cursor lists a model's effort only to a client that says it can show one). */
    clientMeta?: Record<string, unknown>;
    /** The message that makes the agent compact its conversation (verified: both report it as a "Compact conversation" tool call and a smaller context). Absent when it has none. */
    compact?: string;
    /** The ACP version the engine speaks to the agent: `v1` unless set. */
    protocol?: AgentProtocol;
    /**
     * The agent starts no turn of its own to report background work that ended (a command or a sub-agent): its app-server has nothing that wakes a thread
     * when one ends, so the model would never learn of it and its run would end with the work unreported. Set, the runtime tells the agent: when the last
     * item has left the background list and the session is idle, it sends one note through `send` ("Background command finished: ...") and the agent
     * reports in a turn of that note's own, and the layer does not wait `BACKGROUND_REPORT_MS` for a report that never comes. Unset for an agent that
     * reports by itself (Claude Code starts a report turn). Only means something for an agent whose protocol reports background work (`v2`).
     */
    wakesOnBackgroundEnd?: boolean;
    /**
     * The app may offer Fork and Edit for chats of this agent: its adapter copies a session at a message through `session/fork` with the fork point in
     * `_meta.jetbrains.air.fork` (`{ version: 1, messageId }`, a vendor extension of both pinned adapters, read from any client; `session/fork` itself is an
     * unstable method of the draft protocol), and it tells the message ids a point is made of (ACP v2). Set only after a real check against the pinned
     * adapter (`.briefback/message-actions/research/real-checks.md`), and rerun it on every bump of the pin: a bump can break the extension, and the flag
     * goes off when it does. Unset for every agent that has no such fork, which has neither action.
     */
    fork?: boolean;
    /**
     * How the agent reaches the task tools: `cli` (the default) gives it `clowdy task get|list|create|update` in its shell, like the thread commands; `mcp` names them
     * in the MCP server of its session instead. Both run the same tool through the tool bridge, so the choice is only about which door an agent can use: set `mcp`
     * only after a real check shows that the shell route fails for the agent or needs a person's approval on every call (`.briefback/task-cli/research/real-agents.md`).
     */
    taskTools?: TaskChannel;
}

/** The two doors to the runtime's task tools (`AgentSpec.taskTools`). */
export type TaskChannel = 'cli' | 'mcp';

/** An agent the user added: any command that speaks ACP on stdio. */
export interface CustomAgent {
    id: string;
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
    /** The door to the task tools (`AgentSpec.taskTools`), written in `agents.json` by a person whose agent cannot use the shell route; the shell when absent. */
    taskTools?: TaskChannel;
}

/** What the user changed about an agent, built-in or custom. */
export interface AgentOverride {
    enabled?: boolean;
    /** Use this program instead of looking for one. */
    path?: string;
    /** Variables to start the agent with, after its own. */
    env?: Record<string, string>;
    /** The values the person chose for the agent's settings (`AgentSettingSpec.id`); one not named has its default. */
    settings?: Record<string, boolean>;
}

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
