import { Image } from '@clowdy/components/Image';
import { Folder, Home } from '@clowdy/icons/14';

import { useProjectIcon } from '../stores';
import styles from './ProjectIcon.module.css';

import type { Project } from '@clowdy/protocol';

/** The side of the icons a picture stands in for. The picture takes their room, so names line up whatever each project shows. */
const ICON_ROOM = 14;

export interface ProjectIconProps {
    project: Project;
    /** How large a picture is drawn, in pixels. It takes the room of a 14px icon either way. */
    size?: number;
}

/** A project's icon: its picture (uploaded, or found in its main folder), else the folder icon, and the house for the personal space. */
export function ProjectIcon({ project, size = 16 }: ProjectIconProps) {
    const src = useProjectIcon(project);

    if (!src) return project.personal ? <Home /> : <Folder />;

    return <Image className={ styles.picture } src={ src } alt="" width={ size } height={ size } style={ { margin: (ICON_ROOM - size) / 2 } } />;
}
