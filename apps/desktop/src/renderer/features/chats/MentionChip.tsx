import { FileIcon } from '@clowdy/components/FileIcon';
import { BoltBordered, Box, Page } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import chipStyles from '../../shared/Chip.module.css';
import styles from './MentionChip.module.css';

import type { ComposerMentionAttrs, RichInputMentionRenderProps } from '@clowdy/components/RichInput';
import type { ReactNode } from 'react';

const ICON_SIZE = 12;

export function mentionIcon({ kind, data }: Pick<ComposerMentionAttrs, 'kind' | 'data'>, size = ICON_SIZE): ReactNode {
    switch (kind) {
        case 'task':
            return <Box width={ size } height={ size } />;
        case 'doc':
            return <Page width={ size } height={ size } />;
        case 'file':
            return <FileIcon path={ String((data as { path?: unknown } | null)?.path ?? '') } kind="file" />;
        default:
            return <BoltBordered width={ size } height={ size } />;
    }
}

/** A mention inside the text: the same plate as a task chip in the chat, with what it points at as its hover title. */
export function MentionChip({ mention }: RichInputMentionRenderProps) {
    const title = (mention.data as { title?: unknown; path?: unknown } | null)?.title ?? (mention.data as { path?: unknown } | null)?.path;

    return (
        <span className={ cn(chipStyles.chip, styles.chip) } data-chip title={ typeof title === 'string' ? title : undefined }>
            <span className={ chipStyles.icon }>{ mentionIcon(mention) }</span>
            <span className={ chipStyles.label }>{ mention.label }</span>
        </span>
    );
}
