type Env = Record<string, string | undefined>;

/**
 * Variables no program the daemon starts inherits from it (`inheritedEnv`). The daemon's own settings and secrets (`CLOWDY_TOKEN`, an API key
 * meant for something else), markers of the app or terminal that started it (`ELECTRON_RUN_AS_NODE` would make a
 * Node-based agent run as Electron, `CLAUDECODE` makes a nested Claude Code behave as a sub-session), and Node flags aimed at the daemon.
 */
export const NEVER_INHERITED = [
    /^CLOWDY_/i,
    /^ELECTRON_/i,
    /^NODE_OPTIONS$/i,
    /^CLAUDECODE$/i,
    /^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|EXECPATH)$/i,
    /^CLAUDE_AGENT_SDK_/i,
];

/**
 * The environment a program the daemon starts inherits: `env` (the daemon's own by default) without what is unset and without what the daemon keeps to itself
 * (`NEVER_INHERITED`: its settings and token, the markers of the app that started it, Node flags aimed at the daemon). Every spawn of a program that is not the daemon's
 * own starts from it: an agent, a terminal's shell, git and the hooks and filters it runs, ripgrep.
 */
export function inheritedEnv(env: Env = process.env): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined && !NEVER_INHERITED.some(pattern => pattern.test(name))) {
            result[name] = value;
        }
    }

    return result;
}
