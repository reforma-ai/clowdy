import { Box } from '@clowdy/components/Box';
import { Button } from '@clowdy/components/Button';
import { For } from '@clowdy/components/For';
import { OverlayTriggerStateContext, Popover, PopoverScroll, PopoverTrigger } from '@clowdy/components/Popover';
import { Show } from '@clowdy/components/Show';
import { Spinner } from '@clowdy/components/Spinner';
import { Badge } from '@clowdy/components/Tag';
import { Text } from '@clowdy/components/Text';
import { use, useEffect, useRef, useState } from 'react';

import { perform } from '../features/chats/commands';
import { ProviderIcon } from '../features/settings/providers/ProviderIcon';
import {
    accountLine,
    headlineWindow,
    isUsableProvider,
    providerAgents,
    scopedHotWindow,
    USAGE_DANGER_PERCENT,
    usageTone,
    weeklyMark,
    windowPercent,
} from '../features/settings/providers/providerView';
import { RefreshUsageButton, UsageReading } from '../features/settings/providers/UsageRows';
import { waitForRead } from '../features/settings/providers/useAgentCommands';
import { describeRemaining, formatRemaining } from '../shared';
import { useNow } from '../shared/useNow';
import { useAgents, useRootStore } from '../stores';
import styles from './UsageStatus.module.css';

import type { AgentInfo } from '@clowdy/protocol';
import type { RootStore } from '../stores';

/**
 * How often the header reads the agents again while the window is open. The daemon reads a provider's usage again only when its
 * last read is older than its own freshness (90 s), so asking is cheap; a hidden window does not need the numbers.
 */
const POLL_MS = 5 * 60_000;

/**
 * The badge is plain until the danger tone of its nearest window, from 90%, and then red. The warning tone (orange, from 80%) is for
 * the bars in the popover, not for the button, which would be orange for a long time before there is anything to do, and not for the
 * week line, which stays the primary color until 90%.
 * A fuller week does not turn the chip red either: the number on it is the nearest window, and a red chip would read as that window.
 */
const badgeColor = (percent: number | undefined) =>
    percent !== undefined && usageTone(percent) === 'danger' ? 'danger' : 'secondary';

/**
 * A window that comes back gets a `focus` and a `visibilitychange` together, and a tick can land right after them: one read answers
 * every trigger that arrives within this time of the one before it.
 */
const COALESCE_MS = 1_000;

/** Reads the agents again every five minutes and when the window comes back, so the badges are not hours old. Cleans up with the component. */
function useUsagePolling(root: RootStore) {
    useEffect(() => {
        let lastAt = Number.NEGATIVE_INFINITY;
        const refetch = () => {
            const at = Date.now();

            if (document.hidden || at - lastAt < COALESCE_MS) return;

            lastAt = at;
            void root.refreshAgents();
        };
        const timer = setInterval(refetch, POLL_MS);

        // The window gains focus (a click on it, switching back to the app) or becomes visible again (restored, another desktop).
        window.addEventListener('focus', refetch);
        document.addEventListener('visibilitychange', refetch);

        return () => {
            clearInterval(timer);
            window.removeEventListener('focus', refetch);
            document.removeEventListener('visibilitychange', refetch);
        };
    }, [root]);
}

/**
 * The refresh button of the popover: asks the daemon to read again and is pending until some provider was read again, because the
 * daemon answers before it has read. The state lives in the badges, so closing the popover does not end the wait.
 */
function useUsageRefresh(root: RootStore) {
    const [isRefreshing, setIsRefreshing] = useState(false);
    const isMounted = useRef(true);

    useEffect(() => {
        isMounted.current = true;

        return () => {
            isMounted.current = false;
        };
    }, []);

    const refresh = async () => {
        // Every provider counts, usable or not: a provider switched off while the wait runs must not make the last read look older, and so look like a new one.
        const lastRead = () => Math.max(0, ...providerAgents(root.agents).map(agent => agent.signIn?.checkedAt ?? 0));
        const before = lastRead();

        setIsRefreshing(true);

        const result = await perform(root, { type: 'agents.refresh' });

        if (result.ok) {
            await root.refreshAgents();
            await waitForRead(root, lastRead, before, () => isMounted.current);
        }

        if (isMounted.current) setIsRefreshing(false);
    };

    return { isRefreshing, refresh };
}

/** The week line and the model-limit dot, in the order they are drawn, for the badge's label. */
function markLabel(agent: AgentInfo): string {
    const week = weeklyMark(agent);
    const hot = scopedHotWindow(agent);
    const parts = [week, hot].flatMap(window => (window ? [`${window.label} ${windowPercent(window)}%`] : []));

    return parts.join(', ');
}

/** What a screen reader hears for a badge: the provider, how much is used and when it resets, or why there is no number. The week and a hot model limit are named when their marks are drawn. */
function badgeLabel(agent: AgentInfo, now: number): string {
    const headline = headlineWindow(agent);
    const marks = markLabel(agent);

    if (headline) {
        const reset =
            headline.resetsAt === undefined ? '' : `, resets in ${describeRemaining(headline.resetsAt - now)}`;

        return `${agent.name} usage ${windowPercent(headline)}%${reset}${marks ? `, ${marks}` : ''}`;
    }

    if (marks) return `${agent.name} usage: ${marks}`;

    if (agent.signIn?.status === 'signed-out') return `${agent.name} usage: not signed in`;

    return `${agent.name} usage: ${agent.usage ? 'not available' : 'being checked'}`;
}

/**
 * One provider: its mark, the percent used of its nearest limit (`headlineWindow`) and the time to its reset. Under that text, a line for the
 * longer plan window once it is ahead and at least 60% used (`weeklyMark`), terracotta until 90% and red from then; a red dot after the reset when a single model's limit is at
 * the danger tone and the plan is not (`scopedHotWindow`). The mark alone, muted, when there is no reading. It has no tooltip: what one
 * would say is already on the badge, and its label is for a screen reader.
 * A press opens the popover of the `PopoverTrigger` it sits in, which also sets its `aria-expanded` and gives it back the focus.
 */
function UsageBadge({ agent, now }: { agent: AgentInfo; now: number }) {
    const headline = headlineWindow(agent);
    const week = weeklyMark(agent);
    const hot = scopedHotWindow(agent);
    const percent = headline ? windowPercent(headline) : undefined;
    const color = badgeColor(percent);
    const label = badgeLabel(agent, now);

    return (
        <Button
            variant="filling"
            size="sm"
            color={color}
            className={styles.badge}
            data-muted={(percent === undefined && !hot) || undefined}
            aria-label={label}
        >
            <ProviderIcon agentId={agent.id} size={16} />
            <Show when={headline}>
                {reading => (
                    <span className={styles.figures}>
                        <span>{`${windowPercent(reading)}%`}</span>
                        {reading.resetsAt !== undefined && (
                            <Text color={color === 'danger' ? 'inherit' : 'secondary'}>
                                {formatRemaining(reading.resetsAt - now)}
                            </Text>
                        )}
                        <Show when={week}>
                            {longer => {
                                const used = windowPercent(longer);

                                return (
                                    <span
                                        className={styles.week}
                                        data-week=""
                                        data-tone={used >= USAGE_DANGER_PERCENT ? 'danger' : undefined}
                                        style={{ width: `${used}%` }}
                                    />
                                );
                            }}
                        </Show>
                    </span>
                )}
            </Show>
            <Show when={hot}>
                <span className={styles.hot} data-hot="" />
            </Show>
        </Button>
    );
}

interface ProviderUsageProps {
    agent: AgentInfo;
    now: number;
    onOpenProviders: () => void;
    isRefreshing: boolean;
    onRefresh: () => void;
}

/** One provider in the popover: who is signed in, with the button that reads again at the end of that line, and its windows, or why there is nothing to show. */
function ProviderUsage({ agent, now, onOpenProviders, isRefreshing, onRefresh }: ProviderUsageProps) {
    const line = accountLine(agent);
    const isSignedIn = agent.signIn?.status === 'signed-in';
    const isSignedOut = agent.signIn?.status === 'signed-out';
    const { usage } = agent;
    const who = isSignedIn ? line.text : agent.name;

    return (
        <section className={styles.provider} aria-label={agent.name}>
            <header className={styles.who}>
                <ProviderIcon agentId={agent.id} size={16} />
                <Text variant="sm" weight="medium" truncate className={styles.account} title={who}>
                    {who}
                </Text>
                <Show when={isSignedIn ? line.plan : undefined}>
                    {plan => (
                        <Badge size="xs" color="secondary" textValue={plan} className={styles.plan}>
                            {plan}
                        </Badge>
                    )}
                </Show>
                <RefreshUsageButton
                    size="sm"
                    isRefreshing={isRefreshing}
                    onRefresh={onRefresh}
                    className={styles.refresh}
                />
            </header>

            {isSignedOut && (
                <div className={styles.note}>
                    <Text variant="sm" color="secondary">
                        Not signed in
                    </Text>
                    <Button variant="bordered" size="xs" onPress={onOpenProviders}>
                        Open Providers
                    </Button>
                </div>
            )}

            {!isSignedOut && !usage && (
                <Box direction="row" gap="md" align="center" role="status">
                    <Spinner size="xs" />
                    <Text variant="sm" color="secondary">
                        Checking…
                    </Text>
                </Box>
            )}

            {!isSignedOut && usage && <UsageReading usage={usage} now={now} />}
        </section>
    );
}

interface UsagePopoverProps {
    /** The provider of the badge that opened it. */
    agent: AgentInfo;
    now: number;
    isRefreshing: boolean;
    onRefresh: () => void;
}

/**
 * The popover of a badge: the provider it belongs to, with a bar per window, under the badge. It has no title: the account line says whose it is. Every badge has one of its own (React Aria gives each
 * trigger its own state, so only the badge that opened it is expanded), but only the open one is drawn. The refresh button reads every provider again.
 */
function UsagePopover({ agent, now, isRefreshing, onRefresh }: UsagePopoverProps) {
    const root = useRootStore();
    const overlay = use(OverlayTriggerStateContext);

    return (
        <Popover placement="bottom" spacing="none" aria-label={`${agent.name} plan usage`} className={styles.popover}>
            <PopoverScroll maxHeight="min(70vh, 34rem)">
                <div className={styles.panel}>
                    <ProviderUsage
                        agent={agent}
                        now={now}
                        isRefreshing={isRefreshing}
                        onRefresh={onRefresh}
                        onOpenProviders={() => {
                            overlay?.close();
                            root.ui.openSettings('providers');
                        }}
                    />
                </div>
            </PopoverScroll>
        </Popover>
    );
}

/** The badges and their popovers, drawn only while some provider is usable, so the clock below ticks only then. */
function UsageBadges({ providers }: { providers: readonly AgentInfo[] }) {
    const root = useRootStore();
    const now = useNow();
    const { isRefreshing, refresh } = useUsageRefresh(root);

    return (
        <div className={styles.group} role="group" aria-label="Plan usage of the providers">
            <For each={providers}>
                {agent => (
                    <PopoverTrigger key={agent.id}>
                        <UsageBadge agent={agent} now={now} />
                        <UsagePopover
                            agent={agent}
                            now={now}
                            isRefreshing={isRefreshing}
                            onRefresh={() => void refresh()}
                        />
                    </PopoverTrigger>
                )}
            </For>
        </div>
    );
}

/**
 * The window header's usage status: a badge for each provider that is switched on and installed, with the percent used of its
 * nearest limit and the time to its reset, a line under that text for the week once it is ahead, and a dot when a model's limit
 * is hot and the plan is not. A press opens a popover with every window of that provider alone. Nothing at all when
 * no provider is usable. It keeps the numbers fresh by reading the agents again every five minutes and when the window gets focus.
 */
export function UsageStatus() {
    const root = useRootStore();
    const { agents } = useAgents();
    const providers = providerAgents(agents).filter(isUsableProvider);

    useUsagePolling(root);

    return providers.length > 0 ? <UsageBadges providers={providers} /> : null;
}
