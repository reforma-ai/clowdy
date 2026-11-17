import { loadConfig } from './config';
import { startDaemon } from './daemon';
import { errorMessage } from './errors';

import type { Daemon } from './daemon';

let daemon: Daemon;

try {
    daemon = await startDaemon(loadConfig(), { onShutdown: () => process.exit(0) });
}
catch (error) {
    console.error(`clowdy-daemon: ${ errorMessage(error) }`);
    process.exit(1);
}

console.log(`Clowdy daemon ${ daemon.info.pid } listening on http://127.0.0.1:${ daemon.info.port } (protocol ${ daemon.info.protocol })`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        void daemon.stop().finally(() => process.exit(0));
    });
}
