import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { PanelEmptyState, PanelLoadingState } from '@clowdy/components/Panel';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';

import { useRootStore } from '../../../stores';
import { ReadFailed } from '../ReadFailed';
import { RecommendedSkill } from './RecommendedSkill';
import { SkillRow } from './SkillRow';
import styles from './SkillsSection.module.css';
import { groupSkills } from './skillView';
import { useSkills } from './useSkills';

/** Settings > Skills: the catalog grouped by source. */
export function SkillsSection() {
    const project = useRootStore().selectedProject?.project;

    // A new project starts from nothing: the key drops the old project's skills at once.
    return <SkillsBody key={project?.id ?? 'none'} projectId={project?.id} projectName={project?.name} />;
}

const INTRO = 'Skills give agents instructions for specific kinds of work';

function SkillsBody({ projectId, projectName }: { projectId?: string; projectName?: string }) {
    const { state, pending, reload, toggle } = useSkills(projectId);
    const { skillsRevision } = useRootStore();

    if (state.status === 'loading') {
        return (
            <SettingsLayout.Page description={INTRO}>
                <RecommendedSkill onInstalled={reload} revision={skillsRevision} />
                <PanelLoadingState label="Loading skills…" />
            </SettingsLayout.Page>
        );
    }

    if (state.status === 'failed') {
        return (
            <SettingsLayout.Page description={INTRO}>
                <RecommendedSkill onInstalled={reload} revision={skillsRevision} />
                <ReadFailed message={`Skills could not be loaded. ${state.message}`} onRetry={reload} />
            </SettingsLayout.Page>
        );
    }

    const { entries, systemEnabled, warnings } = state.catalog;

    return (
        <SettingsLayout.Page description={INTRO}>
            <RecommendedSkill onInstalled={reload} revision={skillsRevision} />
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

            {groupSkills(entries, projectName).map(group => (
                <SettingsLayout.Section
                    key={group.source}
                    title={`${group.title} skills`}
                    aside={
                        <Text variant="xs" color="secondary">
                            {group.skills.length}
                        </Text>
                    }
                    description={group.hint}
                >
                    {group.skills.length === 0 ? (
                        <PanelEmptyState fill={false} label={group.empty} />
                    ) : (
                        <SettingsLayout.Card as="ul" divided>
                            {group.source === 'system' && (
                                <SettingsLayout.Row
                                    as="li"
                                    title="Enable system skills"
                                    description="Changes apply to new agent sessions"
                                >
                                    <Switch
                                        size="sm"
                                        isSelected={systemEnabled}
                                        isPending={pending.has('clowdy:*')}
                                        onChange={enabled => void toggle('clowdy:*', enabled)}
                                    />
                                </SettingsLayout.Row>
                            )}
                            {group.skills.map(skill => (
                                <SkillRow
                                    key={skill.id}
                                    skill={skill}
                                    isPending={pending.has(skill.name)}
                                    isDisabled={
                                        group.source === 'system' && (!systemEnabled || pending.has('clowdy:*'))
                                    }
                                    onToggle={enabled => void toggle(skill.name, enabled)}
                                />
                            ))}
                        </SettingsLayout.Card>
                    )}
                </SettingsLayout.Section>
            ))}
        </SettingsLayout.Page>
    );
}
