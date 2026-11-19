import { describe, expect, test } from 'bun:test';

import { Turns } from '../src/engine/acp/turns';

/** The accounting that tells when the turns a message leads to are over: what stands behind the turn that just ended. */
describe('the turns that messages sent into a live session lead to', () => {
    test('a send echoed while the session was idle is answered by the turn that begins next', () => {
        const turns = new Turns();
        const send = turns.add('send');

        // A turn of the agent's own ended (nothing stands behind it), and the send comes after it.
        turns.begin();
        turns.took(send, 'm1');
        turns.echo('m1');
        // Its own turn begins and ends: the send is answered, and owed one `done`.
        turns.begin();
        expect(turns.review()).toEqual({ landed: 0, queued: 0, answered: 1 });
        expect(turns.release(false)).toBe(1);
        expect(turns.sending).toBe(false);
    });

    test('a message echoed while a turn ran has a turn of its own to come, and an agent that folded it in is given up on', () => {
        const turns = new Turns();
        const steer = turns.add('steer');
        const send = turns.add('send');

        turns.begin();
        turns.took(steer, 's1');
        turns.echo('s1');
        turns.took(send, 'p1');
        turns.echo('p1');
        expect(turns.review()).toEqual({ landed: 2, queued: 0, answered: 0 });
        // Nothing came: both were folded into the turn that ended. Only the send is owed a `done`.
        expect(turns.release(true)).toBe(1);
        expect(turns.review()).toEqual({ landed: 0, queued: 0, answered: 0 });
    });

    test('a send the agent has not begun is queued behind the turn, whether or not its answer came', () => {
        const turns = new Turns();
        const send = turns.add('send');

        turns.begin();
        expect(turns.review()).toEqual({ landed: 0, queued: 1, answered: 0 });
        // The agent answered it, echoing nothing: it is placed where its answer came, and the next turn is its own.
        turns.took(send, 'm1');
        expect(turns.review()).toEqual({ landed: 1, queued: 0, answered: 0 });
    });

    test('an echo that comes before the answer to its prompt is remembered for it, and one that came before is not moved by a later one', () => {
        const turns = new Turns();
        const send = turns.add('send');

        turns.begin();
        turns.echo('m1');
        turns.begin();
        turns.took(send, 'm1');
        turns.echo('m1');
        // Echoed in the first turn, so the second answers it.
        expect(turns.review()).toEqual({ landed: 0, queued: 0, answered: 1 });
    });

    test('a steer that was not echoed was refused and counts for nothing, and a message that was dropped is forgotten', () => {
        const turns = new Turns();
        const steer = turns.add('steer');
        const send = turns.add('send');

        turns.begin();
        turns.took(steer, 's1');
        expect(turns.review()).toEqual({ landed: 0, queued: 1, answered: 0 });
        turns.drop(send);
        turns.drop(steer);
        expect(turns.review()).toEqual({ landed: 0, queued: 0, answered: 0 });
        expect(turns.sending).toBe(false);
    });

    test('it remembers a bounded number of echoes', () => {
        const turns = new Turns();

        for (let n = 0; n < 150; n++) {
            turns.echo(`m${ n }`);
        }

        expect(turns.echoed('m0')).toBe(false);
        expect(turns.echoed('m149')).toBe(true);
    });
});
