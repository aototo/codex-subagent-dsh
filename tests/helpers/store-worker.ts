import { TaskStore } from '../../src/task-store.js';
import type { TaskRecord } from '../../src/types.js';

const [stateDir, serializedRecord] = process.argv.slice(2);
if (!stateDir || !serializedRecord || !process.send) {
  throw new Error('worker configuration missing');
}

const store = new TaskStore(stateDir);
process.send({ type: 'ready' });

process.once('message', (message) => {
  if (message !== 'reserve') return;
  try {
    const result = store.reserve(JSON.parse(serializedRecord) as TaskRecord);
    process.send?.({ type: 'result', result }, finish);
  } catch (error) {
    process.send?.(
      { type: 'error', error: error instanceof Error ? error.message : 'reserve failed' },
      finish,
    );
  }
});

function finish(): void {
  store.close();
  process.disconnect();
}
