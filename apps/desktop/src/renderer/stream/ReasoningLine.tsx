import {
    Collapsible,
    CollapsibleMotionContent,
    CollapsibleTrigger,
    useCollapsible,
} from '@clowdy/components/Collapsible';
import { Shimmer } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';
import { ChevronDown } from '@clowdy/icons/8';
import { Brain } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';

import { Markdown } from './Markdown';
import styles from './ReasoningLine.module.css';
import { thoughtLabel } from './reasoning';
import tool from './ToolCard.module.css';

import type { StreamItemBody } from '@clowdy/protocol';

type ReasoningBody = Extract<StreamItemBody, { kind: 'reasoning' }>;

function Header({ body }: { body: ReasoningBody }) {
    const { state } = useCollapsible();
    const label = thoughtLabel(body.done, body.durationMs);

    return (
        <CollapsibleTrigger as="button" className={tool.header}>
            <span className={tool.icon} aria-hidden>
                <Brain />
            </span>
            {body.done ? (
                <Text color="secondary" className={tool.label}>
                    {label}
                </Text>
            ) : (
                <Shimmer as="span" className={tool.label} duration={1}>
                    {label}
                </Shimmer>
            )}
            <ChevronDown className={cn('chevron', 'next', tool.chevron)} aria-expanded={state.isExpanded} aria-hidden />
        </CollapsibleTrigger>
    );
}

export interface ReasoningLineProps {
    body: ReasoningBody;
}

/**
 * What the agent thought, as a line of the turn in the frame of a tool call: `Thought 3s` (`Thinking…` while it goes on), and a press opens the words,
 * Markdown as the agent wrote it. It is the work behind the answer, so it is closed until the person asks.
 */
export function ReasoningLine({ body }: ReasoningLineProps) {
    return (
        <Collapsible className={tool.root} data-state={body.done ? 'done' : 'running'}>
            <Header body={body} />
            <CollapsibleMotionContent className={tool.collapse}>
                <div className={cn(tool.content, styles.text)}>
                    <Markdown text={body.text} streaming={!body.done} />
                </div>
            </CollapsibleMotionContent>
        </Collapsible>
    );
}
