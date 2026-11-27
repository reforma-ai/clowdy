import { Close as CloseIcon } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { useSyncExternalStore } from 'react';
import {
    UNSTABLE_Toast as AriaToast,
    UNSTABLE_ToastContent as AriaToastContent,
    UNSTABLE_ToastQueue as AriaToastQueue,
    UNSTABLE_ToastRegion as AriaToastRegion,
    Text,
    ToastProps,
} from 'react-aria-components';

import { Button } from '../Button';
import { ProgressBar } from '../ProgressBar';
import { Show } from '../Show';
import styles from './Toast.module.css';

/** Options for toast.show / toast.error / toast.success / toast.info / toast.warning */
export type ToastOptions = {
    title?: string;
    message?: string;
    type?: 'default' | 'info' | 'warning' | 'success' | 'error';
    timeout?: number;
    progress?: ToastProgress;
    /** A button under the message. Pressing it runs `onPress` and closes the toast. */
    action?: { label: string; onPress: () => void };
    /** Dark on a light page, light on a dark page. On unless set to false. */
    contrast?: boolean;
};

interface ToastProgress {
    total: number;
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => number;
}

function ToastProgressContent({ progress, title }: { progress: ToastProgress; title?: string }) {
    const value = useSyncExternalStore(progress.subscribe, progress.getSnapshot);
    return (
        <>
            <Text slot="description">
                {value} of {progress.total} processed
            </Text>
            <ProgressBar
                className={styles.progress}
                aria-label={title ?? 'Progress'}
                value={value}
                maxValue={progress.total}
            />
        </>
    );
}

const queue = new AriaToastQueue<ToastOptions>();

export function Toast(props: ToastProps<ToastOptions>) {
    return <AriaToast {...props} className={cn(styles.toast, props.className)} />;
}

export function ToastRegion() {
    return (
        <AriaToastRegion queue={queue} className={styles.region}>
            {({ toast: t }) => (
                <Toast
                    toast={t}
                    data-type={t.content.type ?? 'default'}
                    data-contrast={t.content.contrast === false ? 'false' : undefined}
                >
                    <div className={styles.body}>
                        <div className={styles.line} aria-hidden />
                        <div className={styles.content}>
                            <AriaToastContent>
                                <Show when={t.content.title != null}>
                                    <Text slot="title">{t.content.title}</Text>
                                </Show>

                                <Show when={t.content.message != null}>
                                    <Text slot="description">{t.content.message}</Text>
                                </Show>
                                {t.content.progress && (
                                    <ToastProgressContent progress={t.content.progress} title={t.content.title} />
                                )}
                            </AriaToastContent>
                        </div>
                    </div>

                    <Button
                        iconOnly
                        slot="close"
                        aria-label="Close"
                        variant="filling"
                        color="secondary"
                        size="sm"
                        className={styles.close}
                    >
                        <CloseIcon />
                    </Button>

                    <Show when={t.content.action != null}>
                        <Button
                            color="primary"
                            fullWidth
                            className={styles.action}
                            onPress={() => {
                                t.content.action?.onPress();
                                queue.close(t.key);
                            }}
                        >
                            {t.content.action?.label}
                        </Button>
                    </Show>
                </Toast>
            )}
        </AriaToastRegion>
    );
}

/** Simple imperative API: toast.show / .error / .success / .info / .warning */
export const toast = {
    queue,
    /** Persistent toast with a progress bar. Closing it does not cancel the operation. */
    progress: ({ title, total }: { title: string; total: number }) => {
        let value = 0;
        const listeners = new Set<() => void>();
        const key = queue.add({
            title,
            type: 'info',
            progress: {
                total,
                subscribe: listener => {
                    listeners.add(listener);
                    return () => void listeners.delete(listener);
                },
                getSnapshot: () => value,
            },
        });
        return {
            update: (next: number) => {
                value = next;
                for (const listener of listeners) listener();
            },
            close: () => queue.close(key),
        };
    },
    show: (options: ToastOptions) =>
        queue.add({ ...options, type: options.type ?? 'default' }, { timeout: options.timeout ?? 3000 }),
    success: (options: ToastOptions) =>
        queue.add({ ...options, type: 'success' }, { timeout: options.timeout ?? 3000 }),
    error: (options: ToastOptions) => queue.add({ ...options, type: 'error' }, { timeout: options.timeout ?? 5000 }),
    info: (options: ToastOptions) => queue.add({ ...options, type: 'info' }, { timeout: options.timeout ?? 3000 }),
    warning: (options: ToastOptions) =>
        queue.add({ ...options, type: 'warning' }, { timeout: options.timeout ?? 3000 }),
};
