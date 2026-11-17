import { cn } from '@clowdy/lib';
import { use } from 'react';

import styles from './FileIcon.module.css';
import { FileIconColorScheme, iconName, iconUrl } from './fileIconTheme';

import type { FileIconKind } from './fileIconTheme';

interface FileIconProps {
    path: string;
    kind: FileIconKind;
    /** A folder shows open. */
    open?: boolean;
    className?: string;
}

/** The Material icon for a file or folder. */
export function FileIcon({ path, kind, open, className }: FileIconProps) {
    const url = iconUrl(iconName(path, kind, { open, light: use(FileIconColorScheme) === 'light' }));

    return <img src={ url } alt="" draggable={ false } className={ cn(styles.icon, className) } />;
}
