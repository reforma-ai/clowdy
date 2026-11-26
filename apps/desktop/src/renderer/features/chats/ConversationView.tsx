import { Alert, AlertAction, AlertDescription, AlertIcon } from '@clowdy/components/Alert';
import { Button } from '@clowdy/components/Button';
import { ContentColumn } from '@clowdy/components/ContentColumn';
import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { AttentionCircle } from '@clowdy/icons/14';
import { shownRunStatus } from '@clowdy/protocol';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useRootStore } from '../../stores';
import { StreamView, type StreamViewHandle, type StreamViewProps } from '../../stream';
import styles from './ConversationView.module.css';
import { isRunActive, liveLine } from './chatRun';
import { perform } from './commands';

import type { Run, StreamItem } from '@clowdy/protocol';
import type { ReactNode, Ref } from 'react';
import type { RunStream } from '../../stores';
import type { ConversationLinks } from './useStreamLinks';

const NO_ITEMS: StreamItem[] = [];

export interface ConversationViewProps
    extends Pick<
        StreamViewProps,
        'scrollMemory' | 'messageActions' | 'editing' | 'forkedFrom' | 'emptyState' | 'errorAction' | 'dockedQuestionId'
    > {
    /** The run the page shows: a chat's orchestrator (none before the first message), or a native sub-agent. */
    run: Run | undefined;
    /** The run's stream, read by the page that holds this one (it needs the items too). None until the first message starts the run. */
    stream: RunStream | undefined;
    /** What the text may point at (`useStreamLinks`), read by the page that holds this one, which opens chats and reads files with it too. */
    links: ConversationLinks;
    /** An item drawn before the stream's own: what the page makes of what it knows (a sub-agent's page, the prompt of the call that started it). It is not stored and not part of the stream. */
    leading?: StreamItem;
    /** The page waits for what its leading item is made from: the stream is not drawn yet and the page says it is loading, so the item does not appear above what the person has begun to read. */
    holding?: boolean;
    /** Over the stream: the header that says where the conversation is, `ConversationHeader`. */
    top?: ReactNode;
    /** Over the stream's bottom, above the box: the plates that tell what the chat is doing (its agents, its last run, its tasks). */
    banners?: ReactNode;
    /** The box at the bottom of the page: the message box, the notice that stands in its place, or the disabled box of a sub-agent. */
    bottom: ReactNode;
    /**
     * What the stream ends with while the run rests for its background work. A chat leaves it out, since the work's row above its box and the box's loader say it; a page with no such row
     * (a sub-agent's) says it here.
     */
    backgroundLine?: string;
    ref?: Ref<StreamViewHandle>;
}

/**
 * One conversation: a run's stream with its loading, failure and empty states, the answers to its questions and the decisions on its requests for permission,
 * the live line while the run works, and over the stream's bottom the banners and the box, which the stream scrolls behind. A chat, a thread and a native
 * sub-agent all open on it, with the same header over the stream (`top`); they differ in the plates above the box (`banners`) and the box itself (`bottom`).
 */
export function ConversationView({
    run,
    stream,
    links,
    leading,
    holding = false,
    top,
    banners,
    bottom,
    backgroundLine,
    ref,
    ...streamProps
}: ConversationViewProps) {
    const root = useRootStore();
    const overlay = useRef<HTMLDivElement>(null);
    const overlayContent = useRef<HTMLDivElement>(null);
    const bannerStack = useRef<HTMLDivElement>(null);
    const overlayAtBottom = useRef(true);
    const [composerInset, setComposerInset] = useState<number>();
    const [composerSurfaceInset, setComposerSurfaceInset] = useState(0);
    const measureOverlay = useCallback(() => {
        const element = overlay.current;
        const stack = bannerStack.current;

        if (!element || !stack) return;
        const bounds = element.getBoundingClientRect();

        setComposerInset(bounds.height);
        setComposerSurfaceInset(bounds.bottom - stack.getBoundingClientRect().bottom);
    }, []);
    useLayoutEffect(() => {
        const element = overlay.current;

        if (!element) return;
        const measure = () => {
            if (overlayAtBottom.current) element.scrollTop = element.scrollHeight;
            measureOverlay();
        };
        const observer = new ResizeObserver(measure);

        measure();
        observer.observe(element, { box: 'border-box' });
        if (overlayContent.current) observer.observe(overlayContent.current);
        if (bannerStack.current) observer.observe(bannerStack.current);

        return () => observer.disconnect();
    }, [measureOverlay]);

    // A stream that is read again (the app resyncs) keeps what it shows until the new items replace them, so the page keeps its place; only one with nothing to show says it is loading.
    const streamItems = stream?.items ?? NO_ITEMS;
    const hasItems = streamItems.length > 0;
    const items = useMemo(() => (leading ? [leading, ...streamItems] : streamItems), [leading, streamItems]);
    const shown = run && shownRunStatus(run);
    // The live line follows what the person reads of the run: none while a card waits for them.
    const working =
        isRunActive(run) &&
        shown !== undefined &&
        (shown === 'waiting_background' && backgroundLine ? backgroundLine : liveLine(shown, run.statusReason));

    return (
        <div className={styles.page}>
            {top}

            {stream?.status === 'failed' && (
                <div className={styles.center}>
                    <Alert color="danger" className={styles.alert}>
                        <AlertIcon>
                            <AttentionCircle />
                        </AlertIcon>
                        <AlertDescription>{`The messages could not be loaded. ${stream.error}`}</AlertDescription>
                        <AlertAction>
                            <Button size="sm" variant="bordered" onPress={() => void stream.reload()}>
                                Retry
                            </Button>
                        </AlertAction>
                    </Alert>
                </div>
            )}

            {((stream && (stream.status === 'idle' || stream.status === 'loading') && !hasItems) || holding) && (
                <div className={styles.center}>
                    <Loader size="xs" />
                    <Text color="secondary">Loading messages…</Text>
                </div>
            )}

            {composerInset !== undefined &&
                !holding &&
                (!stream || stream.status === 'ready' || (stream.status === 'loading' && hasItems)) && (
                    <StreamView
                        {...streamProps}
                        ref={ref}
                        composerInset={composerInset}
                        composerSurfaceInset={composerSurfaceInset}
                        items={items}
                        active={isRunActive(run)}
                        working={working}
                        links={links}
                        // A question the run no longer waits on (stopped, interrupted) is shown but cannot be answered.
                        onAnswer={
                            run?.status === 'waiting_user'
                                ? async (questionId, answer) => {
                                      await perform(root, { type: 'run.answer', runId: run.id, questionId, answer });
                                  }
                                : undefined
                        }
                        // A request for permission is decided while its own item is open, whatever the run is doing, so the card gates itself and the handler only needs a run to name.
                        onDecide={
                            run
                                ? async (approvalId, decision) => {
                                      await perform(root, { type: 'run.decide', runId: run.id, approvalId, decision });
                                  }
                                : undefined
                        }
                    />
                )}

            <ContentColumn
                ref={overlay}
                className={styles.overlay}
                onScroll={event => {
                    const element = event.currentTarget;
                    overlayAtBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 2;
                    measureOverlay();
                }}
            >
                <div ref={overlayContent}>
                    <div ref={bannerStack}>{banners}</div>
                    {bottom}
                </div>
            </ContentColumn>
        </div>
    );
}
