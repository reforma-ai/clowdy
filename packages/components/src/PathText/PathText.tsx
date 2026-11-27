import { cn } from '@clowdy/lib';

import { Text } from '../Text';
import styles from './PathText.module.css';

export interface PathTextProps {
    path: string;
    /** The file name in the medium weight after a dim folder (the default), or the whole path in one tone. */
    emphasizeName?: boolean;
    className?: string;
}

/** A path on one line that is cut at its start when it is too long, so the file name stays; the whole path is its native tooltip. */
export function PathText({ path, emphasizeName = true, className }: PathTextProps) {
    const cut = path.lastIndexOf('/') + 1;
    const folder = path.slice(0, cut);
    const name = path.slice(cut);

    return (
        <span className={cn(styles.path, className)} dir="rtl" title={path}>
            <bdi dir="ltr">
                {emphasizeName ? (
                    <>
                        {folder && <Text color="secondary">{folder}</Text>}
                        <Text weight="medium">{name}</Text>
                    </>
                ) : (
                    path
                )}
            </bdi>
        </span>
    );
}

PathText.displayName = 'PathText';
