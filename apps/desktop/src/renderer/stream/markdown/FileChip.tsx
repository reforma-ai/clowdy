import { FileIcon } from '@clowdy/components/FileIcon';
import { toast } from '@clowdy/components/Toast';
import { cn } from '@clowdy/lib';

import chipStyles from '../../shared/Chip.module.css';
import { chipLabelFromPath, isDirectoryPath, normalizeChipPath } from './chipPath';

export interface FileChipProps {
    /** A path inside the project, as an agent or a person wrote it. */
    path: string;
    /** `12` or `12-20`, from a citation of lines. */
    lines?: string;
    className?: string;
}

/**
 * A file or folder named in a message: its icon and name, the whole path on hover. There is no code view to open it
 * in, so a press copies the path.
 */
export function FileChip({ path, lines, className }: FileChipProps) {
    const clean = normalizeChipPath(path);
    const label = lines ? `${ chipLabelFromPath(clean) } (${ lines })` : chipLabelFromPath(clean);

    const copy = () => {
        navigator.clipboard.writeText(clean).then(
            () => toast.success({ message: 'Path copied' }),
            () => toast.error({ message: 'The path could not be copied' })
        );
    };

    return (
        <button type="button" className={ cn(chipStyles.chip, className) } title={ clean } aria-label={ `Copy ${ clean }` } onClick={ copy }>
            <span className={ chipStyles.icon }><FileIcon path={ clean } kind={ isDirectoryPath(path) ? 'directory' : 'file' } /></span>
            <span className={ chipStyles.label }>{ label }</span>
        </button>
    );
}
