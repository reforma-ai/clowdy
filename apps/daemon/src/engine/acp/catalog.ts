/** How an agent is started over ACP. */
export type Launch =
    /** The agent's own program speaks ACP when given these arguments (`cursor-agent acp`). */
    | { kind: 'binary'; args: string[] }
    /**
     * An adapter package wraps the agent. It is fetched on first use by `bun x --bun` (the daemon's own Bun; no Node is needed); `pathEnv` is the variable that points it at
     * the user's own installed program, so the adapter's bundled copy of the agent is neither downloaded nor used.
     */
    | { kind: 'package'; package: string; pathEnv: string };

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
}

/**
 * The agents Clowdy knows how to start. Most run their own program in ACP mode; Claude Code and Codex have no ACP mode of
 * their own and run through the official adapters, pinned here (read the adapter's changelog before bumping it).
 */
export const KNOWN_AGENTS: readonly AgentSpec[] = [
    {
        id: 'claude',
        name: 'Claude Code',
        programs: ['claude'],
        launch: { kind: 'package', package: '@agentclientprotocol/claude-agent-acp@0.108.0', pathEnv: 'CLAUDE_CODE_EXECUTABLE' },
        // The user's claude.ai connectors (Drive, Docs) would load into every run, and an orchestrated run must not write the
        // user's memory; sub-agents are a feature, this only caps hidden fan-out. All of it can be undone with the agent's `env`.
        env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20' },
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
        launch: { kind: 'package', package: '@agentclientprotocol/codex-acp@2.7.0', pathEnv: 'CODEX_PATH' },
        scrub: [/^OPENAI_API_KEY$/, /^CODEX_API_KEY$/],
        login: 'codex login',
    },
    {
        id: 'cursor',
        name: 'Cursor',
        programs: ['cursor-agent', 'agent'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'cursor-agent login',
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
}

export const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
