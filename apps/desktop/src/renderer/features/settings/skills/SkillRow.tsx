import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { Lock } from '@clowdy/icons/12';

import { PathText } from '../../../shared/PathText';
import styles from './SkillRow.module.css';
import { tokenLabel } from './skillView';

import type { SkillEntry } from '@clowdy/protocol';

export interface SkillRowProps {
    skill: SkillEntry;
    /** A switch is on its way to the daemon. */
    isPending: boolean;
    isDisabled?: boolean;
    sourceFolder?: string;
    onToggle: (enabled: boolean) => void;
}

/** One skill and its availability, source and estimated cost. */
export function SkillRow({ skill, isPending, isDisabled, sourceFolder, onToggle }: SkillRowProps) {
    const { name, source, description, enabled, path, tokens } = skill;

    return (
        <SettingsLayout.Block as="li" className={styles.row} data-off={!enabled || undefined}>
            <div className={styles.body}>
                <div className={styles.titleLine}>
                    <Text variant="md" weight="medium" truncate className={styles.name}>
                        {name}
                    </Text>
                </div>
                <Text variant="sm" color="secondary" className={styles.description}>
                    {description}
                </Text>
                {sourceFolder && (
                    <Text variant="xs" color="secondary" className={styles.folder}>
                        Folder: {sourceFolder}
                    </Text>
                )}
                {path && (
                    <span className={styles.source}>
                        <PathText path={path} variant="xs" color="secondary" />
                    </span>
                )}
            </div>

            <div className={styles.side}>
                <Text
                    variant="xs"
                    color="secondary"
                    className={styles.cost}
                    title="What this skill adds to every run while it is on"
                >
                    {tokenLabel(tokens)}
                </Text>
                {source !== 'project' ? (
                    <Switch
                        size="sm"
                        isSelected={enabled}
                        isPending={isPending}
                        isDisabled={isDisabled}
                        aria-label={`Use ${name}`}
                        onChange={onToggle}
                    />
                ) : (
                    <span className={styles.lock} role="img" aria-label="Always on" title="Always on">
                        <Lock />
                    </span>
                )}
            </div>
        </SettingsLayout.Block>
    );
}
