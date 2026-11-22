import { cursorAccount } from './account';
import { cursorModels } from './models';

import type { Provider } from '../types';

export const cursor: Provider = {
    spec: {
        id: 'cursor',
        name: 'Cursor',
        programs: ['cursor-agent', 'agent'],
        launch: { kind: 'binary', args: ['acp'] },
        login: 'cursor-agent login',
        // Verified on macOS only: the login is in the keychain, so it follows the person into the folder; the model every new process starts on and
        // the session history stay in it (research/cursor-isolation.md). On Windows and Linux the credential file is built from other variables, so the
        // login should survive too, but nobody has run it: a run there keeps the person's own folder (and its default model) until somebody does.
        isolation: { env: 'CURSOR_CONFIG_DIR', dir: 'cursor', platforms: ['darwin'] },
        clientMeta: { parameterizedModelPicker: true },
    },
    ...cursorAccount,
    models: cursorModels,
};
