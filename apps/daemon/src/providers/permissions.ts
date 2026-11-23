import type { PermissionPresetId } from '@clowdy/protocol';
import type { SettingEffect } from '../engine/acp/catalog';
import type { PermissionSupport } from './types';

/**
 * What an agent offers when its provider declares no `permissions`: the client's own pair, which needs nothing from the agent. `ask` puts every
 * permission request to the person; `full` allows every one. An agent that never asks has nothing to ask about, so `full` is its default, which
 * is what such an agent has always done. Every custom agent has this pair.
 */
export const clientPermissions: PermissionSupport = {
    presets: [
        { id: 'ask', description: 'Clowdy asks you before the agent does anything it asks permission for' },
        { id: 'full', description: 'Clowdy allows everything the agent asks permission for' },
    ],
    default: 'full',
    apply: preset => ({ answer: preset === 'full' ? 'allow' : 'ask' }),
};

/** One preset of an agent that has a `mode` option for it. */
export interface ModePreset {
    id: PermissionPresetId;
    description: string;
    /** The agent's own id of the mode, the value of its `mode` config option. */
    mode: string;
    /** What the agent is started with for this preset besides the mode. */
    effect?: SettingEffect;
}

/**
 * The declaration of an agent whose permission presets are modes of its own (Claude Code, Codex): each preset sets the agent's `mode` option, and
 * Clowdy asks the person about what the agent still asks, except on `full`, where the agent asks nothing and the rest is allowed. An agent that needs
 * more than this writes its `PermissionSupport` by hand.
 */
export function modePermissions(presets: readonly ModePreset[], defaultPreset: PermissionPresetId): PermissionSupport {
    return {
        presets: presets.map(({ id, description }) => ({ id, description })),
        default: defaultPreset,
        apply: preset => {
            const found = presets.find(candidate => candidate.id === preset);

            return {
                ...(found && { mode: found.mode, ...(found.effect && { effect: found.effect }) }),
                answer: preset === 'full' ? 'allow' : 'ask',
            };
        },
    };
}
