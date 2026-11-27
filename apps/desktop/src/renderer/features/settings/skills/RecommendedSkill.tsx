import { Button } from '@clowdy/components/Button';
import { openConfirmModal } from '@clowdy/components/modals';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { useCallback, useEffect, useState } from 'react';

import { TransportError } from '../../../daemon/transport';
import { useRootStore } from '../../../stores';
import { SettingsBlock } from '../ui/SettingsBlock';
import { SettingsCard } from '../ui/SettingsCard';
import { SettingsSection } from '../ui/SettingsSection';
import styles from './RecommendedSkill.module.css';

type Status = import('@clowdy/protocol').BriefbackStatus;
type State =
    | { kind: 'loading' }
    | { kind: 'failed'; message?: string; installationError?: boolean }
    | { kind: 'ready'; status: Status; error?: string };

export function RecommendedSkill({ onInstalled, revision }: { onInstalled: () => void; revision: number }) {
    const { transport } = useRootStore();
    const [state, setState] = useState<State>({ kind: 'loading' });
    const [installing, setInstalling] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [updateAttempt, setUpdateAttempt] = useState(0);
    const [updateResult, setUpdateResult] = useState<{
        fingerprint: string;
        value: 'checking' | 'up-to-date' | 'update-available' | 'unknown';
    }>();

    const installed =
        state.kind === 'ready' && state.status.copies.length === 2 && state.status.copies.every(copy => copy.installed);
    const backups = state.kind === 'ready' ? state.status.backups : undefined;
    const needsRecovery = !!backups?.length;
    const unsupported = state.kind === 'ready' && backups === undefined;
    const fingerprint =
        installed && state.kind === 'ready' && !needsRecovery && !unsupported ? state.status.fingerprint : undefined;
    const update = updateResult && fingerprint === updateResult.fingerprint ? updateResult.value : 'checking';

    useEffect(() => {
        if (installing) return;
        let current = true;
        const refresh = () =>
            transport.getBriefbackStatus().then(
                status =>
                    current &&
                    setState(previous =>
                        previous.kind === 'ready' &&
                        previous.status.fingerprint === status.fingerprint &&
                        JSON.stringify(previous.status.backups) === JSON.stringify(status.backups)
                            ? previous
                            : {
                                  kind: 'ready',
                                  status,
                                  error:
                                      previous.kind === 'ready'
                                          ? previous.status.backups?.length && !status.backups?.length
                                              ? undefined
                                              : previous.error
                                          : previous.kind === 'failed' && previous.installationError
                                            ? previous.message
                                            : undefined,
                              }
                    ),
                error =>
                    current &&
                    setState(previous =>
                        previous.kind === 'ready' || (previous.kind === 'failed' && previous.installationError)
                            ? previous
                            : {
                                  kind: 'failed',
                                  message:
                                      error instanceof TransportError && error.status === 404
                                          ? 'After active work finishes, restart Clowdy to use Briefback installation'
                                          : "Couldn't check Briefback installation. Try again",
                              }
                    )
            );
        void refresh();
        // Missing skill roots have no watcher until they are created.
        const timer = setInterval(() => void refresh(), 10000);
        return () => {
            current = false;
            clearInterval(timer);
        };
    }, [transport, attempt, revision, installing]);

    useEffect(() => {
        if (!fingerprint) return;
        let current = true;
        setUpdateResult({ fingerprint, value: 'checking' });
        transport.checkBriefbackUpdate(fingerprint).then(
            value => current && setUpdateResult({ fingerprint, value }),
            () => current && setUpdateResult({ fingerprint, value: 'unknown' })
        );
        return () => {
            current = false;
        };
    }, [transport, fingerprint, updateAttempt]);

    const install = useCallback(() => {
        if (state.kind !== 'ready' || installing || !state.status.backups || state.status.backups.length) return;
        const { status } = state;
        openConfirmModal({
            title: installed ? 'Update Briefback' : 'Install Briefback',
            message: 'Briefback goes in ~/.agents/skills and ~/.claude/skills, replacing any copy already there',
            confirmLabel: installed ? 'Update' : 'Install',
            initialFocus: 'cancel',
            onConfirm: async () => {
                setInstalling(true);
                try {
                    const next = await transport.installBriefback(status.fingerprint);
                    setUpdateResult(undefined);
                    setUpdateAttempt(n => n + 1);
                    setState({ kind: 'ready', status: next });
                    onInstalled();
                } catch (error) {
                    const message =
                        error instanceof TransportError && error.status === 503
                            ? error.message
                            : "Couldn't install Briefback. Try again";
                    // The filesystem may have changed since confirmation; inspect it before allowing another attempt.
                    try {
                        const next = await transport.getBriefbackStatus();
                        setState({ kind: 'ready', status: next, error: message });
                    } catch {
                        setState({ kind: 'failed', message, installationError: true });
                    }
                } finally {
                    setInstalling(false);
                }
            },
        });
    }, [state, installing, installed, transport, onInstalled]);

    const partial = state.kind === 'ready' && state.status.copies.some(copy => copy.exists);
    const label =
        state.kind === 'loading'
            ? 'Checking…'
            : state.kind === 'failed'
              ? 'Unavailable'
              : needsRecovery
                ? 'Recovery needed'
                : unsupported
                  ? 'Unavailable'
                  : installed
                    ? 'Installed'
                    : partial
                      ? 'Partially installed'
                      : 'Not installed';

    return (
        <SettingsSection title="Recommended skills">
            <SettingsCard>
                <SettingsBlock className={styles.row}>
                    <div className={styles.body}>
                        <div className={styles.heading}>
                            <Text weight="medium">Briefback</Text>
                            <Badge size="xs" color="secondary" textValue={label} data-testid="briefback-status">
                                {label}
                            </Badge>
                        </div>
                        {needsRecovery ? (
                            <div className={styles.recovery} role="alert">
                                <Text color="danger" variant="sm">
                                    To restore each backup, first move any current briefback folder aside. Then move the
                                    backup into its skill folder under the name briefback, without overwriting anything.
                                    Check again when finished
                                </Text>
                                {backups?.map(path => (
                                    <Text key={path} variant="sm">
                                        {path}
                                    </Text>
                                ))}
                            </div>
                        ) : unsupported ? (
                            <Text color="danger" variant="sm" role="alert">
                                After active work finishes, restart Clowdy to use Briefback installation
                            </Text>
                        ) : installing ? (
                            <Text variant="sm" color="secondary" role="status">
                                Installing Briefback…
                            </Text>
                        ) : state.kind === 'failed' || (state.kind === 'ready' && state.error) ? (
                            <Text color="danger" variant="sm" role="alert">
                                {state.kind === 'failed' ? state.message : state.error}
                            </Text>
                        ) : installed ? (
                            <Text variant="sm" color="secondary" data-testid="briefback-update-status">
                                {update === 'checking'
                                    ? 'Checking for updates…'
                                    : update === 'unknown'
                                      ? "Couldn't check for updates"
                                      : update === 'update-available'
                                        ? 'Update available'
                                        : 'Up to date'}
                            </Text>
                        ) : (
                            <Text variant="sm" color="secondary">
                                A workflow for researching, planning, building and reviewing software
                            </Text>
                        )}
                    </div>
                    {state.kind === 'failed' || needsRecovery || unsupported ? (
                        <Button
                            size="sm"
                            variant="bordered"
                            onPress={() => {
                                setAttempt(n => n + 1);
                            }}
                        >
                            Try again
                        </Button>
                    ) : installed && update === 'unknown' && !installing ? (
                        <Button size="sm" variant="bordered" onPress={() => setUpdateAttempt(n => n + 1)}>
                            Check again
                        </Button>
                    ) : !installed || update === 'update-available' || installing ? (
                        <Button
                            size="sm"
                            variant="bordered"
                            isDisabled={state.kind !== 'ready' || installing}
                            onPress={install}
                            data-testid="briefback-install"
                        >
                            {installing ? (installed ? 'Updating…' : 'Installing…') : installed ? 'Update' : 'Install'}
                        </Button>
                    ) : null}
                </SettingsBlock>
            </SettingsCard>
        </SettingsSection>
    );
}
