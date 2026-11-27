import { describe, expect, it } from 'vitest';

import { FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { TransportError } from './transport';

const URL_BASE = 'http://127.0.0.1:4310';

describe('HttpTransport attachments', () => {
    it('uploads the file as the raw body, named in the query, with its media type', async () => {
        const calls: { url: string; init: RequestInit | undefined }[] = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), init });

            return new Response(JSON.stringify({ id: 'a-1', name: 'my shot.png', mediaType: 'image/png', size: 3 }), {
                status: 200,
            });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: URL_BASE, token: 't', fetch: fetchImpl });
        const file = new File(['abc'], 'my shot.png', { type: 'image/png' });

        expect(await transport.uploadAttachment('prj 1', file)).toEqual({
            id: 'a-1',
            name: 'my shot.png',
            mediaType: 'image/png',
            size: 3,
        });
        expect(calls[0]?.url).toBe(`${URL_BASE}/v1/projects/prj%201/attachments?name=my%20shot.png`);
        expect(calls[0]?.init).toMatchObject({
            method: 'POST',
            body: file,
            headers: expect.objectContaining({ 'content-type': 'image/png', authorization: 'Bearer t' }),
        });
    });

    it("sends a file with no media type as binary, and gives the daemon's own reason when it refuses", async () => {
        const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            expect((init?.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');

            return new Response(
                JSON.stringify({ ok: false, error: { code: 'invalid', message: 'The file is over 25 MB' } }),
                { status: 413 }
            );
        }) as typeof fetch;
        const transport = new HttpTransport({ url: URL_BASE, token: 't', fetch: fetchImpl });
        const failure = await transport
            .uploadAttachment('p', new File(['x'], 'big.bin'))
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(TransportError);
        expect(failure).toMatchObject({ message: 'The file is over 25 MB', status: 413 });
    });

    it('reads a file back as a blob and deletes an unsent one', async () => {
        const calls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${String(input)}`);

            return init?.method === 'DELETE'
                ? new Response('{"ok":true}', { status: 200 })
                : new Response('bytes', { status: 200 });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: URL_BASE, token: 't', fetch: fetchImpl });

        expect(await (await transport.getAttachment('p', 'a/1')).text()).toBe('bytes');
        await transport.deleteAttachment('p', 'a/1');

        expect(calls).toEqual([
            `GET ${URL_BASE}/v1/projects/p/attachments/a%2F1`,
            `DELETE ${URL_BASE}/v1/projects/p/attachments/a%2F1`,
        ]);
    });

    it('says what the daemon answered when it gave no reason', async () => {
        const transport = new HttpTransport({
            url: URL_BASE,
            token: 't',
            fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
        });

        await expect(transport.getAttachment('p', 'nope')).rejects.toMatchObject({ status: 404 });
    });
});

describe('FixtureTransport attachments', () => {
    // A chat whose orchestrator has finished, so a message reaches it at once instead of waiting in its queue.
    const chatOf = async (transport: FixtureTransport) =>
        (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(chat => chat.id === 'c-2')!;

    it('keeps an uploaded file until it is sent, shows it on the message, and then keeps it for good', async () => {
        const transport = new FixtureTransport();
        const chat = await chatOf(transport);
        const attachment = await transport.uploadAttachment(
            FIXTURE_PROJECT_ID,
            // Not `text/plain`: Node 26 reads that type back as `text/plain;charset=utf-8`.
            new File(['hello'], 'notes.md', { type: 'text/markdown' })
        );

        expect(attachment).toMatchObject({ name: 'notes.md', mediaType: 'text/markdown', size: 5 });
        expect(await (await transport.getAttachment(FIXTURE_PROJECT_ID, attachment.id)).text()).toBe('hello');

        const sent = await transport.command({
            type: 'chat.send',
            chatId: chat.id,
            text: '',
            attachmentIds: [attachment.id],
        });
        const items = await transport.getItems({ chatId: chat.id });

        expect(sent.ok).toBe(true);
        expect(items.at(-1)?.body).toEqual({ kind: 'user', text: '', attachments: [attachment] });
        await expect(transport.deleteAttachment(FIXTURE_PROJECT_ID, attachment.id)).rejects.toMatchObject({
            status: 409,
        });
        expect(
            (
                await transport.command({
                    type: 'chat.send',
                    chatId: chat.id,
                    text: 'again',
                    attachmentIds: [attachment.id],
                })
            ).ok
        ).toBe(false);
    });

    it('removes a file that was not sent, and refuses an empty message and a file of another project', async () => {
        const transport = new FixtureTransport();
        const chat = await chatOf(transport);
        const attachment = await transport.uploadAttachment(FIXTURE_PROJECT_ID, new File(['x'], 'a.txt'));

        await transport.deleteAttachment(FIXTURE_PROJECT_ID, attachment.id);

        await expect(transport.getAttachment(FIXTURE_PROJECT_ID, attachment.id)).rejects.toMatchObject({ status: 404 });
        expect((await transport.command({ type: 'chat.send', chatId: chat.id, text: '  ' })).ok).toBe(false);
        expect(
            (await transport.command({ type: 'chat.send', chatId: chat.id, text: 'hi', attachmentIds: ['nope'] })).ok
        ).toBe(false);
    });
});
