import { CREDENTIALS } from './config';

import type { ClaudeConfig } from './config';

type Env = Record<string, string | undefined>;

/**
 * The only variables an agent inherits from the daemon. The SDK's `env` option replaces the child's environment, so
 * everything not listed here stays behind: `CLAUDECODE`, `CLAUDE_CODE_*` and `ELECTRON_RUN_AS_NODE` from the terminal or
 * app that started the daemon, and any `ANTHROPIC_*` credential that would silently switch billing off the subscription.
 */
const INHERITED = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
    'SSH_AUTH_SOCK',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    // Windows
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH',
];

/** The environment of a `claude` process: the inherited allowlist, the sub-agent caps, and the selected provider's secret. */
export function buildClaudeEnv(config: ClaudeConfig, daemonEnv: Env, platform: NodeJS.Platform = process.platform): Record<string, string> {
    // Windows environment names are case-insensitive: `Path` is `PATH`.
    const normalize = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
    const inherited = new Set(INHERITED.map(normalize));
    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(daemonEnv)) {
        if (value !== undefined && inherited.has(normalize(name))) {
            env[name] = value;
        }
    }

    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'clowdy';
    // Nothing of the user's own Claude setup reaches an unattended agent: not their claude.ai connectors (Drive, Docs, ...), not their auto-memory.
    env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = String(config.maxSubagentDepth);
    env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = String(config.maxConcurrentSubagents);

    if (config.auth !== 'subscription') {
        const { source, target } = CREDENTIALS[config.auth];
        const secret = daemonEnv[source];

        if (secret) {
            env[target] = secret;
        }
    }

    return env;
}
