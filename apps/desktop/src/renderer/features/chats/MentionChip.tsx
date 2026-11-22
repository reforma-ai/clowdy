import { FileIcon } from '@clowdy/components/FileIcon';
import { Box, Page } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import chipStyles from '../../shared/Chip.module.css';
import styles from './MentionChip.module.css';

import type { ComposerMentionAttrs, RichInputMentionRenderProps } from '@clowdy/components/RichInput';
import type { ReactNode } from 'react';

const ICON_SIZE = 12;

/** The mark of a mention: a task, a document or a file has one; a skill (`command`) is its `/name` alone. */
export function mentionIcon({ kind, data }: Pick<ComposerMentionAttrs, 'kind' | 'data'>, size = ICON_SIZE): ReactNode {
    switch (kind) {
        case 'task':
            return <Box width={ size } height={ size } />;
        case 'doc':
            return <Page width={ size } height={ size } />;
        case 'file': {
            const { path, directory } = (data ?? {}) as { path?: unknown; directory?: unknown };

            // A folder pasted from Finder or the tree is a chip of this kind too.
            return <FileIcon path={ String(path ?? '') } kind={ directory === true ? 'directory' : 'file' } />;
        }
        default:
            return null;
    }
}

/** A mention inside the text: the same plate as a task chip in the chat, with what it points at as its hover title. */
export function MentionChip({ mention }: RichInputMentionRenderProps) {
    const title = (mention.data as { title?: unknown; path?: unknown } | null)?.title ?? (mention.data as { path?: unknown } | null)?.path;
    const icon = mentionIcon(mention);

    return (
        <span className={ cn(chipStyles.chip, styles.chip) } data-chip title={ typeof title === 'string' ? title : undefined }>
            { icon && <span className={ chipStyles.icon }>{ icon }</span> }
            <span className={ chipStyles.label }>{ mention.label }</span>
        </span>
    );
}
