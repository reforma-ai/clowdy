import { Button } from '@clowdy/components/Button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, useCollapsible } from '@clowdy/components/Collapsible';
import { Show } from '@clowdy/components/Show';
import { ChevronDown } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';

import styles from './Worked.module.css';

import type { ReactNode } from 'react';

function WorkedTrigger({ label }: { label: string }) {
    const { state } = useCollapsible();

    return (
        <CollapsibleTrigger asChild>
            <Button type="button" variant="inline" color="secondary" className={ styles.trigger }>
                { label }
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
}

/** The work of a finished turn behind one line; the answer it led to stays outside. */
export function Worked({ label, children }: WorkedProps) {
    return (
        <Collapsible className={ styles.worked } defaultOpen={ false }>
            <WorkedTrigger label={ label } />
            <WorkedPanel>{ children }</WorkedPanel>
        </Collapsible>
    );
}
