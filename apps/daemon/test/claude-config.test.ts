import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigError, loadConfig } from '../src/config';
import { createEngines } from '../src/engine';
import { ClaudeEngine } from '../src/engine/claude';
import { DEFAULT_SYSTEM_SKILLS_DIR, loadClaudeConfig } from '../src/engine/claude/config';
import { buildClaudeEnv } from '../src/engine/claude/env';
import { claudeConfig } from './claude-fakes';

describe('Claude engine config', () => {
    test('defaults: subscription login, unattended permissions, the project\'s settings only, 3 levels and 20 sub-agents', () => {
        expect(loadClaudeConfig({})).toEqual({
            auth: 'subscription',
            permissionMode: 'bypassPermissions',
            settingSources: ['project'],
            maxSubagentDepth: 3,
            maxConcurrentSubagents: 20,
            executable: undefined,
            debug: false,
        });
    });

    test('every setting can be overridden from the environment', () => {
        expect(loadClaudeConfig({
            CLOWDY_CLAUDE_AUTH: 'api-key',
            CLOWDY_CLAUDE_API_KEY: 'sk-ant-test',
            CLOWDY_PERMISSION_MODE: 'acceptEdits',
            CLOWDY_CLAUDE_SETTING_SOURCES: 'user, project,local',
            CLOWDY_CLAUDE_MAX_SUBAGENT_DEPTH: '1',
            CLOWDY_CLAUDE_MAX_SUBAGENTS: '5',
            CLOWDY_CLAUDE_BIN: '/opt/claude',
            CLOWDY_CLAUDE_DEBUG: '1',
        })).toEqual({
            auth: 'api-key',
            permissionMode: 'acceptEdits',
            settingSources: ['user', 'project', 'local'],
            maxSubagentDepth: 1,
            maxConcurrentSubagents: 5,
            executable: '/opt/claude',
            debug: true,
        });
    });

    test('"none" reads no settings at all', () => {
        expect(loadClaudeConfig({ CLOWDY_CLAUDE_SETTING_SOURCES: 'none' }).settingSources).toEqual([]);
    });

    test('a provider without its secret fails at start and names the variable to set', () => {
        expect(() => loadClaudeConfig({ CLOWDY_CLAUDE_AUTH: 'api-key' })).toThrow(/CLOWDY_CLAUDE_API_KEY/);
        expect(() => loadClaudeConfig({ CLOWDY_CLAUDE_AUTH: 'oauth-token' })).toThrow(/CLOWDY_CLAUDE_OAUTH_TOKEN/);
    });

    test('bad values name the variable and never echo a secret', () => {
        expect(() => loadClaudeConfig({ CLOWDY_CLAUDE_AUTH: 'password' })).toThrow(ConfigError);
        expect(() => loadClaudeConfig({ CLOWDY_PERMISSION_MODE: 'yolo' })).toThrow(/CLOWDY_PERMISSION_MODE/);
        expect(() => loadClaudeConfig({ CLOWDY_PERMISSION_MODE: 'plan' })).toThrow(/acceptEdits, auto, bypassPermissions/);
        expect(() => loadClaudeConfig({ CLOWDY_CLAUDE_SETTING_SOURCES: 'project,global' })).toThrow(/CLOWDY_CLAUDE_SETTING_SOURCES/);
        expect(() => loadClaudeConfig({ CLOWDY_CLAUDE_MAX_SUBAGENTS: '0' })).toThrow(/CLOWDY_CLAUDE_MAX_SUBAGENTS/);
        expect(() => loadClaudeConfig({ CLOWDY_CLAUDE_MAX_SUBAGENT_DEPTH: 'deep' })).toThrow(/CLOWDY_CLAUDE_MAX_SUBAGENT_DEPTH/);

        try {
            loadClaudeConfig({ CLOWDY_CLAUDE_AUTH: 'api-key', CLOWDY_CLAUDE_API_KEY: 'sk-ant-secret-value', CLOWDY_PERMISSION_MODE: 'yolo' });
        }
        catch (error) {
            expect((error as Error).message).not.toContain('sk-ant-secret-value');
        }
    });

    test('the secret is not part of the config object, so logging or storing the config cannot leak it', () => {
        const config = loadClaudeConfig({ CLOWDY_CLAUDE_AUTH: 'api-key', CLOWDY_CLAUDE_API_KEY: 'sk-ant-secret-value' });

        expect(JSON.stringify(config)).not.toContain('sk-ant-secret-value');
    });

    test('the default system skills are the plugin folder in this repository', () => {
        expect(existsSync(join(DEFAULT_SYSTEM_SKILLS_DIR, '.claude-plugin', 'plugin.json'))).toBe(true);
        expect(existsSync(join(DEFAULT_SYSTEM_SKILLS_DIR, 'skills', 'orchestrate', 'SKILL.md'))).toBe(true);
    });
});

describe('engine registry', () => {
    test('the scripted engine is the default and alone', () => {
        expect([...createEngines(loadConfig({}, 'linux'), {}).keys()]).toEqual(['fake']);
    });

    test('CLOWDY_ENGINE=claude adds the Claude engine and keeps the fake one', () => {
        const engines = createEngines(loadConfig({ CLOWDY_ENGINE: 'claude' }, 'linux'), {});

        expect([...engines.keys()]).toEqual(['fake', 'claude']);
        expect(engines.get('claude')).toBeInstanceOf(ClaudeEngine);
        expect(engines.get('claude')?.id).toBe('claude');
    });

    test('the Claude settings are read from the environment given, and an invalid one stops the daemon from starting', () => {
        const config = loadConfig({ CLOWDY_ENGINE: 'claude' }, 'linux');

        expect(() => createEngines(config, { CLOWDY_CLAUDE_AUTH: 'api-key' })).toThrow(/CLOWDY_CLAUDE_API_KEY/);
        expect(() => createEngines(loadConfig({}, 'linux'), { CLOWDY_CLAUDE_AUTH: 'api-key' })).not.toThrow();
    });
});

describe('the environment of an agent', () => {
    // What a daemon started from a Claude Code terminal, or from the Electron app, really inherits.
    const daemonEnv = {
        HOME: '/home/user',
        PATH: '/usr/local/bin:/usr/bin',
        USER: 'user',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp/user',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        HTTPS_PROXY: 'http://proxy:3128',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc.sock',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-from-terminal',
        CLAUDE_CONFIG_DIR: '/elsewhere',
        CLAUDE_EFFORT: 'max',
        ELECTRON_RUN_AS_NODE: '1',
        ANTHROPIC_API_KEY: 'sk-ant-from-terminal',
        ANTHROPIC_AUTH_TOKEN: 'token-from-terminal',
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        NODE_OPTIONS: '--inspect',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        GITHUB_TOKEN: 'ghp_x',
        CLOWDY_TOKEN: 'daemon-bearer-token',
    };

    test('only the allowlist gets through: the login shell\'s basics, the PATH the daemon resolved, proxies and the ssh agent', () => {
        expect(buildClaudeEnv(claudeConfig, daemonEnv, 'darwin')).toEqual({
            HOME: '/home/user',
            PATH: '/usr/local/bin:/usr/bin',
            USER: 'user',
            LANG: 'en_US.UTF-8',
            TMPDIR: '/tmp/user',
            SSH_AUTH_SOCK: '/tmp/agent.sock',
            HTTPS_PROXY: 'http://proxy:3128',
            CLAUDE_AGENT_SDK_CLIENT_APP: 'clowdy',
            ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3',
            CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20',
        });
    });

    test('nothing that would change who is billed or how the session behaves is forwarded under the subscription', () => {
        const env = buildClaudeEnv(claudeConfig, daemonEnv, 'darwin');

        for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EFFORT', 'ELECTRON_RUN_AS_NODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'NODE_OPTIONS', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CLOWDY_TOKEN']) {
            expect(env).not.toHaveProperty(name);
        }

        expect(Object.keys(env).filter(name => name.startsWith('CLAUDE_CODE_')).sort()).toEqual([
            'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
            'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
            'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
        ]);
    });

    test('the sub-agent caps come from the config', () => {
        const env = buildClaudeEnv({ ...claudeConfig, maxSubagentDepth: 1, maxConcurrentSubagents: 4 }, daemonEnv, 'linux');

        expect(env).toMatchObject({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1', CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4' });
    });

    test('the API key provider hands the daemon\'s own secret to the process as ANTHROPIC_API_KEY, and nothing else changes', () => {
        const env = buildClaudeEnv({ ...claudeConfig, auth: 'api-key' }, { ...daemonEnv, CLOWDY_CLAUDE_API_KEY: 'sk-ant-chosen' }, 'linux');

        expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-chosen');
        expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
        expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
        expect(env).not.toHaveProperty('CLOWDY_CLAUDE_API_KEY');
    });

    test('the token provider hands the daemon\'s own secret to the process as CLAUDE_CODE_OAUTH_TOKEN', () => {
        const env = buildClaudeEnv({ ...claudeConfig, auth: 'oauth-token' }, { ...daemonEnv, CLOWDY_CLAUDE_OAUTH_TOKEN: 'oauth-chosen' }, 'linux');

        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-chosen');
        expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    test('a secret in the daemon\'s environment is ignored while the subscription is selected', () => {
        const env = buildClaudeEnv(claudeConfig, { ...daemonEnv, CLOWDY_CLAUDE_API_KEY: 'sk-ant-chosen', CLOWDY_CLAUDE_OAUTH_TOKEN: 'oauth-chosen' }, 'linux');

        expect(JSON.stringify(env)).not.toContain('sk-ant-chosen');
        expect(JSON.stringify(env)).not.toContain('oauth-chosen');
    });

    test('Windows names are matched without regard to case, and the original spelling is kept', () => {
        const env = buildClaudeEnv(claudeConfig, { Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', UserProfile: 'C:\\Users\\u', ClaudeCode: '1', CLAUDECODE: '1' }, 'win32');

        expect(env).toMatchObject({ Path: 'C:\\bin', SYSTEMROOT: 'C:\\Windows', UserProfile: 'C:\\Users\\u' });
        expect(env).not.toHaveProperty('CLAUDECODE');
        expect(buildClaudeEnv(claudeConfig, { Path: 'C:\\bin' }, 'linux')).not.toHaveProperty('Path');
    });

    test('a missing value is not turned into the string "undefined"', () => {
        expect(buildClaudeEnv(claudeConfig, { HOME: undefined, PATH: '/bin' }, 'linux')).not.toHaveProperty('HOME');
    });
});
