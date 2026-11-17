import { Alert, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { AttentionTriangle } from '@clowdy/icons/14';

import { useRootStore } from '../../../stores';
import { SkillRow } from './SkillRow';
import styles from './SkillsSection.module.css';
import { groupSkills, tokenLabel } from './skillView';
import { useSkills } from './useSkills';

/** Settings > Skills (the page's title is the window's own): every skill agents can use, grouped by where it comes from, with what it costs and a switch for the person's own. */
export function SkillsSection() {
    const project = useRootStore().selectedProject?.project;

    // A new project starts from nothing: the key drops the old project's skills at once.
    return <SkillsBody key={ project?.id ?? 'none' } projectId={ project?.id } projectName={ project?.name } />;
}

const INTRO = (
    <Text color="secondary">
        A skill is a short playbook an agent reads when a job calls for it. Every enabled skill adds its name and description to the start of every run,
        so a long list makes runs slower and dearer.
    </Text>
);

function SkillsBody({ projectId, projectName }: { projectId?: string; projectName?: string }) {
    const { state, pending, reload, toggle } = useSkills(projectId);

    if (state.status === 'loading') {
        return (
            <>
                { INTRO }
                <Box direction="row" gap="md" align="center">
                    <Spinner size="sm" />
                    <Text color="secondary">Loading skills…</Text>
                </Box>
            </>
        );
    }

    if (state.status === 'failed') {
        return (
            <>
                { INTRO }
                <Box gap="md" align="start">
                    <Text color="danger">Skills could not be loaded. { state.message }</Text>
                    <Button variant="bordered" size="sm" onPress={ reload }>Try again</Button>
                </Box>
            </>
        );
    }

    const { entries, tokens, warnings } = state.catalog;

    return (
        <>
            <div className={ styles.summary }>
                { INTRO }
                <Text color="secondary" data-testid="skills-cost">
                    Enabled skills add about <Text bold>{ tokenLabel(tokens) }</Text> to every run.
                </Text>
            </div>

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
                <section key={ group.source } className={ styles.group } aria-label={ `${ group.title } skills` }>
                    <div className={ styles.groupHeader }>
                        <Text variant="heading-5">{ group.title }</Text>
                        <Text variant="xs" color="secondary">{ group.skills.length }</Text>
                    </div>
                    <Text variant="sm" color="secondary">{ group.hint }</Text>

                    { group.skills.length === 0
                        ? <Text variant="sm" color="secondary" className={ styles.empty }>{ group.empty }</Text>
                        : (
                            <ul className={ styles.list }>
                                { group.skills.map(skill => (
                                    <SkillRow key={ skill.id } skill={ skill } isPending={ pending.has(skill.name) } onToggle={ enabled => void toggle(skill, enabled) } />
                                )) }
                            </ul>
                        ) }
                </section>
            )) }
        </>
    );
}
