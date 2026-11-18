import pkg from '../../package.json';
import { ToolBridge } from './acp/bridge';
import { AcpEngine } from './acp/engine';
import { ClaudeEngine, loadClaudeConfig } from './claude';
import { FakeEngine } from './fake';

import type { Config } from '../config';
import type { AgentRegistry } from './acp/registry';
import type { AgentEngine, EngineRegistry } from './types';

export interface Engines extends EngineRegistry {
    /** Ends what the engines share: the tool bridge's listener. */
    stop(): void;
}

/**
 * The engines this daemon can run: the scripted fake, Claude Code on its own engine, and every other agent the registry
 * knows, each an ACP engine. Programs are found when a run starts, not here, so a daemon starts on a machine with no
 * agent installed and an agent installed later works without a restart.
 */
export function createEngines(config: Config, agents: AgentRegistry, env: Record<string, string | undefined> = process.env): Engines {
    const fake = new FakeEngine(config.fakeSpeed);
    const bridge = new ToolBridge();
    const engines = new Map<string, AgentEngine>();

    const create = (id: string): AgentEngine => {
        if (id === 'claude') {
            return new ClaudeEngine(loadClaudeConfig(env), config, {
                env,
                // The user's own Claude Code, found like their terminal would; the SDK's bundled copy is the fallback of nobody.
                locate: async () => {
                    const found = await agents.resolve('claude');

                    return found.ok ? { executable: found.agent.command, path: await agents.path() } : { error: found.message };
                },
            });
        }

        return new AcpEngine(id, {
            registry: agents,
            bridge,
            env,
            permissions: config.agentPermissions,
            clientVersion: pkg.version,
            debug: Boolean(env.CLOWDY_DEBUG),
        });
    };

    const engineFor = (id: string): AgentEngine => {
        let engine = engines.get(id);

        if (!engine) {
            engine = create(id);
            engines.set(id, engine);
        }

        return engine;
    };

    // The engine the daemon starts with is built now, so a bad setting of it stops the daemon at start.
    if (config.engine !== 'fake' && agents.has(config.engine)) {
        engineFor(config.engine);
    }

    return {
        has: id => id === 'fake' || agents.has(id),
        get: id => id === 'fake' ? fake : agents.has(id) ? engineFor(id) : undefined,
        stop: () => bridge.stop(),
    };
}
