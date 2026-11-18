/** How an agent is started over ACP. */
export type Launch =
    /**
     * Not ACP: the agent has an engine of its own that drives it directly (Claude Code through the Claude Agent SDK, which
     * exposes sub-agents, quota signals and mid-turn messages that no ACP agent reports). The registry only finds the program.
     */
    | { kind: 'native' }
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
}

/**
 * The agents Clowdy knows how to start. ACP agents run their own program; Codex has no ACP mode of its own and runs
 * through the official adapter, pinned here (read its changelog before bumping it). Claude Code has its own engine.
 */
export const KNOWN_AGENTS: readonly AgentSpec[] = [
    {
        id: 'claude',
        name: 'Claude Code',
        programs: ['claude'],
        launch: { kind: 'native' },
        login: 'claude auth login',
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
