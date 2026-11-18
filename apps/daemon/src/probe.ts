import { loadConfig } from './config';
import { ToolBridge } from './engine/acp/bridge';
import { probeAgent } from './engine/acp/probe';
import { AgentRegistry } from './engine/acp/registry';
import { errorMessage } from './errors';

/**
 * `bun run probe [agent...]`: starts each agent the way a run does and asks it to open a session, without sending a
 * prompt, so no model is called. Without arguments it tries every agent found on this machine. For checking a new agent,
 * or why one fails. An adapter agent (Claude Code, Codex) is fetched with `bun x` the first time.
 */
const registry = new AgentRegistry({ dataDir: loadConfig().dataDir });
const bridge = new ToolBridge();
const wanted = process.argv.slice(2);
const found = (await registry.list()).filter(info => info.status === 'ready').map(info => info.id);
const ids = wanted.length > 0 ? wanted : found;
let failed = false;

for (const id of ids) {
    try {
        const probe = await probeAgent(registry, bridge, id, { cwd: process.cwd() });

        console.log(JSON.stringify(probe, null, 2));
    }
    catch (error) {
        failed = true;
        console.error(`${ id }: ${ errorMessage(error) }`);
    }
}

bridge.stop();
process.exit(failed ? 1 : 0);
