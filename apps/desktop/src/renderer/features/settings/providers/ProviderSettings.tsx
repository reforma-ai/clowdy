import { Button } from '@clowdy/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsible } from '@clowdy/components/Collapsible';
import { Input } from '@clowdy/components/Input';
import { Radio, RadioGroup } from '@clowdy/components/Radio';
import { Show } from '@clowdy/components/Show';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { Textarea } from '@clowdy/components/Textarea';
import { ChevronDown } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';
import { useState } from 'react';

import styles from './ProviderSettings.module.css';
import { formatEnv, parseEnv } from './providerView';

import type { AgentInfo, AgentSetting, PermissionPresetId } from '@clowdy/protocol';
import type { useAgentCommands } from './useAgentCommands';

interface SettingsProps {
    agent: AgentInfo;
    commands: ReturnType<typeof useAgentCommands>;
}

function SettingRow({
    setting,
    isPending,
    onChange,
}: {
    setting: AgentSetting;
    isPending: boolean;
    onChange: (value: boolean) => void;
}) {
    return (
        <li className={styles.setting}>
            <div className={styles.text}>
                <Text variant="sm" weight="medium">
                    {setting.label}
                </Text>
                {setting.description && (
                    <Text variant="sm" color="secondary">
                        {setting.description}
                    </Text>
                )}
            </div>
            <Switch
                size="sm"
                isSelected={setting.value}
                isPending={isPending}
                aria-label={setting.label}
                onChange={onChange}
            />
        </li>
    );
}

function AdvancedTrigger() {
    const { state } = useCollapsible();

    return (
        <CollapsibleTrigger asChild>
            <Button type="button" variant="inline" color="secondary" size="sm" className={styles.trigger}>
                Advanced
                <ChevronDown className={cn('chevron', 'next')} aria-expanded={state.isExpanded} aria-hidden />
            </Button>
        </CollapsibleTrigger>
    );
}

function AdvancedPanel({ children }: { children: React.ReactNode }) {
    const { state } = useCollapsible();

    return (
        <Show when={state.isExpanded}>
            <CollapsibleContent className={styles.advanced}>{children}</CollapsibleContent>
        </Show>
    );
}

/**
 * The line under Program: which program Clowdy starts, and what the box is for. The path itself is in the box (the one the person chose)
 * or its placeholder (the one Clowdy found), so the line does not repeat it.
 */
function programNoteOf(savedPath: string, foundPath: string | undefined): { text: string; tone?: 'warning' } {
    if (savedPath) {
        return foundPath
            ? { text: 'Clowdy uses this one instead of the one it found. Reset to go back.' }
            : { text: "There's no program at this path. Fix it, or reset to the one Clowdy finds.", tone: 'warning' };
    }

    return foundPath
        ? { text: 'Clowdy uses the one it found on this computer. Enter a path to use another.' }
        : { text: "Clowdy couldn't find it on this computer. Enter the path to the program.", tone: 'warning' };
}

/**
 * Advanced, folded until asked: where the program is, and the environment it starts with. The boxes show what the daemon saved
 * (`agent.overrides`) and follow it when it changes; what the person has typed and not saved is a draft that stays until it is saved or
 * typed away.
 */
export function ProviderAdvanced({ agent, commands }: SettingsProps) {
    const savedPath = agent.overrides?.path ?? '';
    const savedEnv = agent.overrides?.env ? formatEnv(agent.overrides.env) : '';
    const [pathDraft, setPathDraft] = useState<string>();
    const [envDraft, setEnvDraft] = useState<string>();
    const path = pathDraft ?? savedPath;
    const env = envDraft ?? savedEnv;
    const parsed = parseEnv(env);
    const envError = env.trim() && !parsed.ok ? parsed.message : undefined;
    const programNote = programNoteOf(savedPath, agent.path);
    const canReset = Boolean(savedPath) || pathDraft !== undefined;

    // Saved on blur or Enter, as a project's name is. An empty box goes back to the program Clowdy finds. A refused path stays in the box.
    const commitPath = async () => {
        const next = pathDraft?.trim();

        if (next === undefined) return;

        // Nothing to save: the same path, or an empty box when none is saved.
        if (next === savedPath) {
            setPathDraft(undefined);

            return;
        }

        if (await commands.setPath(next || null)) setPathDraft(undefined);
    };

    const reset = async () => {
        if (savedPath && !(await commands.setPath(null))) return;

        setPathDraft(undefined);
    };

    return (
        <Collapsible>
            <AdvancedTrigger />
            <AdvancedPanel>
                <div className={styles.field}>
                    <Text variant="sm" weight="medium">
                        Program
                    </Text>
                    <Text variant="sm" color={programNote.tone ?? 'secondary'}>
                        {programNote.text}
                    </Text>
                    <div className={styles.inputs}>
                        <Input
                            type="text"
                            variant="bordered"
                            size="sm"
                            aria-label={`Path to the ${agent.name} program`}
                            placeholder={(!savedPath && agent.path) || '/path/to/program'}
                            value={path}
                            onChange={text => setPathDraft(text === savedPath ? undefined : text)}
                            onBlur={() => void commitPath()}
                            onKeyDown={event => {
                                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                                else if (event.key === 'Escape') setPathDraft(undefined);
                            }}
                        />
                        {/* A press keeps the focus in the box, so the box does not save what Reset is about to throw away. */}
                        <Button
                            variant="bordered"
                            size="sm"
                            preventFocusOnPress
                            isDisabled={!canReset || commands.pending.has('path')}
                            onPress={() => void reset()}
                        >
                            Reset
                        </Button>
                    </div>
                </div>

                <div className={styles.field}>
                    <Text variant="sm" weight="medium">
                        Environment
                    </Text>
                    <Text variant="sm" color="secondary">
                        Variables the program starts with, one KEY=VALUE per line. An empty box clears them. They apply
                        to the next run.
                    </Text>
                    <Textarea
                        variant="bordered"
                        size="sm"
                        aria-label={`Environment of ${agent.name}`}
                        placeholder="KEY=VALUE"
                        rows={3}
                        value={env}
                        isInvalid={Boolean(envError)}
                        onChange={text => setEnvDraft(text === savedEnv ? undefined : text)}
                    />
                    {envError && (
                        <Text variant="sm" color="danger" role="alert">
                            {envError}
                        </Text>
                    )}
                    <div>
                        <Button
                            variant="bordered"
                            size="sm"
                            isDisabled={envDraft === undefined || !parsed.ok}
                            isPending={commands.pending.has('env')}
                            onPress={() =>
                                parsed.ok && void commands.setEnv(parsed.env).then(ok => ok && setEnvDraft(undefined))
                            }
                        >
                            Save
                        </Button>
                    </div>
                </div>
            </AdvancedPanel>
        </Collapsible>
    );
}

/** The agent's own settings as switches. Nothing for an agent that has none. */
export function ProviderSettings({ agent, commands }: SettingsProps) {
    const settings = agent.settings ?? [];

    if (settings.length === 0) return null;

    return (
        <ul className={styles.list} aria-label={`${agent.name} settings`}>
            {settings.map(setting => (
                <SettingRow
                    key={setting.id}
                    setting={setting}
                    isPending={commands.pending.has(`setting:${setting.id}`)}
                    onChange={value => void commands.setSetting(setting.id, value)}
                />
            ))}
        </ul>
    );
}

/**
 * The permission presets the agent's provider offers, as radios: each preset's name and the provider's own words for what it does, the chosen one
 * selected (the person's choice, else the provider's default, which carries a quiet tag). The page knows nothing of any agent: the list is whatever
 * `AgentInfo.permissions` says. The group is read only while a choice is saved (not disabled, which would take the keyboard focus off the
 * radio), and the choice shows when the agents have been fetched again.
 */
export function PermissionPresets({ agent, commands }: SettingsProps) {
    const { permissions } = agent;

    if (!permissions || permissions.presets.length === 0) return null;

    const selected = permissions.value ?? permissions.default;
    const isPending = commands.pending.has('permission');

    return (
        <div className={styles.permissions} aria-busy={isPending || undefined}>
            <div className={styles.text}>
                <Text variant="sm" weight="medium">
                    Permissions
                </Text>
                <Text variant="sm" color="secondary">
                    What the agent may do without asking
                </Text>
            </div>

            <RadioGroup
                aria-label={`${agent.name} permissions`}
                value={selected}
                isReadOnly={isPending}
                className={styles.presets}
                onChange={value => void commands.setPermission(value as PermissionPresetId)}
            >
                {permissions.presets.map(preset => (
                    <Radio key={preset.id} value={preset.id} className={styles.preset}>
                        <span className={styles.presetText}>
                            <span className={styles.presetName}>
                                <Text variant="sm" weight="medium" color={preset.id === 'full' ? 'warning' : undefined}>
                                    {preset.name}
                                </Text>
                                {preset.id === permissions.default && (
                                    <span className={styles.defaultTag}>Default</span>
                                )}
                            </span>
                            <Text variant="sm" color="secondary">
                                {preset.description}
                            </Text>
                        </span>
                    </Radio>
                ))}
            </RadioGroup>
        </div>
    );
}
