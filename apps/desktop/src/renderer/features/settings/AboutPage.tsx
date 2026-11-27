import { Button } from '@clowdy/components/Button';
import { SettingsLayout } from '@clowdy/components/SettingsLayout';
import { Text } from '@clowdy/components/Text';
import { GITHUB_URL, LICENSE_URL, LICENSES_URL, RELEASES_URL } from '@clowdy/constants';
import { ArrowUpRight } from '@clowdy/icons/14';
import { Github } from '@clowdy/icons/logo';
import { useEffect, useState } from 'react';

import { useRootStore } from '../../stores';

import type { ReactNode } from 'react';
import type { UpdateStatus } from '../../../shared/bridge';
import type { Transport } from '../../daemon/transport';

/** A computer that runs a daemon. Local is this one, and it is a host like the others will be: each gets a card in Updates. */
interface Host {
    name: string;
    detail: string;
}

const LOCAL_HOST: Host = { name: 'Local', detail: 'This computer' };

/**
 * Settings > About: where Clowdy lives (the repository and the releases), the versions running on each host, and what it is built with. It only informs and links: the links open in the
 * browser. Updates has a card for the one host there is, Local; hosts that are not this computer, and what to do about an old daemon on one, come with them.
 * Updates apply quietly, so this is the one place that says an update waits: for a restart, or for agent runs to finish.
 */
export function AboutPage() {
    const { transport } = useRootStore();
    const update = useUpdateStatus();

    return (
        <SettingsLayout.Page description="Links, versions and credits of Clowdy">
            <SettingsLayout.Section title="Clowdy">
                <SettingsLayout.Card divided>
                    <SettingsLayout.Row title="Repository" description="Source code, issues and stars">
                        <LinkButton href={GITHUB_URL} icon={<Github size={14} />}>
                            Open in GitHub
                        </LinkButton>
                    </SettingsLayout.Row>
                    <SettingsLayout.Row title="Download" description="The installers of the latest release">
                        <LinkButton href={RELEASES_URL}>Open releases</LinkButton>
                    </SettingsLayout.Row>
                    <SettingsLayout.Row
                        title="License"
                        description="Clowdy is open source under the Apache License 2.0"
                    >
                        <LinkButton href={LICENSE_URL}>Apache-2.0</LinkButton>
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>

            <SettingsLayout.Section title="Updates" description="The versions running on your hosts">
                <HostCard host={LOCAL_HOST} transport={transport} update={update} />
            </SettingsLayout.Section>

            <SettingsLayout.Section title="Credits">
                <SettingsLayout.Card>
                    <SettingsLayout.Row
                        title="Open source licenses"
                        description="The libraries, fonts and icons Clowdy is built with"
                    >
                        <LinkButton href={LICENSES_URL}>Open licenses</LinkButton>
                    </SettingsLayout.Row>
                </SettingsLayout.Card>
            </SettingsLayout.Section>
        </SettingsLayout.Page>
    );
}

/** A button that opens an address in the browser. */
function LinkButton({
    href,
    icon = <ArrowUpRight />,
    children,
}: {
    href: string;
    icon?: ReactNode;
    children: ReactNode;
}) {
    return (
        <Button variant="filling" color="secondary" size="sm" href={href} target="_blank" rel="noreferrer">
            {icon}
            {children}
        </Button>
    );
}

/** What a host's daemon said about itself: not yet, its version, or that it did not answer. */
type Reading = { status: 'checking' } | { status: 'read'; version: string } | { status: 'failed' };

/**
 * The host's name and what runs on it, one row for each part, and a row for each update that waits. `update` is what the
 * app of this window says: it belongs to Local, and is unset when the page runs outside the app.
 */
function HostCard({ host, transport, update }: { host: Host; transport: Transport; update: UpdateStatus | undefined }) {
    const reading = useDaemonReading(transport);

    return (
        <SettingsLayout.Card as="section" divided aria-label={host.name}>
            <SettingsLayout.Row title={host.name} description={host.detail} />
            {update && (
                <SettingsLayout.Row title="Clowdy app" description="The installed app and its interface">
                    <Text variant="sm" color="secondary">
                        {appText(update)}
                    </Text>
                </SettingsLayout.Row>
            )}
            <SettingsLayout.Row title="Daemon" description="Runs the agents and keeps the chats">
                <Text variant="sm" color="secondary" role="status">
                    {readingText(reading)}
                </Text>
            </SettingsLayout.Row>
            {update?.ready != null && (
                <SettingsLayout.Row title="Update ready" description="Starts the next time Clowdy opens">
                    <Button
                        variant="filling"
                        color="secondary"
                        size="sm"
                        onPress={() => void window.desktop?.restartToUpdate()}
                    >
                        Restart
                    </Button>
                </SettingsLayout.Row>
            )}
            {update?.daemonWaiting && (
                <SettingsLayout.Row
                    title="Daemon update"
                    description="Waits for the agent runs to finish. Restarting now stops them, and they continue when you send a message."
                >
                    <Button
                        variant="filling"
                        color="secondary"
                        size="sm"
                        onPress={() => void window.desktop?.replaceDaemon()}
                    >
                        Restart now
                    </Button>
                </SettingsLayout.Row>
            )}
        </SettingsLayout.Card>
    );
}

const appText = ({ shell, bundle }: UpdateStatus) => (bundle ? `${shell} (bundle ${bundle})` : shell);

const readingText = (reading: Reading) =>
    reading.status === 'checking' ? 'Checking…' : reading.status === 'read' ? reading.version : 'Unavailable';

/** What the app says about its updates, kept current while the page is open. Unset outside the app, or until it answers. */
function useUpdateStatus(): UpdateStatus | undefined {
    const [status, setStatus] = useState<UpdateStatus>();

    useEffect(() => {
        const desktop = window.desktop;

        if (!desktop) return;

        let current = true;
        // A change that arrives first is newer than the answer to the question asked before it.
        let pushed = false;

        desktop.getUpdateStatus().then(
            answer => current && !pushed && setStatus(answer),
            () => undefined
        );

        const stop = desktop.onUpdateStatus(next => {
            pushed = true;
            setStatus(next);
        });

        return () => {
            current = false;
            stop();
        };
    }, []);

    return status;
}

/** Reads the daemon's version once, when the card is drawn. */
function useDaemonReading(transport: Transport): Reading {
    const [reading, setReading] = useState<Reading>({ status: 'checking' });

    useEffect(() => {
        let current = true;

        transport.getHealth().then(
            ({ version }) => current && setReading({ status: 'read', version }),
            () => current && setReading({ status: 'failed' })
        );

        return () => {
            current = false;
        };
    }, [transport]);

    return reading;
}
