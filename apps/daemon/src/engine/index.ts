import pkg from '../../package.json';
import { ToolBridge } from './acp/bridge';
import { AcpEngine } from './acp/engine';
import { FakeEngine } from './fake';

import type { Shim } from '../cli/shim';
import type { Config } from '../config';
import type { AgentRegistry } from './acp/registry';
import type { AgentEngine, EngineRegistry } from './types';

export interface Engines extends EngineRegistry {
    /** Ends what the engines share: the tool bridge's listener. */
    stop(): void;
}

/**
 * The engines this daemon can run: the scripted fake, and every agent the registry knows, each an ACP engine. Programs are found when a run starts, not here, so a daemon starts on a machine with no
 * agent installed and an agent installed later works without a restart. `shim` is where the `clowdy` command is (`installShim`), which the agents of
 * sessions with shell commands get on their `PATH`.
 */
export function createEngines(config: Config, agents: AgentRegistry, env: Record<string, string | undefined> = process.env, shim?: Shim): Engines {
    const fake = new FakeEngine(config.fakeSpeed);
    const bridge = new ToolBridge();
    const engines = new Map<string, AgentEngine>();

    const create = (id: string): AgentEngine => new AcpEngine(id, {
        registry: agents,
        bridge,
        shim,
        env,
        permissions: config.agentPermissions,
        clientVersion: pkg.version,
        debug: Boolean(env.CLOWDY_DEBUG),
    });

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
