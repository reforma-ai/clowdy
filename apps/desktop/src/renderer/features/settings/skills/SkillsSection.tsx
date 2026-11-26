import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Loader } from '@clowdy/components/Loader';
import { Switch } from '@clowdy/components/Switch';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';

import { useRootStore } from '../../../stores';
import { SettingsBlock } from '../ui/SettingsBlock';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsEmpty } from '../ui/SettingsEmpty';
import { SettingsPage } from '../ui/SettingsPage';
import { SettingsSection } from '../ui/SettingsSection';
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

    if (state.status === 'loading') {
        return (
            <SettingsPage description={INTRO}>
                <Box direction="row" gap="md" align="center">
                    <Loader size="xs" />
                    <Text color="secondary">Loading skills…</Text>
                </Box>
            </SettingsPage>
        );
    }

    if (state.status === 'failed') {
        return (
            <SettingsPage description={INTRO}>
                <Box gap="md" align="start">
                    <Text color="danger">Skills could not be loaded. {state.message}</Text>
                    <Button variant="bordered" size="sm" onPress={reload}>
                        Try again
                    </Button>
                </Box>
            </SettingsPage>
        );
    }

    const { entries, systemEnabled, warnings } = state.catalog;

    return (
        <SettingsPage description={INTRO}>
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
                <SettingsSection
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
                        <SettingsEmpty>{group.empty}</SettingsEmpty>
                    ) : (
                        <SettingsCard as="ul" divided>
                            {group.source === 'system' && (
                                <SettingsBlock as="li" className={styles.systemControl}>
                                    <div className={styles.systemLabel}>
                                        <Text weight="medium">Enable system skills</Text>
                                        <Text variant="sm" color="secondary">
                                            Changes apply to new agent sessions
                                        </Text>
                                    </div>
                                    <Switch
                                        size="sm"
                                        aria-label="Enable system skills"
                                        isSelected={systemEnabled}
                                        isPending={pending.has('clowdy:*')}
                                        onChange={enabled => void toggle('clowdy:*', enabled)}
                                    />
                                </SettingsBlock>
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
                        </SettingsCard>
                    )}
                </SettingsSection>
            ))}
        </SettingsPage>
    );
}
