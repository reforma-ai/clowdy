import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { DEFAULT_SYSTEM_SKILLS_DIR } from './config';
import { ClaudeSession } from './session';

import type { Config } from '../../config';
import type { AgentEngine, EngineSession, EngineStartOptions } from '../types';
import type { ClaudeConfig } from './config';
import type { Totals } from './mapper';
import type { ClaudeDiagnostics } from './session';

export { loadClaudeConfig } from './config';
export type { ClaudeConfig } from './config';
export type { ClaudeDiagnostics } from './session';

/** The skill folders the daemon keeps current in its config; they are read every time a run starts. */
export type SkillDirs = Pick<Config, 'systemSkillsDir' | 'extraPluginDirs'>;

/** Where the user's own Claude Code is, or why it cannot be used. */
export type Located = { executable: string; path: string } | { error: string };

export interface ClaudeEngineDeps {
    /**
     * Finds the user's installed `claude` and the search path to run it with, when a session starts. Without it, or when
     * `CLOWDY_CLAUDE_BIN` is set, the SDK's own bundled copy is used.
     */
    locate?: () => Promise<Located>;
    /** The environment agents are built from; the daemon's own by default. */
    env?: Record<string, string | undefined>;
    /** The SDK's `query`; tests replace it with a script. */
    query?: typeof sdkQuery;
}

/** Runs agents on Claude Code through the Claude Agent SDK, on the user's subscription unless the config says otherwise. */
export class ClaudeEngine implements AgentEngine {
    readonly id = 'claude';

    /** What the latest `claude` process said about itself. */
    diagnostics?: ClaudeDiagnostics;

    private totals = new Map<string, Totals>();

    constructor(private config: ClaudeConfig, private skills: SkillDirs, private deps: ClaudeEngineDeps = {}) {}

    start(options: EngineStartOptions): EngineSession {
        return new ClaudeSession(options, {
            config: this.config,
            env: this.deps.env ?? process.env,
            query: this.deps.query ?? sdkQuery,
            totals: this.totals,
            locate: this.deps.locate,
            pluginDirs: () => [this.skills.systemSkillsDir ?? DEFAULT_SYSTEM_SKILLS_DIR, ...(this.skills.extraPluginDirs ?? [])],
            onInit: init => this.noteInit(init),
        });
    }

    private noteInit(init: ClaudeDiagnostics): void {
        // Under subscription auth any API key in play means the work is billed to the API, not the plan.
        if (this.config.auth === 'subscription' && init.apiKeySource !== 'none' && this.diagnostics?.apiKeySource !== init.apiKeySource) {
            console.warn(`[clowdy] claude: requests are billed through "${ init.apiKeySource }", not the subscription login`);
        }

        this.diagnostics = init;
    }
}
