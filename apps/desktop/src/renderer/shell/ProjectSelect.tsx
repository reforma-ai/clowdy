import { Button } from '@clowdy/components/Button';
import { listBoxItemDataShow, Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from '@clowdy/components/List';
import { Popover } from '@clowdy/components/Popover';
import { Text } from '@clowdy/components/Text';
import { ChevronDown, Folder, Home, Sliders } from '@clowdy/icons/14';
import { mainFolder } from '@clowdy/protocol';
import { useRef, useState } from 'react';

import { CommandHotkey } from '../hotkeys/CommandHotkey';
import { tildePath } from '../shared/displayPath';
import { homeFolder } from '../shared/homeFolder';
import { PathText } from '../shared/PathText';
import { ProjectIcon } from '../shared/ProjectIcon';
import { SCREEN_TITLE } from '../shared/screenTitle';
import { useRootStore } from '../stores';
import styles from './ProjectSelect.module.css';
import { projectSwitchCommand, slotOfProject } from './projectSwitch';

import type { Project } from '@clowdy/protocol';
import type { RefObject } from 'react';

const MANAGE = 'manage-projects';

/** Where a project is: its main folder (the path gives way to the count), and `+N` for the folders it has besides. */
function Where({ project }: { project: Pick<Project, 'folders'> }) {
    const more = project.folders.length - 1;

    return (
        <span className={styles.where}>
            <PathText path={mainFolder(project).path} />
            {more > 0 && <span className={styles.more}>{`+${more}`}</span>}
        </span>
    );
}

/**
 * The card beside a project's row while the pointer or the keyboard is on it: the project's name and the keys that open it, and every folder it has in full, the main
 * one first (the row itself has room for the main folder's path, cut short, and the count of the others).
 */
function ProjectTip({ project, slot }: { project: Project; slot: number | undefined }) {
    return (
        <div className={styles.tip}>
            <div className={styles.tipHead}>
                <span className={styles.tipName}>{project.name}</span>
                {slot !== undefined && <CommandHotkey id={projectSwitchCommand(slot)} />}
            </div>
            <ul className={styles.tipFolders}>
                {project.folders.map(folder => (
                    <li key={folder.id}>{tildePath(folder.path, homeFolder.path)}</li>
                ))}
            </ul>
        </div>
    );
}

/**
 * The sliders at the end of a project's row, which open the page of that project in Settings > Projects: a press target of its own that leaves the row unpressed
 * (`held` tells the menu's `onAction` that the press was the button's). It shows while the pointer is over the row. Keyboard users have "Manage projects…".
 */
function SettingsButton({
    project,
    held,
    onPress,
}: {
    project: Project;
    held: RefObject<boolean>;
    onPress: () => void;
}) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="xs"
            iconOnly
            aria-label={`${project.name} settings`}
            tooltip="Project settings"
            excludeFromTabOrder
            data-show={listBoxItemDataShow.itemHover}
            onPressStart={() => void (held.current = true)}
            onPressEnd={() => void (held.current = false)}
            onPress={onPress}
        >
            <Sliders />
        </Button>
    );
}

/**
 * The project switcher, which is the title of the list of chats: the project's icon, its name set as a screen's title is, and a chevron, with a plate only while the
 * pointer is over it. Its menu has the personal space on top, then the projects in the person's order, the open one on a plate and each with a button for its page in
 * Settings > Projects (shown on hover) and a card beside it with its name, keys and folders, then "Manage projects…", which opens the list there, where a project is added.
 */
export function ProjectSelect() {
    const root = useRootStore();
    const [isOpen, setIsOpen] = useState(false);
    // A press on a row's settings button reaches the row too, which must not switch to its project.
    const held = useRef(false);
    const selected = root.projects.find(project => project.id === root.selectedProjectId);
    const personal = root.projects.find(project => project.personal);
    const own = root.projects.filter(project => !project.personal);
    const settings = (project: Project) => (
        <SettingsButton
            project={project}
            held={held}
            onPress={() => {
                setIsOpen(false);
                root.ui.openProjectSettings(project.id);
            }}
        />
    );

    return (
        <MenuTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
            <Button variant="filling" size="sm" className={styles.trigger} aria-label="Project">
                {selected ? <ProjectIcon project={selected} /> : <Folder />}
                <Text variant={SCREEN_TITLE} truncate>
                    {selected?.name ?? 'No project'}
                </Text>
                <ChevronDown />
            </Button>
            <Popover placement="bottom start" width={280}>
                <Menu
                    aria-label="Projects"
                    size="md"
                    onAction={key => {
                        // The press was the settings button's, which has done its own work.
                        if (held.current) {
                            held.current = false;

                            return;
                        }

                        if (key === MANAGE) root.ui.openProjectSettings();
                        else {
                            root.selectProject(String(key));
                            setIsOpen(false);
                        }
                    }}
                >
                    <MenuSection
                        aria-label="Projects"
                        selectionMode="single"
                        selectedKeys={selected ? [selected.id] : []}
                        disallowEmptySelection
                    >
                        {personal && (
                            <MenuItem
                                id={personal.id}
                                text={personal.name}
                                description="Chats without a project"
                                icon={<Home />}
                                stacked
                                data-align="center"
                                // The row shuts the menu itself (`onAction`): a press on the settings button inside it must not.
                                shouldCloseOnSelect={false}
                                endAffix={settings(personal)}
                                tooltip={
                                    <ProjectTip project={personal} slot={slotOfProject(root.projects, personal)} />
                                }
                            />
                        )}
                        {personal && own.length > 0 && <MenuSeparator />}
                        {own.map(project => (
                            <MenuItem
                                key={project.id}
                                id={project.id}
                                text={project.name}
                                description={<Where project={project} />}
                                icon={<ProjectIcon project={project} />}
                                stacked
                                data-align="center"
                                shouldCloseOnSelect={false}
                                endAffix={settings(project)}
                                tooltip={<ProjectTip project={project} slot={slotOfProject(root.projects, project)} />}
                            />
                        ))}
                    </MenuSection>
                    {root.projects.length > 0 && <MenuSeparator />}
                    <MenuItem id={MANAGE} text="Manage projects…" icon={<Sliders />} />
                </Menu>
            </Popover>
        </MenuTrigger>
    );
}
