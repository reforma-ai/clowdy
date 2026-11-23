import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';

import { useRootStore } from '../../../stores';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsEmpty } from '../ui/SettingsEmpty';
import { SettingsPage } from '../ui/SettingsPage';
import { SettingsSection } from '../ui/SettingsSection';
import { SkillRow } from './SkillRow';
import styles from './SkillsSection.module.css';
import { groupSkills, tokenLabel } from './skillView';
import { useSkills } from './useSkills';

/** Settings > Skills: every skill agents can use, grouped by where it comes from, with what it costs and a switch for the person's own. */
export function SkillsSection() {
    const project = useRootStore().selectedProject?.project;

    // A new project starts from nothing: the key drops the old project's skills at once.
    return <SkillsBody key={ project?.id ?? 'none' } projectId={ project?.id } projectName={ project?.name } />;
}

const INTRO = 'A skill is a short playbook an agent reads when a job calls for it. Every enabled skill adds its name and description to the start of every run, so a long list makes runs slower and dearer.';

function SkillsBody({ projectId, projectName }: { projectId?: string; projectName?: string }) {
    const { state, pending, reload, toggle } = useSkills(projectId);

    if (state.status === 'loading') {
        return (
            <SettingsPage description={ INTRO }>
                <Box direction="row" gap="md" align="center">
                    <Loader size="xs" />
                    <Text color="secondary">Loading skills…</Text>
                </Box>
            </SettingsPage>
        );
    }

    if (state.status === 'failed') {
        return (
            <SettingsPage description={ INTRO }>
                <Box gap="md" align="start">
                    <Text color="danger">Skills could not be loaded. { state.message }</Text>
                    <Button variant="bordered" size="sm" onPress={ reload }>Try again</Button>
                </Box>
            </SettingsPage>
        );
    }

    const { entries, tokens, warnings } = state.catalog;

    return (
        <SettingsPage
            description={ (
                <>
                    { INTRO }
                    { ' ' }
                    <span data-testid="skills-cost">Enabled skills add about <Text weight="medium">{ tokenLabel(tokens) }</Text> to every run.</span>
                </>
            ) }
        >
            { warnings.length > 0 && (
                <Alert color="warning" role="status">
                    <AlertIcon><AttentionTriangle /></AlertIcon>
                    <AlertDescription>
                        <ul className={ styles.warnings }>
                            { warnings.map(warning => <li key={ warning }>{ warning }</li>) }
                        </ul>
                    </AlertDescription>
                </Alert>
            ) }

            { groupSkills(entries, projectName).map(group => (
                <SettingsSection
                    key={ group.source }
                    title={ `${ group.title } skills` }
                    aside={ <Text variant="xs" color="secondary">{ group.skills.length }</Text> }
                    description={ group.hint }
                >
                    { group.skills.length === 0
                        ? <SettingsEmpty>{ group.empty }</SettingsEmpty>
                        : (
                            <SettingsCard as="ul" divided>
                                { group.skills.map(skill => (
                                    <SkillRow key={ skill.id } skill={ skill } isPending={ pending.has(skill.name) } onToggle={ enabled => void toggle(skill, enabled) } />
                                )) }
                            </SettingsCard>
                        ) }
                </SettingsSection>
            )) }
        </SettingsPage>
    );
}
