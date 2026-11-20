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

const chatTitleSetting = (agent: string): AgentSettingSpec => ({
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
}

/**
 * The agents Clowdy knows how to start. Most run their own program in ACP mode; Claude Code and Codex have no ACP mode of
 * their own and run through the official adapters, pinned here (read the adapter's changelog before bumping it). Pin a
 * version at least three days old: `bun x` reads the `bunfig.toml` of the folder the run works in, and this repository's
 * `minimumReleaseAge` refuses anything newer ("No version matching ... blocked by minimum-release-age"), which ends the
 * run before the agent starts. `npm view <package> time` shows when each version was published.
 */
export const KNOWN_AGENTS: readonly AgentSpec[] = [
    {
        id: 'claude',
        name: 'Claude Code',
        programs: ['claude'],
        launch: { kind: 'package', package: '@agentclientprotocol/claude-agent-acp@0.107.0', pathEnv: 'CLAUDE_CODE_EXECUTABLE' },
        // ACP v2: background commands, sub-agents and workflows are told as `state_update`s, and the agent's own turns come on the same session.
        protocol: 'v2',
        compact: '/compact',
        // Sub-agents are a feature, this only caps hidden fan-out. The rest of what a run does not do by default (claude.ai
        // connectors, the agent's own memory) is a setting below, off until the person turns it on. Without the last variable
        // Claude Code reads no CLAUDE.md in the project's other folders, which reach it as additional directories.
        env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20', CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
        settings: [
            {
                id: 'memory',
                label: 'Memory',
                description: 'Let Claude Code read and write its own auto-memory in your runs',
                default: false,
                effect: on => ({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: on ? null : '1' } }),
            },
            {
                id: 'connectors',
                label: 'claude.ai connectors',
                description: 'Load the connectors set up on claude.ai (Drive, Docs and the like) into every run',
                default: false,
                effect: on => ({ env: { ENABLE_CLAUDEAI_MCP_SERVERS: on ? null : 'false' } }),
            },
            {
                id: 'subagents',
                label: 'Enable sub-agents',
                description: 'Let Claude Code start sub-agents inside a run. Off hides them, so agents delegate through Clowdy only.',
                default: true,
                effect: on => on ? {} : { disallowedTools: ['Agent', 'Task', 'ListAgents'] },
            },
            {
                id: 'workflows',
                label: 'Enable workflow tool',
                description: 'Let Claude Code run its Workflow tool, which fans one job out to many sub-agents and can use a lot of your plan. Off hides it, so agents delegate through Clowdy only.',
                default: true,
                effect: on => on ? {} : { disallowedTools: ['Workflow'] },
            },
            {
                id: 'longContext',
                label: '1M-token context',
                description: 'Use the 1M-token context window where the plan has one',
                default: true,
                effect: on => ({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: on ? null : '1' } }),
            },
            {
                // Stated both ways: Claude Code reads `0` as off (`artifact_env_off`), and a variable the person's own shell sets does not turn it on in a run that has it off.
                id: 'artifacts',
                label: 'Claude Artifacts',
                description: 'Let Claude Code publish pages such as reports and dashboards to your claude.ai account. They stay private until you share them, and Claude can publish without asking. Needs a claude.ai login on this machine.',
                default: false,
                effect: on => ({ env: { CLAUDE_CODE_ARTIFACT: on ? '1' : '0' } }),
            },
            chatTitleSetting('Claude Code'),
        ],
        // A stray key in the daemon's environment would move billing off the user's subscription; a key the user wants goes in the agent's `env`.
        scrub: [/^ANTHROPIC_API_KEY$/, /^ANTHROPIC_AUTH_TOKEN$/, /^CLAUDE_CODE_OAUTH_TOKEN$/],
        login: 'claude auth login',
        // Tools that wait for a terminal and would hang a run nobody is watching.
        sessionMeta: { claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'] } } },
    },
    {
        id: 'codex',
        name: 'Codex',
        programs: ['codex'],
        launch: { kind: 'package', package: '@agentclientprotocol/codex-acp@2.6.0', pathEnv: 'CODEX_PATH' },
        // ACP v1 for now: its adapter injects a steer into the running turn through `_session/steering`, while a plain prompt on v2 is held until the turn
        // ends. `codex-acp` 2.8.0 reports background commands and sub-agents on v2 and takes `_session/steering` there too: Stage 10 of the background-work
        // plan moves Codex to v2 once the layer steers that way and the pin can be raised.
        compact: '/compact',
        settings: [
            {
                // Codex's memories are a feature that is off until the person turns it on, so "on" has to turn the feature on too; "off" is also stated, so a feature the person turned on in their own Codex does not reach Clowdy's runs.
                id: 'memory',
                label: 'Memory',
                description: 'Let Codex recall its memories and save new ones from your runs',
                default: false,
                effect: on => ({ codexConfig: { 'features.memories': on, 'memories.use_memories': on, 'memories.generate_memories': on } }),
            },
            {
                // The keys of Codex 0.145 and newer (the adapter pins 0.166); an older Codex names them differently.
                id: 'subagents',
                label: 'Enable sub-agents',
                description: 'Let Codex start sub-agents inside a run. Off turns them off, so agents delegate through Clowdy only.',
                default: true,
                effect: on => on ? {} : { codexConfig: { 'agents.enabled': false, 'features.multi_agent_v2': false } },
            },
            chatTitleSetting('Codex'),
        ],
        scrub: [/^OPENAI_API_KEY$/, /^CODEX_API_KEY$/],
        login: 'codex login',
    },
    {
        id: 'cursor',
        name: 'Cursor',
        programs: ['cursor-agent', 'agent'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'cursor-agent login',
        // Verified on macOS only: the login is in the keychain, so it follows the person into the folder; the model every new process starts on and
        // the session history stay in it (research/cursor-isolation.md). On Windows and Linux the credential file is built from other variables, so the
        // login should survive too, but nobody has run it: a run there keeps the person's own folder (and its default model) until somebody does.
        isolation: { env: 'CURSOR_CONFIG_DIR', dir: 'cursor', platforms: ['darwin'] },
        clientMeta: { parameterizedModelPicker: true },
    },
    {
        id: 'opencode',
        name: 'OpenCode',
        programs: ['opencode'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'opencode auth login',
    },
    {
        id: 'gemini',
        name: 'Gemini CLI',
        programs: ['gemini'],
        launch: { kind: 'binary', args: ['--acp'] },
        login: 'gemini',
    },
    {
        id: 'copilot',
        name: 'GitHub Copilot CLI',
        programs: ['copilot'],
        launch: { kind: 'binary', args: ['--acp'] },
    },
    {
        id: 'grok',
        name: 'Grok Build',
        programs: ['grok'],
        launch: { kind: 'binary', args: ['agent', 'stdio'] },
    },
    {
        id: 'omp',
        name: 'omp',
        programs: ['omp'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'omp login',
    },
    {
        id: 'hermes',
        name: 'Hermes Agent',
        programs: ['hermes'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'hermes login',
    },
];

/** An agent the user added: any command that speaks ACP on stdio. */
export interface CustomAgent {
    id: string;
    name: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
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
