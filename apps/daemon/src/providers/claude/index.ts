import { chatTitleSetting, commitMessageSetting } from '../../engine/acp/catalog';
import { modePermissions } from '../permissions';
import { claudeAccount } from './account';
import { claudeModels } from './models';

import type { SettingEffect } from '../../engine/acp/catalog';
import type { Provider } from '../types';

/**
 * Clowdy's own command, which the agent runs in its shell for tasks and threads: a preset that asks lets it through, so the person is not asked
 * about the runtime's own calls (the adapter hands `_meta.claudeCode.options.allowedTools` to the SDK as permission rules).
 */
const CLOWDY_COMMAND: SettingEffect = { allowedTools: ['Bash(clowdy:*)'] };

export const claude: Provider = {
    spec: {
        id: 'claude',
        name: 'Claude Code',
        programs: ['claude'],
        elicitation: true,
        launch: {
            kind: 'package',
            package: '@agentclientprotocol/claude-agent-acp@0.109.0',
            pathEnv: 'CLAUDE_CODE_EXECUTABLE',
        },
        // ACP v2: background commands, sub-agents and workflows are told as `state_update`s, and the agent's own turns come on the same session.
        protocol: 'v2',
        compact: '/compact',
        // `claude-agent-acp@0.107.0` forks at an exact assistant message (the SDK's `forkSession` with `upToMessageId`), inclusive. Checked through the daemon
        // on 2026-11-20 against the pin: `.briefback/message-actions/research/real-checks.md`.
        fork: true,
        // Sub-agents are a feature, this only caps hidden fan-out. The rest of what a run does not do by default (claude.ai
        // connectors, the agent's own memory) is a setting below, off until the person turns it on. Without the last variable
        // Claude Code reads no CLAUDE.md in the project's other folders, which reach it as additional directories. `CLAUDE_CODE_THINKING_DISPLAY` is what
        // makes the adapter send the agent's thoughts: recent models omit the text of their thinking unless it is asked for summarized (checked through the
        // daemon on 2026-11-21 against the pin: without it no `agent_thought_chunk` arrives, with it one thought comes before each step). The person may
        // set it to `omitted` in the agent's `env` to see none.
        env: {
            CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3',
            CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_THINKING_DISPLAY: 'summarized',
        },
        settings: [
            {
                id: 'memory',
                label: 'Memory',
                description: 'Let Claude Code read and write its own auto-memory in your runs',
                default: false,
                effect: on => ({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: on ? null : '1' } }),
            },
            {
                id: 'connectors',
                label: 'claude.ai connectors',
                description: 'Load the connectors set up on claude.ai (Drive, Docs and the like) into every run',
                default: false,
                effect: on => ({ env: { ENABLE_CLAUDEAI_MCP_SERVERS: on ? null : 'false' } }),
            },
            {
                id: 'subagents',
                label: 'Enable sub-agents',
                description:
                    'Let Claude Code start sub-agents inside a run. Off hides them, so agents delegate through Clowdy only.',
                default: true,
                effect: on => (on ? {} : { disallowedTools: ['Agent', 'Task', 'ListAgents'] }),
            },
            {
                id: 'workflows',
                label: 'Enable workflow tool',
                description:
                    'Let Claude Code run its Workflow tool, which fans one job out to many sub-agents and can use a lot of your plan. Off hides it, so agents delegate through Clowdy only.',
                default: true,
                effect: on => (on ? {} : { disallowedTools: ['Workflow'] }),
            },
            {
                id: 'longContext',
                label: '1M-token context',
                description: 'Use the 1M-token context window where the plan has one',
                default: true,
                effect: on => ({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: on ? null : '1' } }),
            },
            {
                // Stated both ways: Claude Code reads `0` as off (`artifact_env_off`), and a variable the person's own shell sets does not turn it on in a run that has it off.
                id: 'artifacts',
                label: 'Claude Artifacts',
                description:
                    'Let Claude Code publish pages such as reports and dashboards to your claude.ai account. They stay private until you share them, and Claude can publish without asking. Needs a claude.ai login on this machine.',
                default: false,
                effect: on => ({ env: { CLAUDE_CODE_ARTIFACT: on ? '1' : '0' } }),
            },
            chatTitleSetting('Claude Code'),
            commitMessageSetting('Claude Code'),
            {
                id: 'promptSuggestions',
                label: 'Suggest next messages',
                description:
                    'Let Claude Code predict your next message using its native suggestions. Applies to new sessions.',
                default: true,
                effect: on => ({ env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: on ? null : 'false' } }),
            },
        ],
        // A stray key in the daemon's environment would move billing off the user's subscription; a key the user wants goes in the agent's `env`.
        scrub: [/^ANTHROPIC_API_KEY$/, /^ANTHROPIC_AUTH_TOKEN$/, /^CLAUDE_CODE_OAUTH_TOKEN$/],
        login: 'claude auth login',
        // Tools that wait for a terminal and would hang a run nobody is watching.
        sessionMeta: { claudeCode: { options: { disallowedTools: ['AskUserQuestion', 'ExitPlanMode'] } } },
    },
    ...claudeAccount,
    models: claudeModels,
    // The modes of `claude-agent-acp@0.107.0` (`session-mode.js`). `plan` is a way of working, not a permission, and stays out. `auto` is offered unless the
    // account or the model cannot use it; a start on one it does not offer is logged and left to the agent.
    permissions: modePermissions(
        [
            { id: 'ask', mode: 'default', description: 'Asks before every edit and command', effect: CLOWDY_COMMAND },
            {
                id: 'accept-edits',
                mode: 'acceptEdits',
                description: 'Applies file edits, asks before commands and anything else',
                effect: CLOWDY_COMMAND,
            },
            {
                id: 'auto',
                mode: 'auto',
                description: 'Approves what its own check finds safe, asks about the rest',
                effect: CLOWDY_COMMAND,
            },
            { id: 'full', mode: 'bypassPermissions', description: 'Never asks, edits any file and runs any command' },
        ],
        'auto'
    ),
};
