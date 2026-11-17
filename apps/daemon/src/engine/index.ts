import { ClaudeEngine, loadClaudeConfig } from './claude';
import { FakeEngine } from './fake';

import type { EngineId } from '@clowdy/protocol';
import type { Config } from '../config';
import type { AgentEngine } from './types';

/**
 * The engines this daemon can run: the scripted fake always, and the configured real engine. A real engine is
 * created only when it is the one selected, so its settings are checked, and its credentials read, only then.
 */
export function createEngines(config: Config, env: Record<string, string | undefined> = process.env): Map<EngineId, AgentEngine> {
    const engines = new Map<EngineId, AgentEngine>([['fake', new FakeEngine(config.fakeSpeed)]]);

    if (config.engine === 'claude') {
        engines.set('claude', new ClaudeEngine(loadClaudeConfig(env), config, { env }));
    }

    return engines;
}
