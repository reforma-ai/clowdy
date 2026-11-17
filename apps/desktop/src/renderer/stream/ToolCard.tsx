import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle, Check, ChevronDown, CodeBraces, Page, Search, Terminal, Tool } from '@clowdy/icons/14';
import { useState, type ComponentType, type SVGProps } from 'react';

import styles from './ToolCard.module.css';
import { describeTool, type ToolIcon } from './toolView';

import type { StreamItemBody } from '@clowdy/protocol';

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

export interface ToolCardProps {
    call: ToolBody;
}

/** One tool call: icon, a verb phrase with a code chip, its state, and on demand its input and output. */
export function ToolCard({ call }: ToolCardProps) {
    const [open, setOpen] = useState(false);
    const view = describeTool(call.name, call.input, call.output);
    const Icon = ICONS[view.icon];
    const hasOutput = call.output !== undefined && call.output !== '';

    return (
        <div className={ styles.card } data-state={ call.state } data-open={ open || undefined }>
            <button type="button" className={ styles.head } aria-expanded={ open } onClick={ () => setOpen(!open) }>
                <span className={ styles.icon }><Icon /></span>
                { view.verb && <Text className={ styles.verb }>{ view.verb }</Text> }
                { view.target && <code className={ styles.chip }>{ view.target }</code> }
                { view.diff && (
                    <span className={ styles.diff }>
                        <span className={ styles.added }>{ `+${ view.diff.added }` }</span>
                        <span className={ styles.removed }>{ `−${ view.diff.removed }` }</span>
                    </span>
                ) }
                <span className={ styles.state }>
                    { call.state === 'running' && <Spinner size="xs" /> }
                    { call.state === 'done' && <Check className={ styles.done } aria-label="Done" /> }
                    { call.state === 'error' && <><AttentionCircle className={ styles.failed } aria-hidden /><Text color="danger" variant="sm">Failed</Text></> }
                </span>
                <ChevronDown className={ styles.chevron } aria-hidden />
            </button>

            { open && (
                <div className={ styles.body }>
                    <Section label="Input" text={ payloadText(call.input) } />
                    { hasOutput && <Section label="Output" text={ payloadText(call.output) } /> }
                    { call.error && <Section label="Error" text={ call.error } danger /> }
                </div>
            ) }
        </div>
    );
}

function Section({ label, text, danger }: { label: string; text: string; danger?: boolean }) {
    return (
        <div className={ styles.section }>
            <Text variant="xs" color="secondary" transform="uppercase">{ label }</Text>
            <pre className={ styles.pre } data-danger={ danger || undefined }>{ text }</pre>
        </div>
    );
}
