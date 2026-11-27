import { delimiter } from 'node:path';

import { inheritedEnv } from '../../process/env';

import type { Shim } from '../../cli/shim';
import type { CliAccess } from './bridge';

type Env = Record<string, string | undefined>;

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
    const env = Object.fromEntries(
        Object.entries(inheritedEnv(daemonEnv)).filter(
            ([name]) => !/^path$/i.test(name) && !scrub.some(pattern => pattern.test(name))
        )
    );

    return { ...env, PATH: path, ...set };
}

/**
 * The environment of an agent process whose session has shell commands (`clowdy`, see `cli/clowdy.ts`), after `buildAgentEnv`: where the CLI reaches
 * the daemon, the session's credential, the command's absolute path, and its folder first on `PATH`. The names carry no `KEY`, `TOKEN` or `SECRET`,
 * which Codex's default filter of a shell command's environment drops. Without commands or without a shim the environment stays as it is.
 */
export function withCli(
    env: Record<string, string>,
    cli: CliAccess | undefined,
    shim: Shim | undefined
): Record<string, string> {
    if (!cli || !shim) {
        return env;
    }

    return {
        ...env,
        CLOWDY_CLI_URL: cli.url,
        CLOWDY_CLI_AUTH: cli.auth,
        CLOWDY_CLI: shim.command,
        PATH: env.PATH ? `${shim.dir}${delimiter}${env.PATH}` : shim.dir,
    };
}
