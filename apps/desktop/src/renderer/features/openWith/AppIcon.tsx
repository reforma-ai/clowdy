import { Image } from '@clowdy/components/Image';
import { CodeBraces, Folder, Terminal } from '@clowdy/icons/14';

import styles from './AppIcon.module.css';

import type { OpenApp, OpenFolderApp } from '../../../shared/bridge';

/** The side of the icons a picture stands in for. The picture takes their room, so names line up whatever each program shows. */
const ICON_ROOM = 14;
const PICTURE = 16;

export interface AppIconProps {
    /** The program, with the icon the desktop app read from it; none is drawn as the plain icon of its kind. */
    app: Pick<OpenApp, 'icon'>;
    kind: OpenFolderApp['kind'];
}

/** A program's own icon, as it has it on this computer; when there is none to show, a folder for a file manager, braces for an editor and a prompt for a terminal. */
export function AppIcon({ app, kind }: AppIconProps) {
    if (!app.icon) return kind === 'fileManager' ? <Folder aria-hidden="true" /> : kind === 'terminal' ? <Terminal aria-hidden="true" /> : <CodeBraces aria-hidden="true" />;

    return <Image className={ styles.picture } src={ app.icon } alt="" width={ PICTURE } height={ PICTURE } style={ { margin: (ICON_ROOM - PICTURE) / 2 } } />;
}
