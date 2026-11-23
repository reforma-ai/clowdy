import { CodeBraces } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import Anser from 'anser';
import { createContext, useMemo } from 'react';
import { type ContextValue, Provider, SlotProps, useContextProps } from 'react-aria-components';

import { Box, type BoxProps } from '../Box';
import { Button } from '../Button';
import { Scrollable } from '../Scrollable';
import { useSlotContextProps } from '../Slot';
import styles from './Terminal.module.css';

import type { ComponentProps, HTMLAttributes, ReactNode, Ref } from 'react';

/** Terminal stdout/state passed via {@link Terminal} or {@link TerminalContext} (RAC `Provider`). */
export type TerminalStateProps = SlotProps & {
    output?: string;
    isStreaming?: boolean;
    autoScroll?: boolean;
};

export const TerminalContext = createContext<ContextValue<TerminalStateProps, HTMLDivElement>>({});

export type TerminalHeaderProps = HTMLAttributes<HTMLDivElement>;

export function TerminalHeader({ className, children, ...props }: TerminalHeaderProps) {
    return (
        <div {...props} className={cn(styles.header, className)}>
            {children}
        </div>
    );
}

export type TerminalTitleProps = HTMLAttributes<HTMLDivElement>;

export function TerminalTitle({ className, children, ...props }: TerminalTitleProps) {
    return (
        <div {...props} className={cn(styles.title, className)}>
            <CodeBraces aria-hidden className={styles.titleIcon} />
            {children ?? 'Terminal'}
        </div>
    );
}

export type TerminalStatusProps = HTMLAttributes<HTMLDivElement> & Pick<TerminalStateProps, 'isStreaming' | 'slot'>;

export function TerminalStatus(props: TerminalStatusProps) {
    const slotMerged = useSlotContextProps(props);
    const [merged] = useContextProps(slotMerged, undefined, TerminalContext);
    const isStreaming = merged.isStreaming ?? false;

    if (!isStreaming) {
        return null;
    }

    const {
        className,
        children,
        isStreaming: _isStreaming,
        slot: _slot,
        output: _output,
        autoScroll: _autoScroll,
        ref: _ref,
        ...rest
    } = merged as TerminalStatusProps & TerminalStateProps & { ref?: Ref<HTMLDivElement | null> };

    return (
        <div {...rest} className={cn(styles.status, className)}>
            {children ?? 'Running…'}
        </div>
    );
}

export type TerminalActionsProps = BoxProps;

export function TerminalActions({ className, children, ...props }: TerminalActionsProps) {
    return (
        <Box align="center" direction="row" gap="xs" {...props} className={className}>
            {children}
        </Box>
    );
}

export type TerminalActionButtonProps = ComponentProps<typeof Button>;

export function TerminalActionButton({ children, className, ...props }: TerminalActionButtonProps) {
    return (
        <Button className={className} iconOnly size="sm" variant="filling" {...props}>
            {children}
        </Button>
    );
}

export type TerminalContentProps = Omit<HTMLAttributes<HTMLDivElement>, 'onScroll'> &
    TerminalStateProps & {
        ref?: Ref<HTMLDivElement | null>;
        children?: ReactNode;
        overlay?: ReactNode;
        onScroll?: (e: Event) => void;
    };

export function TerminalContent(props: TerminalContentProps) {
    const slotMerged = useSlotContextProps(props);
    const [merged, mergedRef] = useContextProps(slotMerged, slotMerged.ref, TerminalContext);

    const output = merged.output ?? '';
    const isStreaming = merged.isStreaming ?? false;
    const autoScroll = merged.autoScroll ?? true;
    // Anser: escape `& < >` before converting ANSI so stdout that looks like HTML stays text (see README).
    const html = useMemo(() => Anser.ansiToHtml(Anser.escapeForHtml(output)), [output]);

    const {
        children,
        className,
        output: _output,
        isStreaming: _isStreaming,
        autoScroll: _autoScroll,
        ref: _ref,
        overlay,
        ...scrollProps
    } = merged;

    return (
        <Scrollable
            vertical
            horizontal
            ref={mergedRef}
            className={cn(styles.scroll, className)}
            overlay={overlay}
            stickToBottom={autoScroll}
            {...scrollProps}
        >
            {children ?? (
                <pre className={styles.pre}>
                    {/* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- output is escaped before Anser adds color spans */}
                    <span dangerouslySetInnerHTML={{ __html: html }} />
                    {isStreaming && <span aria-hidden className={styles.cursor} />}
                </pre>
            )}
        </Scrollable>
    );
}

export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
    output: string;
    isStreaming?: boolean;
    autoScroll?: boolean;
    /** Shown in the default header (`TerminalTitle`). Ignored if you pass `children`. */
    title?: ReactNode;
};

export function Terminal({
    output,
    isStreaming = false,
    autoScroll = true,
    title,
    className,
    children,
    ...props
}: TerminalProps) {
    const terminalValues = useMemo(() => ({ autoScroll, isStreaming, output }), [autoScroll, isStreaming, output]);

    return (
        <Provider values={[[TerminalContext, terminalValues]]}>
            <div {...props} className={cn(styles.root, className)}>
                {children ?? (
                    <>
                        <TerminalHeader>
                            <TerminalTitle>{title}</TerminalTitle>
                        </TerminalHeader>
                        <TerminalContent />
                    </>
                )}
            </div>
        </Provider>
    );
}
