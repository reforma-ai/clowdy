type Env = Record<string, string | undefined>;

/**
 * Variables an agent never inherits from the daemon. The daemon's own settings and secrets (`CLOWDY_TOKEN`, an API key
 * meant for something else), markers of the app or terminal that started it (`ELECTRON_RUN_AS_NODE` would make a
 * Node-based agent run as Electron, `CLAUDECODE` makes a nested Claude Code behave as a sub-session), and Node flags aimed at the daemon.
 */
const NEVER = [
    /^CLOWDY_/i,
    /^ELECTRON_/i,
    /^NODE_OPTIONS$/i,
    /^CLAUDECODE$/i,
    /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|EXECPATH)$/i,
    /^CLAUDE_AGENT_SDK_/i,
];

export interface AgentEnvInput {
    /** The daemon's own environment. */
    daemonEnv: Env;
    /** The search path the agent gets: the login shell's, so what the user installed is found. */
    path: string;
    /** Variables that must not reach this agent: its provider's keys, so billing never silently leaves the login. */
    scrub?: RegExp[];
    /** Variables the agent is always started with, after the rest. */
    set?: Record<string, string>;
}

/**
 * The environment of an agent process: the user's own (home folder, keychain access, proxies, the agent's own config
 * variables all pass, because the point is to use what the user has installed and logged in), minus the daemon's secrets.
 */
export function buildAgentEnv({ daemonEnv, path, scrub = [], set = {} }: AgentEnvInput): Record<string, string> {
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(daemonEnv)) {
        if (value === undefined || /^path$/i.test(name) || NEVER.some(pattern => pattern.test(name)) || scrub.some(pattern => pattern.test(name))) {
            continue;
        }

        env[name] = value;
    }

    env.PATH = path;

    return { ...env, ...set };
}
