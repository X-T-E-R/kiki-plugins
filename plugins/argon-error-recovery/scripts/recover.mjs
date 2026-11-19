import { readStdinEvent, recoveryFor } from '../lib/recovery.mjs';

try {
  const event = await readStdinEvent(process.stdin);
  const output = recoveryFor(event);
  if (output !== undefined) process.stdout.write(JSON.stringify(output));
} catch {
  // Never exit non-zero on malformed or unreadable hook stdin.
}
