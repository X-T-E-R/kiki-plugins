import { definitions } from './lib/definitions.mjs';
import { readLedger, writeLedger } from './lib/ledger.mjs';
export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args, context) => {
      try {
        const result = definition.name === 'ledger_read' ? await readLedger(args, context) : await writeLedger(args, context);
        return { output: JSON.stringify(result, null, 2) };
      } catch (error) {
        return { isError: true, output: JSON.stringify({ error: error.code ?? 'ledger_error', message: error.message, details: error.details ?? null, recovery: error.recovery ?? 'Correct the input or read the current item and retry with a new requestKey; retries of an identical committed request return its original receipt.' }, null, 2) };
      }
    });
  }
}
