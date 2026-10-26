import { definitions } from './lib/definitions.mjs';
import { runAdb } from './lib/adb.mjs';
import { preparePhone } from './lib/prepare.mjs';
import { runPhoneScript } from './lib/phone-run.mjs';

export function prepareOptions(args, settings) {
  return { download: args.download, platform: args.platform, adbPath: settings?.adbPath };
}

export function register(api) {
  for (const definition of definitions) {
    api.registerTool(definition, async (args, context) => {
      if (definition.name === 'phone_prepare') {
        const result = await preparePhone(prepareOptions(args, context.settings), { signal: context.signal });
        return { output: JSON.stringify(result), isError: ['error', 'download_consent_required'].includes(result.status) };
      }
      if (definition.name === 'phone_run') return runPhoneScript(args, context);
      return runAdb(definition.name, args, context);
    });
  }
}
