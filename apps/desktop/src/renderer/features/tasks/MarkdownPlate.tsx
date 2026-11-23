import { MarkdownEditor, type MarkdownEditorProps } from '@clowdy/components/MarkdownEditor';
import { cn } from '@clowdy/lib';

import styles from './MarkdownPlate.module.css';

export interface MarkdownPlateProps extends MarkdownEditorProps {
    /** Stops growing at a height and scrolls inside: for a field that sits above other things and can hold a lot, like a comment being written. */
    isBounded?: boolean;
}

/**
 * The Markdown editor as a field of the detail panel: a bordered plate whose height follows the text and whose edge turns primary while the editor has focus,
 * with the editor's toolbar on top. The editor itself is the design system's, laid out for a panel through its own custom properties.
 */
export function MarkdownPlate({ isBounded, className, ...props }: MarkdownPlateProps) {
    return (
        <div className={styles.plate} data-bounded={isBounded || undefined}>
            <MarkdownEditor {...props} className={cn(styles.editor, className)} />
        </div>
    );
}
