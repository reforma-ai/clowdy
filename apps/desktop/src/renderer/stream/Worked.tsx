import { Button } from '@clowdy/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsible } from '@clowdy/components/Collapsible';
import { Shimmer } from '@clowdy/components/Shimmer';
import { Show } from '@clowdy/components/Show';
import { ChevronDown } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';

import styles from './Worked.module.css';

import type { ReactNode } from 'react';

function WorkedTrigger({ label, shimmer }: { label: string; shimmer?: boolean }) {
    const { state } = useCollapsible();

    return (
        <CollapsibleTrigger asChild>
            <Button type="button" variant="inline" color="secondary" className={ styles.trigger }>
                { shimmer ? <Shimmer as="span" duration={ 1 }>{ label }</Shimmer> : label }
                <ChevronDown className={ cn('chevron', 'next') } aria-expanded={ state.isExpanded } aria-hidden />
            </Button>
        </CollapsibleTrigger>
    );
}

/** The closed panel stays out of the page, so a long fold costs nothing until it is opened. */
function WorkedPanel({ children }: { children: ReactNode }) {
    const { state } = useCollapsible();

    return (
        <Show when={ state.isExpanded }>
            <CollapsibleContent className={ styles.panel }>{ children }</CollapsibleContent>
        </Show>
    );
}

export interface WorkedProps {
    /** "Worked for 2m 5s". */
    label: string;
    /** What was done, drawn the way the stream draws it when it is open. */
    children: ReactNode;
    /** Open or closed, when the caller decides it (`ToolGroup` opens while its calls run); left out, the line starts closed and the person opens it. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** The label shimmers: what it tells is still going on. */
    shimmer?: boolean;
}

/** The work of a finished turn behind one line; the answer it led to stays outside. A run of tool calls is folded the same way (`ToolGroup`). */
export function Worked({ label, children, open, onOpenChange, shimmer }: WorkedProps) {
    return (
        <Collapsible className={ styles.worked } defaultOpen={ false } open={ open } onOpenChange={ onOpenChange }>
            <WorkedTrigger label={ label } shimmer={ shimmer } />
            <WorkedPanel>{ children }</WorkedPanel>
        </Collapsible>
    );
}
