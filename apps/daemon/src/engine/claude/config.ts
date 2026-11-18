import { fileURLToPath } from 'node:url';

import { ConfigError } from '../../config';

import type { PermissionMode, SettingSource } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeAuth = 'subscription' | 'api-key' | 'oauth-token';

export interface ClaudeConfig {
    /** Where the engine's credentials come from. Only `subscription` uses the login of the `claude` CLI. */
    auth: ClaudeAuth;
    permissionMode: Extract<PermissionMode, 'acceptEdits' | 'auto' | 'bypassPermissions'>;
    /** Which `.claude` settings the agent reads. `project` brings the repository's CLAUDE.md and `.claude/skills`. */
    settingSources: SettingSource[];
    /** How deep native sub-agents may nest (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). */
    maxSubagentDepth: number;
    /** How many native sub-agents may run at once in one session (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`). */
    maxConcurrentSubagents: number;
    /** A `claude` binary to run instead of the one the SDK ships. */
    executable?: string;
    /** Log raw rate-limit events and the like. */
    debug: boolean;
}

type Env = Record<string, string | undefined>;

const AUTH: readonly ClaudeAuth[] = ['subscription', 'api-key', 'oauth-token'];
const PERMISSION_MODES: readonly ClaudeConfig['permissionMode'][] = ['acceptEdits', 'auto', 'bypassPermissions'];
const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/** The daemon variable that holds the secret of each non-subscription provider, and the variable the `claude` process reads it from. */
export const CREDENTIALS = {
    'api-key': { source: 'CLOWDY_CLAUDE_API_KEY', target: 'ANTHROPIC_API_KEY' },
    'oauth-token': { source: 'CLOWDY_CLAUDE_OAUTH_TOKEN', target: 'CLAUDE_CODE_OAUTH_TOKEN' },
} as const;

/** The system skills next to this source tree: what runs load when the daemon has not materialized its own copy. */
export const DEFAULT_SYSTEM_SKILLS_DIR = fileURLToPath(new URL('../../../../../packages/system-skills', import.meta.url));

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
    const raw = env[name];

    if (raw === undefined || raw === '') {
        return fallback;
    }

    if (!allowed.includes(raw as T)) {
        throw new ConfigError(`${ name } must be one of ${ allowed.join(', ') }, got "${ raw }"`);
    }

    return raw as T;
}

function positive(env: Env, name: string, fallback: number): number {
    const raw = env[name];

    if (raw === undefined || raw === '') {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < 1) {
        throw new ConfigError(`${ name } must be a positive integer, got "${ raw }"`);
    }

    return value;
}

function settingSources(env: Env): SettingSource[] {
    const raw = env.CLOWDY_CLAUDE_SETTING_SOURCES;

    // The user's own Claude Code settings apply, as they do in a terminal: Clowdy orchestrates the work, it does not rewrite the tool.
    if (raw === undefined || raw === '') {
        return ['user', 'project', 'local'];
    }

    if (raw === 'none') {
        return [];
    }

    const sources = raw.split(',').map(source => source.trim());
    const unknown = sources.find(source => !SETTING_SOURCES.includes(source as SettingSource));

    if (unknown !== undefined) {
        throw new ConfigError(`CLOWDY_CLAUDE_SETTING_SOURCES must be "none" or a comma list of ${ SETTING_SOURCES.join(', ') }, got "${ raw }"`);
    }

    return sources as SettingSource[];
}

/** Reads the Claude engine's settings from the daemon's environment. A selected provider without its secret fails here, at start. */
export function loadClaudeConfig(env: Env = process.env): ClaudeConfig {
    const auth = oneOf(env, 'CLOWDY_CLAUDE_AUTH', AUTH, 'subscription');

    if (auth !== 'subscription' && !env[CREDENTIALS[auth].source]) {
        throw new ConfigError(`CLOWDY_CLAUDE_AUTH=${ auth } needs ${ CREDENTIALS[auth].source } to be set in the daemon's environment`);
    }

    return {
        auth,
        permissionMode: oneOf(env, 'CLOWDY_PERMISSION_MODE', PERMISSION_MODES, 'bypassPermissions'),
        settingSources: settingSources(env),
        maxSubagentDepth: positive(env, 'CLOWDY_CLAUDE_MAX_SUBAGENT_DEPTH', 3),
        maxConcurrentSubagents: positive(env, 'CLOWDY_CLAUDE_MAX_SUBAGENTS', 20),
        executable: env.CLOWDY_CLAUDE_BIN || undefined,
        debug: env.CLOWDY_CLAUDE_DEBUG === '1',
    };
}
