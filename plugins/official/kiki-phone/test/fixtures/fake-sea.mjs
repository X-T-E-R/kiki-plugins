import { runPhoneScript } from '../../lib/phone-run.mjs';
import { launchMobileMcp } from '../../lib/launch-mobile-mcp.mjs';

process.execPath = process.env.KIKI_PHONE_FAKE_EXEC_PATH;
if (process.argv[2] === 'worker') {
  const result = await runPhoneScript({ script: 'return process.execPath;' });
  process.stdout.write(JSON.stringify(result));
} else if (process.argv[2] === 'mcp') await launchMobileMcp();
