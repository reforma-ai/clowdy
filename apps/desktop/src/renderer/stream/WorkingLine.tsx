import { ProgressLoader } from '@clowdy/icons/assets';
import { cn } from '@clowdy/lib';

import styles from './ToolCard.module.css';
import { describeTool } from './toolView';

import type { StreamItemBody } from '@clowdy/protocol';

/** The progress loader and the latest hidden tool, or the run's status when there is no tool to preview. */
export function WorkingLine({
    text = 'Working…',
    tool,
}: {
    text?: string;
    tool?: Extract<StreamItemBody, { kind: 'tool' }>;
}) {
    const view = tool && describeTool(tool.name, tool.input);
    const label = view ? view.verb || 'Running command' : text;

    return (
        <div className={styles.root} role="status" aria-label={view?.target ? `${label} ${view.target}` : label}>
            <div className={styles.header} style={{ cursor: 'default' }}>
                <span className={styles.icon}>
                    <ProgressLoader size={14} aria-hidden />
                </span>
                <span className={cn(styles.label, styles.shrinks)}>{label}</span>
                {view?.target && <code className={styles.chip}>{view.target}</code>}
            </div>
        </div>
    );
}
