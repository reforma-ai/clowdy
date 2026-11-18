import { Collapsible, CollapsibleMotionContent, CollapsibleTrigger, useCollapsible } from '@clowdy/components/Collapsible';
import { Shimmer } from '@clowdy/components/Shimmer';
import { Text } from '@clowdy/components/Text';
import { Tooltip } from '@clowdy/components/Tooltip';
import { CodeBraces, Page, Search, Terminal, Tool } from '@clowdy/icons/14';
import { ChevronDown } from '@clowdy/icons/8';
import { cn } from '@clowdy/lib';

import styles from './ToolCard.module.css';
import { describeTool, type ToolIcon } from './toolView';

import type { StreamItemBody } from '@clowdy/protocol';
import type { ComponentType, SVGProps } from 'react';

type ToolBody = Extract<StreamItemBody, { kind: 'tool' }>;

const ICONS: Record<ToolIcon, ComponentType<SVGProps<SVGSVGElement>>> = {
    file: Page,
    search: Search,
    code: CodeBraces,
    terminal: Terminal,
    tool: Tool,
};

/** Beyond this a payload is cut: a stream should stay light, and nobody reads past it in a card. */
const MAX_PAYLOAD_CHARS = 20_000;

function payloadText(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';

    return text.length > MAX_PAYLOAD_CHARS ? `${ text.slice(0, MAX_PAYLOAD_CHARS) }\n… ${ text.length - MAX_PAYLOAD_CHARS } more characters` : text;
}

function Section({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
    return (
        <div className={ styles.section }>
            <Text variant="xs" color="secondary" transform="uppercase">{ label }</Text>
            <pre className={ styles.pre } data-danger={ danger || undefined }>{ text }</pre>
        </div>
    );
}

/** What the call is called: shimmering while it runs, struck through with the reason on hover when it failed. */
function Title({ verb, state, reason }: { verb: string; state: ToolBody['state']; reason?: string }) {
    if (!verb) return null;

    if (state === 'running') return <Shimmer as="span" className={ styles.label } duration={ 1 }>{ verb }</Shimmer>;

    if (state === 'error') {
        return (
            <Tooltip content={ reason?.trim() || 'This action failed' } wrapTrigger>
                <Text decoration="line-through" color="secondary" className={ styles.label }>{ verb }</Text>
            </Tooltip>
        );
    }

    return <Text className={ styles.label }>{ verb }</Text>;
}

function Header({ call }: { call: ToolBody }) {
    const { state } = useCollapsible();
    const view = describeTool(call.name, call.input, call.output);
    const Icon = ICONS[view.icon];

    return (
        <CollapsibleTrigger as="button" className={ styles.header }>
            <span className={ cn(styles.icon, call.state === 'error' && styles.failedIcon) } aria-hidden><Icon /></span>
            <Title verb={ view.verb } state={ call.state } reason={ call.error } />
            { view.target && <code className={ styles.chip }>{ view.target }</code> }
            { view.diff && (
                <span className={ styles.diff }>
                    <span className={ styles.added }>{ `+${ view.diff.added }` }</span>
                    <span className={ styles.removed }>{ `−${ view.diff.removed }` }</span>
                </span>
            ) }
            <ChevronDown className={ cn('chevron', 'next', styles.chevron) } aria-expanded={ state.isExpanded } aria-hidden />
        </CollapsibleTrigger>
    );
}

export interface ToolCardProps {
    call: ToolBody;
}

/**
 * One tool call as a line of the turn: its icon and what it does, joined to the next call by a thin rule. Opening it
 * shows the input and output. Every tool looks the same for now; a tool that deserves its own view gets one later.
 */
export function ToolCard({ call }: ToolCardProps) {
    const hasOutput = call.output !== undefined && call.output !== '';

    return (
        <Collapsible className={ styles.root } data-state={ call.state }>
            <Header call={ call } />
            <CollapsibleMotionContent className={ styles.collapse }>
                <div className={ styles.content }>
                    <Section label="Input" text={ payloadText(call.input) } />
                    { hasOutput && <Section label="Output" text={ payloadText(call.output) } /> }
                    { call.error && <Section label="Error" text={ call.error } danger /> }
                </div>
            </CollapsibleMotionContent>
        </Collapsible>
    );
}
