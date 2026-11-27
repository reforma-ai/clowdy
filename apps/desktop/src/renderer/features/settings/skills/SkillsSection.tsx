import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { ListBoxItem } from '@clowdy/components/List';
import { PanelEmptyState } from '@clowdy/components/Panel';
import { Select } from '@clowdy/components/Select';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { ShimmerBlock } from '@clowdy/components/Shimmer';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';

import { useRootStore } from '../../../stores';
import { ReadFailed } from '../ReadFailed';
import { RecommendedSkill } from './RecommendedSkill';
import { SkillRow } from './SkillRow';
import styles from './SkillsSection.module.css';
import { useSkills } from './useSkills';

import type { SkillEntry } from '@clowdy/protocol';

export const SkillsSection = observer(function SkillsSection() {
    const root = useRootStore();
    const [selected, setSelected] = useState('global');
    const { scope, pending, reload, toggle } = useSkills(root.projects);
    const project = root.projects.find(item => item.id === selected);
    const selectedId = project?.id ?? '';
    const global = scope('');
    const active = scope(selectedId);
    const entries = (id: string, source: SkillEntry['source']) => {
        const state = scope(id);
        return state.status === 'ready' ? state.catalog.entries.filter(entry => entry.source === source) : undefined;
    };
    const system = entries('', 'system');
    const shown = entries(selectedId, selectedId ? 'project' : 'user');
    const options = [
        { id: 'global', name: 'Global skills', count: entries('', 'user')?.length },
        ...root.projects.map(item => ({ id: item.id, name: item.name, count: entries(item.id, 'project')?.length })),
    ];
    const rows = (skills: SkillEntry[]) =>
        skills.map(skill => (
            <SkillRow
                key={skill.id}
                skill={skill}
                isPending={pending.has(skill.name)}
                sourceFolder={
                    skill.source === 'project' && project && project.folders.length > 1 && skill.path
                        ? project.folders
                              .filter(folder => {
                                  const root = folder.path.replaceAll('\\', '/').replace(/\/$/, '');
                                  return skill.path!.replaceAll('\\', '/').startsWith(`${root}/`);
                              })
                              .sort((a, b) => b.path.length - a.path.length)[0]?.path
                        : undefined
                }
                isDisabled={
                    skill.source === 'system' &&
                    global.status === 'ready' &&
                    (!global.catalog.systemEnabled || pending.has('clowdy:*'))
                }
                onToggle={enabled => void toggle(skill.name, enabled)}
            />
        ));
    const error = (message: string) => (
        <ReadFailed message={`Skills could not be loaded: ${message}`} onRetry={reload} />
    );
    const warnings = active.status === 'ready' ? active.catalog.warnings : [];

    return (
        <SettingsLayout.Page description="Skills give agents instructions for specific kinds of work">
            <RecommendedSkill onInstalled={reload} revision={root.skillsRevision} />
            {warnings.length > 0 && (
                <Alert color="warning" role="status">
                    <AlertIcon>
                        <AttentionTriangle />
                    </AlertIcon>
                    <AlertDescription>
                        <ul className={styles.warnings}>
                            {warnings.map(warning => (
                                <li key={warning}>{warning}</li>
                            ))}
                        </ul>
                    </AlertDescription>
                </Alert>
            )}
            <SettingsLayout.Section
                title="System skills"
                aside={
                    system && (
                        <Text variant="xs" color="secondary">
                            {system.length}
                        </Text>
                    )
                }
                description="Bundled with Clowdy to guide agents"
            >
                {global.status === 'loading' ? (
                    <SystemSkeleton />
                ) : global.status === 'failed' ? (
                    error(global.message)
                ) : (
                    <SettingsLayout.Card as="ul" divided>
                        <SettingsLayout.Row
                            as="li"
                            title="Enable system skills"
                            description="Changes apply to new agent sessions"
                        >
                            <Switch
                                size="sm"
                                aria-label="Enable system skills"
                                isSelected={global.catalog.systemEnabled}
                                isPending={pending.has('clowdy:*')}
                                onChange={enabled => void toggle('clowdy:*', enabled)}
                            />
                        </SettingsLayout.Row>
                        {rows(system ?? [])}
                    </SettingsLayout.Card>
                )}
            </SettingsLayout.Section>
            <SettingsLayout.Section
                title="Skills"
                aside={
                    <Select
                        aria-label="Skills scope"
                        size="sm"
                        className={styles.select}
                        items={options}
                        selectedKey={selectedId || 'global'}
                        onSelectionChange={(key: unknown) => typeof key === 'string' && setSelected(key)}
                    >
                        {item => (
                            <ListBoxItem
                                id={item.id}
                                text={`${item.name}${item.count === undefined ? '' : ` (${item.count})`}`}
                            />
                        )}
                    </Select>
                }
                description={project ? `Skills from ${project.name}` : 'Skills from this computer'}
            >
                {active.status === 'loading' ? (
                    <div role="status" aria-label="Loading skills">
                        <SettingsLayout.Card>
                            <SettingsLayout.Block>
                                <ShimmerBlock className={styles.skeletonLine} />
                            </SettingsLayout.Block>
                        </SettingsLayout.Card>
                    </div>
                ) : active.status === 'failed' ? (
                    error(active.message)
                ) : shown?.length ? (
                    <SettingsLayout.Card as="ul" divided>
                        {rows(shown)}
                    </SettingsLayout.Card>
                ) : (
                    <PanelEmptyState
                        fill={false}
                        label={project ? `No skills found in ${project.name}` : 'No global skills found'}
                    />
                )}
            </SettingsLayout.Section>
        </SettingsLayout.Page>
    );
});

function SystemSkeleton() {
    return (
        <div role="status" aria-label="Loading system skills">
            <SettingsLayout.Card divided>
                {[0, 1, 2].map(row => (
                    <SettingsLayout.Block key={row} className={styles.skeletonRow}>
                        <div className={styles.skeletonBody}>
                            <ShimmerBlock className={styles.skeletonTitle} />
                            <ShimmerBlock className={styles.skeletonLine} />
                            {row > 0 && <ShimmerBlock className={styles.skeletonLineShort} />}
                        </div>
                        <ShimmerBlock className={styles.skeletonSwitch} />
                    </SettingsLayout.Block>
                ))}
            </SettingsLayout.Card>
        </div>
    );
}
