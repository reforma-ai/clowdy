/** The most message echoes the ledger keeps; the oldest go first. Prompts are few, but an agent may echo messages of its own as often as it likes. */
const MAX_ECHOES = 100;

/** A message the layer sent into a live session after its first prompt: a steer into a turn that runs, or a prompt of its own. */
interface Sent {
    kind: 'steer' | 'send';
    /** The id the agent gave the message when it took it in. */
    id?: string;
    /** How many turns had begun when the agent echoed the message back as the person's: the next turn is the one that answers it. */
    echoed?: number;
    /**
     * For a send made while no turn ran: how many turns had begun then. The turn that begins after it is its own, whenever the agent echoes it: Claude's
     * adapter echoes the message first, Codex's says `running` and echoes it after, which must not look like a message that landed in a turn that ran.
     */
    idleAt?: number;
}

/** What stands behind the turn that just ended. */
export interface Review {
    /** Messages echoed while that turn ran: each has a turn of its own to come, or was folded into this one. */
    landed: number;
    /** Sends the agent has not echoed: it has not begun them, and they wait behind the turn that ended. */
    queued: number;
    /** Sends whose own turn that was (or an earlier one): they are answered. */
    answered: number;
}

/**
 * What the layer has sent into a session that lives on, and where each message stands, so that the layer says one `done` for a whole activity: the
 * turn the agent was in, and the turns that the messages sent into it lead to.
 *
 * A message the agent echoes back (`user_message`) when `n` turns had begun is answered by turn `n + 1`, whether the agent was idle or in the middle
 * of a turn: Claude's adapter queues a prompt that lands in a turn, and answers it with a turn of its own (an `idle` of the first turn, a `running`,
 * the answer, an `idle` with the real usage). An agent that folds the message into the turn it lands in says nothing more, and the layer gives up
 * waiting for that second turn after the handoff guard (`release`).
 */
export class Turns {
    /** The turns that have begun. */
    count = 0;
    /** The turn in which the agent echoed each message, by id: an echo may come before the answer to the prompt that names its id. */
    private echoes = new Map<string, number>();
    private sent = new Set<Sent>();

    /** The agent said a turn began. */
    begin(): void {
        this.count++;
    }

    /** The agent echoed the message `id` back as the person's. */
    echo(id: string): void {
        this.echoes.set(id, this.count);

        for (const entry of this.sent) {
            if (entry.id === id) {
                entry.echoed ??= entry.idleAt ?? this.count;
            }
        }

        if (this.echoes.size > MAX_ECHOES) {
            this.echoes.delete(this.echoes.keys().next().value as string);
        }
    }

    /** Whether the agent has echoed the message `id`. */
    echoed(id: string): boolean {
        return this.echoes.has(id);
    }

    /** A message is on its way to the agent. `idle`: no turn ran when it was sent, so the turn it leads to is its own. */
    add(kind: Sent['kind'], idle = false): Sent {
        const entry: Sent = { kind, ...(idle && { idleAt: this.count }) };

        this.sent.add(entry);

        return entry;
    }

    /**
     * The agent took the message in under `id`. A prompt it answers is taken in, echoed or not: a send the agent never echoed is placed where its
     * answer came, so the turn that follows is the one that answers it. A steer lands only by its echo.
     */
    took(entry: Sent, id: string): void {
        entry.id = id;
        entry.echoed = entry.idleAt ?? this.echoes.get(id) ?? (entry.kind === 'send' ? this.count : undefined);
    }

    /** The message was refused, or was a steer that did not land: the agent owes no turn for it. */
    drop(entry: Sent): void {
        this.sent.delete(entry);
    }

    /** Whether a prompt sent into the session is still open: on its way, queued behind a turn, or waiting for the turn that answers it. */
    get sending(): boolean {
        return [...this.sent].some(entry => entry.kind === 'send');
    }

    /** What stands behind turn `count`, which has just ended. A steer the agent did not echo in time was refused, and is not counted. */
    review(): Review {
        const review: Review = { landed: 0, queued: 0, answered: 0 };

        for (const { kind, echoed } of this.sent) {
            if (echoed === undefined) {
                if (kind === 'send') {
                    review.queued++;
                }
            } else if (echoed >= this.count) {
                review.landed++;
            } else if (kind === 'send') {
                review.answered++;
            }
        }

        return review;
    }

    /**
     * The activity is over: forgets the messages that are answered, and with `fold` those that landed in the last turn too (an agent that folds a message
     * into the turn it lands in has no turn of its own for it). Gives how many sends it forgot, each owed one `done`.
     */
    release(fold: boolean): number {
        let sends = 0;

        for (const entry of this.sent) {
            if (entry.echoed !== undefined && (fold || entry.echoed < this.count)) {
                this.sent.delete(entry);
                sends += entry.kind === 'send' ? 1 : 0;

                if (entry.id !== undefined) {
                    this.echoes.delete(entry.id);
                }
            }
        }

        return sends;
    }
}
