import { Text } from '@clowdy/components/Text';
import { ChevronDown, ChevronRight } from '@clowdy/icons/8';
import { isTerminalRunStatus } from '@clowdy/protocol';

import { RunStatusPill } from '../../shared/RunStatusPill';
import { StatusDot } from '../../shared/StatusDot';
import { TaskChip } from '../../shared/TaskChip';
import { describeRun, type TreeRow } from './agentTree';
import styles from './RunRow.module.css';

import type { Task } from '@clowdy/protocol';

export interface RunRowProps {
    row: TreeRow;
    /** The tasks the run is linked to. */
    tasks: Task[];
    activeChildCount: number;
    isSelected: boolean;
    /** The one row of the tree that takes the Tab key. */
    isTabStop: boolean;
    onSelect: () => void;
    onToggle: () => void;
}

/** One run of the tree: status dot, name, status pill, what it is doing, why it waits, and its tasks. */
export function RunRow({ row, tasks, activeChildCount, isSelected, isTabStop, onSelect, onToggle }: RunRowProps) {
    const { run, depth, childCount, isExpanded, guides } = row;
    const note = describeRun(run, activeChildCount);
    const isParent = childCount > 0;

    return (
        <div
            role="treeitem"
            className={ styles.row }
            data-run-id={ run.id }
            data-selected={ isSelected || undefined }
            data-finished={ isTerminalRunStatus(run.status) || undefined }
            aria-level={ depth + 1 }
            aria-selected={ isSelected }
            aria-expanded={ isParent ? isExpanded : undefined }
            tabIndex={ isTabStop ? 0 : -1 }
            onClick={ onSelect }
        >
            { guides.map((goesOn, level) => (
                // The last guide joins the row to its parent; the ones before carry the connectors of the levels above.
                <span key={ level } className={ styles.guide } data-elbow={ level === depth - 1 || undefined } data-goes-on={ goesOn || undefined } data-parent={ isParent || undefined } />
            )) }

            <span className={ styles.chevronSlot }>
                { isParent && (
                    <button
                        type="button"
                        tabIndex={ -1 }
                        className={ styles.chevron }
                        aria-label={ isExpanded ? `Collapse ${ run.name }` : `Expand ${ run.name }` }
                        onClick={ (event) => {
                            event.stopPropagation();
                            onToggle();
                        } }
                    >
                        { isExpanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden /> }
                    </button>
                ) }
            </span>

            <StatusDot status={ run.status } className={ styles.dot } />

            <div className={ styles.body }>
                <div className={ styles.titleLine }>
                    <Text bold truncate className={ styles.name }>{ run.name }</Text>
                    <RunStatusPill status={ run.status } reason={ run.statusReason } plain />
                </div>

                { run.summary && <Text variant="sm" color="secondary" truncate>{ run.summary }</Text> }

                { note && <span className={ styles.note } data-tone={ note.tone } title={ note.text }>{ note.text }</span> }

                { tasks.length > 0 && (
                    // A chip opens its task; it must not also select the row.
                    <div className={ styles.chips } onClick={ event => event.stopPropagation() }>
                        { tasks.map(task => <TaskChip key={ task.id } task={ task } />) }
                    </div>
                ) }
            </div>
        </div>
    );
}
