import manifest from './kimi.plugin.json' with { type: 'json' };
import { MagpieAntigravityAccountService } from './lib/antigravity-account-source.mjs';
import {
  MagpieAntigravityDirectQuotaService,
} from './lib/antigravity-direct-quota.mjs';
import {
  antigravityAccountSourceDefinition,
  antigravityQuotaSourceDefinition,
  harnessAccountSourceDefinitions,
  claudeQuotaSourceDefinition,
  codexQuotaSourceDefinition,
  cursorQuotaSourceDefinition,
  geminiQuotaSourceDefinition,
  grokQuotaSourceDefinition,
  harnessQuotaSourceDefinitions,
  MAGPIE_CLI_AGENT_BY_SOURCE_ID,
  magpieManageToolDefinition,
  magpieToolDefinitions,
  qoderCnQuotaSourceDefinition,
  qoderQuotaSourceDefinition,
  workbuddyAiQuotaSourceDefinition,
  workbuddyQuotaSourceDefinition,
} from './lib/definitions.mjs';
import { MagpieQuotaService } from './lib/magpie.mjs';
import { MagpieManagementService, sanitizeDiagnosticText } from './lib/manage.mjs';

const antigravityDirectQuotaService = new MagpieAntigravityDirectQuotaService();
const antigravityAccountService = new MagpieAntigravityAccountService();
const service = new MagpieQuotaService({
  sourceOverrides: {
    antigravity: antigravityDirectQuotaService,
  },
});
const managementService = new MagpieManagementService();

function formatToolFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'MAGPIE_MANAGE_ERROR';
  const message = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
  return {
    output: JSON.stringify({
      ok: false,
      error: { code, message },
    }),
    isError: true,
  };
}

export function createRegister({
  declaredManifest = manifest,
  quotaService = service,
  manager = managementService,
  accountService = antigravityAccountService,
} = {}) {
  return function register(api) {
    const extension = declaredManifest?.['x-kiki'] ?? {};
    const declaresTools = Array.isArray(extension.tools) && extension.tools.length > 0;
    const declaresQuotaSources = Array.isArray(extension.harnessQuotaSources) && extension.harnessQuotaSources.length > 0;
    const declaresAccountSources = Array.isArray(extension.harnessAccountSources) && extension.harnessAccountSources.length > 0;

    if (declaresTools) {
      if (typeof api?.registerTool !== 'function') {
        throw new Error('This plugin requires a Kiki host with tool registration support.');
      }
      api.registerTool(magpieManageToolDefinition, async (args, context) => {
        try {
          const result = await manager.execute(args ?? {}, context ?? {});
          return { output: JSON.stringify(result, null, 2) };
        } catch (error) {
          return formatToolFailure(error);
        }
      });
    }

    if (declaresQuotaSources) {
      if (typeof api?.registerHarnessQuotaSource !== 'function') {
        throw new Error('This plugin requires a Kiki host with harness quota source support.');
      }
      for (const definition of harnessQuotaSourceDefinitions) {
        api.registerHarnessQuotaSource(definition, quotaService.adapterFor(definition.id));
      }
    }

    if (declaresAccountSources) {
      if (typeof api?.registerHarnessAccountSource !== 'function') {
        throw new Error('This plugin requires a Kiki host with harness account source support.');
      }
      for (const definition of harnessAccountSourceDefinitions) {
        api.registerHarnessAccountSource(definition, accountService.adapterFor(definition.id));
      }
    }
  };
}

export const register = createRegister();

export {
  antigravityAccountService,
  antigravityAccountSourceDefinition,
  antigravityDirectQuotaService,
  antigravityQuotaSourceDefinition,
  harnessAccountSourceDefinitions,
  claudeQuotaSourceDefinition,
  codexQuotaSourceDefinition,
  cursorQuotaSourceDefinition,
  geminiQuotaSourceDefinition,
  grokQuotaSourceDefinition,
  harnessQuotaSourceDefinitions,
  MagpieAntigravityDirectQuotaService,
  MAGPIE_CLI_AGENT_BY_SOURCE_ID,
  magpieManageToolDefinition,
  managementService as magpieManagementService,
  service as magpieQuotaService,
  magpieToolDefinitions,
  qoderCnQuotaSourceDefinition,
  qoderQuotaSourceDefinition,
  workbuddyAiQuotaSourceDefinition,
  workbuddyQuotaSourceDefinition,
};
