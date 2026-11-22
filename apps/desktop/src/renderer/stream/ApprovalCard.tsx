import { Button } from '@clowdy/components/Button';
import { Text } from '@clowdy/components/Text';
import { Check, Close, Page, Terminal, Tool } from '@clowdy/icons/14';
import { Fragment, useState } from 'react';

import styles from './ApprovalCard.module.css';

import type { ApprovalDecision, ApprovalSubject, StreamItemBody } from '@clowdy/protocol';
import type { ComponentType, SVGProps } from 'react';

type ApprovalBody = Extract<StreamItemBody, { kind: 'approval' }>;

export interface ApprovalCardProps {
    approval: ApprovalBody;
    /** Called with the person's decision. Without it the card is read-only; so is one whose `state` is not `open`, whatever the run is doing. */
    onDecide?: (decision: ApprovalDecision) => void | Promise<void>;
}

/** A command longer than this is cut, with a line that opens the rest. */
const CLIP_LINES = 4;

/** Deny stands at the left of the row, the lasting answer beside the main one, which is the button that says yes once. */
const BUTTONS: readonly { decision: ApprovalDecision; label: string; variant: 'ghost' | 'bordered' | 'filled'; color: 'secondary' | 'primary' }[] = [
    { decision: 'reject', label: 'Deny', variant: 'ghost', color: 'secondary' },
    { decision: 'allow_always', label: 'Allow for session', variant: 'bordered', color: 'secondary' },
    { decision: 'allow_once', label: 'Allow once', variant: 'filled', color: 'primary' },
];

const OUTCOMES: Record<ApprovalDecision, string> = {
    allow_once: 'Allowed once',
    allow_always: 'Allowed for the session',
    reject: 'Denied',
};

const SUBJECT_ICONS: Record<ApprovalSubject['kind'], ComponentType<SVGProps<SVGSVGElement>>> = {
    command: Terminal,
    file_change: Page,
    tool_use: Tool,
};

/** What is asked, in one phrase. */
function headingOf(subject: ApprovalSubject): string {
    switch (subject.kind) {
        case 'command':
            return 'Run this command';
        case 'file_change':
            return subject.paths.length === 1 ? 'Change this file' : 'Change these files';
        case 'tool_use':
            return `Use ${ subject.tool }`;
    }
}

/** The command as a shell shows it: `$` and the text, cut at four lines until the person asks for the rest. */
function CommandBlock({ command, cwd }: { command: string; cwd?: string }) {
    const [showsAll, setShowsAll] = useState(false);
    const lines = command.split('\n');
    const hidden = Math.max(0, lines.length - CLIP_LINES);
    const visible = showsAll || hidden === 0 ? command : lines.slice(0, CLIP_LINES).join('\n');

    return (
        <div className={ styles.block }>
            <pre className={ styles.code }>{ `$ ${ visible }` }</pre>

            { hidden > 0 && (
                <Button type="button" variant="inline" color="secondary" size="sm" className={ styles.more } aria-expanded={ showsAll } onPress={ () => setShowsAll(value => !value) }>
                    { showsAll ? 'Show less' : hidden === 1 ? 'Show 1 more line' : `Show ${ hidden } more lines` }
                </Button>
            ) }

            { cwd && <Text variant="xs" color="secondary" className={ styles.cwd }>{ cwd }</Text> }
        </div>
    );
}

/** A path may break after any of its slashes, so a deep one wraps instead of pushing the card wider. */
function PathLine({ path }: { path: string }) {
    return (
        <li className={ styles.path }>
            { path.split(/(\/)/).map((part, index) => (
                <Fragment key={ index }>
                    { part }
                    { part === '/' && <wbr /> }
                </Fragment>
            )) }
        </li>
    );
}

function Subject({ subject, title }: { subject: ApprovalSubject; title: string }) {
    switch (subject.kind) {
        case 'command':
            return <CommandBlock command={ subject.command } cwd={ subject.cwd } />;
        case 'file_change':
            return <ul className={ styles.paths } aria-label="Files">{ subject.paths.map(path => <PathLine key={ path } path={ path } />) }</ul>;
        case 'tool_use': {
            // What the agent calls the request says more than the tool's name when it differs from it.
            const detail = subject.detail ?? (title !== subject.tool ? title : undefined);

            return detail ? <Text variant="sm" color="secondary" className={ styles.detail }>{ detail }</Text> : null;
        }
    }
}

/** The line under a request that is not open: what became of it. */
function Outcome({ approval }: { approval: ApprovalBody }) {
    const { state, decision } = approval;

    if (state === 'decided' && decision) {
        const allowed = decision !== 'reject';

        return (
            <div className={ styles.outcome } data-tone={ allowed ? 'allowed' : 'denied' }>
                { allowed ? <Check aria-hidden /> : <Close aria-hidden /> }
                <Text color={ allowed ? undefined : 'secondary' }>{ OUTCOMES[decision] }</Text>
            </div>
        );
    }

    return (
        <div className={ styles.outcome }>
            <Text color="secondary">{ state === 'expired' ? 'Expired' : 'Cancelled' }</Text>
        </div>
    );
}

/**
 * A request of the agent for permission to do something, in the stream after the call it is about: what it wants (a command, files, a tool) and the
 * answers the agent's options allow, as Deny, Allow for session and Allow once. The buttons belong to the item's own `state`, not to the run's: a request
 * that waits keeps them, whatever the run is doing, and an answered, withdrawn or expired one keeps what was asked and says what became of it.
 */
export function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
    const { subject, title, decisions, state } = approval;
    const [pending, setPending] = useState<ApprovalDecision | null>(null);
    const Icon = SUBJECT_ICONS[subject.kind];
    const isOpen = state === 'open';

    const decide = async (decision: ApprovalDecision) => {
        if (!onDecide || pending) return;

        setPending(decision);

        try {
            // A refusal is shown by the caller, and the card stays open for another try.
            await onDecide(decision);
        }
        finally {
            setPending(null);
        }
    };

    return (
        <section className={ styles.card } data-settled={ isOpen ? undefined : '' } aria-label={ headingOf(subject) }>
            <div className={ styles.heading }>
                <Icon className={ styles.headingIcon } aria-hidden />
                <Text weight="medium">{ headingOf(subject) }</Text>
            </div>

            <Subject subject={ subject } title={ title } />

            { !isOpen && <Outcome approval={ approval } /> }

            { isOpen && !onDecide && <Text color="secondary">Waiting for an answer</Text> }

            { isOpen && onDecide && (
                <div className={ styles.actions }>
                    { BUTTONS.filter(({ decision }) => decisions.includes(decision)).map(({ decision, label, variant, color }) => (
                        <Button
                            key={ decision }
                            type="button"
                            size="sm"
                            variant={ variant }
                            color={ color }
                            className={ decision === 'reject' ? styles.deny : undefined }
                            isPending={ pending === decision }
                            isDisabled={ pending !== null && pending !== decision }
                            onPress={ () => void decide(decision) }
                        >
                            { label }
                        </Button>
                    )) }
                </div>
            ) }
        </section>
    );
}
