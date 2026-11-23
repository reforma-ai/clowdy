import { chatTitleSetting, commitMessageSetting } from '../../engine/acp/catalog';
import { modePermissions } from '../permissions';
import { codexAccount } from './account';
import { codexModels } from './models';

import type { Provider } from '../types';

export const codex: Provider = {
    spec: {
        id: 'codex',
        name: 'Codex',
        programs: ['codex'],
        launch: { kind: 'package', package: '@agentclientprotocol/codex-acp@2.8.0', pathEnv: 'CODEX_PATH' },
        // ACP v2: `codex-acp` 2.8.0 reports a command that outlives its call and a sub-agent as `background` (`terminal/cancel` stops a command, `session/cancel`
        // of the child a sub-agent) and takes `_session/steering`, which the v2 layer uses when an agent advertises it (a plain prompt on v2 is held until the
        // turn ends). Codex never starts a turn to report that the work ended, so the runtime sends it a note (`wakesOnBackgroundEnd`). Checked through the
        // daemon on 2.8.0 ("Codex on v2 through the daemon (2.8.0)" in `acp-background-probe.md`, under `.briefback/background-work/research/`).
        // Pinned before it was three days old, by the owner's decision of 2026-11-20 (it turns three days old on 2026-11-22): until then a first Codex chat on a
        // machine whose global `~/.bunfig.toml` sets `minimumReleaseAge` fails with "blocked by minimum-release-age", in any folder, unless the bunx cache already
        // holds 2.8.0.
        protocol: 'v2',
        wakesOnBackgroundEnd: true,
        compact: '/compact',
        // `codex-acp@2.8.0` reads the same fork point (`SessionFork.ts`: the message id is looked up among the thread's items and `thread/fork` runs through the
        // turn that holds it, which is a turn end, where Clowdy only ever forks). ON BY THE OWNER'S DECISION OF 2026-11-21, NOT CHECKED against the real adapter
        // (the pin could not be launched on the check's machine before 2026-11-22): the owner tests it. A turn whose message the adapter gives no id for shows no
        // Fork or Edit, and a fork the adapter refuses fails with a message and creates nothing. Run the check in `real-checks.md` for Codex and turn the flag
        // off if it fails.
        fork: true,
        settings: [
            {
                // Codex's memories are a feature that is off until the person turns it on, so "on" has to turn the feature on too; "off" is also stated, so a feature the person turned on in their own Codex does not reach Clowdy's runs.
                id: 'memory',
                label: 'Memory',
                description: 'Let Codex recall its memories and save new ones from your runs',
                default: false,
                effect: on => ({ codexConfig: { 'features.memories': on, 'memories.use_memories': on, 'memories.generate_memories': on } }),
            },
            {
                // The keys of Codex 0.145 and newer (the adapter pins 0.166); an older Codex names them differently.
                id: 'subagents',
                label: 'Enable sub-agents',
                description: 'Let Codex start sub-agents inside a run. Off turns them off, so agents delegate through Clowdy only.',
                default: true,
                effect: on => on ? {} : { codexConfig: { 'agents.enabled': false, 'features.multi_agent_v2': false } },
            },
            chatTitleSetting('Codex'),
            commitMessageSetting('Codex'),
        ],
        scrub: [/^OPENAI_API_KEY$/, /^CODEX_API_KEY$/],
        login: 'codex login',
    },
    ...codexAccount,
    models: codexModels,
    // The modes of `codex-acp@2.8.0` (`AgentMode`). Codex's permission profiles come from the person's own config and stay out. Only `agent-full-access` opens the
    // sandbox and the network; the others keep the workspace sandbox with the network off.
    permissions: modePermissions([
        { id: 'ask', mode: 'read-only', description: 'Asks before editing files or using the network' },
        { id: 'accept-edits', mode: 'workspace-write', description: 'Edits workspace files, asks before going outside them or using the network' },
        { id: 'auto', mode: 'agent', description: 'Reviews risky actions itself, asks about the rest' },
        { id: 'full', mode: 'agent-full-access', description: 'No sandbox, never asks' },
    ], 'auto'),
};
