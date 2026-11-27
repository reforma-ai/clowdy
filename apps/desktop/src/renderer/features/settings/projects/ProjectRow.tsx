import { Button } from '@clowdy/components/Button';
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { Folder, More, Sliders, Trash } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';

import { CommandHotkey } from '../../../hotkeys/CommandHotkey';
import { CardRow } from '../../../shared/CardRow';
import { PathText } from '../../../shared/PathText';
import { ProjectIcon } from '../../../shared/ProjectIcon';
import { projectSwitchCommand } from '../../../shell/projectSwitch';
import styles from './ProjectRow.module.css';
import { holdingMarks, plural } from './projectView';

import type { Project, ProjectInfo } from '@clowdy/protocol';

const CONFIGURE = 'configure';
const OPEN = 'open';
const REMOVE = 'remove';

export interface ProjectRowProps {
    project: Project;
    info: ProjectInfo | undefined;
    /** Shows the project's page in Settings. */
    onManage: () => void;
    /** Leaves Settings for the project itself. */
    onOpen: () => void;
    /** The place of the project in the keys that switch to it (`projectSwitch`): its hint shows before the actions. Absent for a project past the last key. */
    slot?: number;
    /** Absent for the personal space: it cannot be removed. */
    onRemove?: () => void;
}

/**
 * One project of the list: what it holds as marks after its name, and where it is (its main folder, and how many it has besides). A click
 * opens its page in Settings, and its menu configures the project, opens it or removes it. The keys that open the project show before the menu's button.
 */
export function ProjectRow({ project, info, slot, onManage, onOpen, onRemove }: ProjectRowProps) {
    const holdings = holdingMarks(info);
    const missing = info?.folders[0]?.exists === false;
    const path = mainFolder(project).path;
    const more = project.folders.length - 1;

    return (
        <CardRow
            onPress={onManage}
            pressProps={{ 'data-project-id': project.id }}
            icon={<ProjectIcon project={project} size={20} />}
            title={
                <Text variant="md" weight="medium" truncate>
                    {project.name}
                </Text>
            }
            marks={
                <>
                    {missing && (
                        <Badge size="xs" color="warning" textValue="Folder missing">
                            Folder missing
                        </Badge>
                    )}
                    {holdings.map(text => (
                        <Badge key={text} size="xs" textValue={text}>
                            {text}
                        </Badge>
                    ))}
                </>
            }
            actions={
                <>
                    {slot !== undefined && <CommandHotkey id={projectSwitchCommand(slot)} />}
                    <MenuTrigger>
                        <Button
                            variant="filling"
                            color="secondary"
                            size="sm"
                            iconOnly
                            aria-label={`${project.name} actions`}
                        >
                            <More />
                        </Button>
                        <Popover placement="bottom end" width={200}>
                            <Menu
                                aria-label={`${project.name} actions`}
                                size="md"
                                onAction={key => {
                                    if (key === CONFIGURE) onManage();
                                    else if (key === OPEN) onOpen();
                                    else if (key === REMOVE) onRemove?.();
                                }}
                            >
                                <MenuItem id={CONFIGURE} text="Configure" icon={<Sliders />} />
                                <MenuItem id={OPEN} text="Open space" icon={<Folder />} />
                                {onRemove && <MenuSeparator />}
                                {onRemove && (
                                    <MenuItem
                                        id={REMOVE}
                                        text="Remove…"
                                        icon={<Trash />}
                                        isDanger
                                        isDisabled={(info?.activeRuns ?? 0) > 0}
                                    />
                                )}
                            </Menu>
                        </Popover>
                    </MenuTrigger>
                </>
            }
        >
            <span
                className={styles.where}
                title={more > 0 ? project.folders.map(folder => folder.path).join('\n') : path}
            >
                <PathText path={path} variant="sm" color="secondary" />
                {more > 0 && (
                    <Text variant="sm" color="secondary" className={styles.more}>{`+${plural(more, 'folder')}`}</Text>
                )}
            </span>
        </CardRow>
    );
}
