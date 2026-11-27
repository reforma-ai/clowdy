import { NEVER_INHERITED } from '../engine/acp/env';

type Env = Record<string, string | undefined>;

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
