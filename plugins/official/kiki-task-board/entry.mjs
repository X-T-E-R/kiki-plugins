import { readFileSync } from 'node:fs';
import { createBoard } from './lib/board.mjs';

function homeOf(context) {
  const home = context?.kikiHome;
  if (typeof home !== 'string' || !home) {
    return { ok: false, error: { code: 'BOARD_UNAVAILABLE', message: 'The host did not provide a Kiki home.' } };
  }
  return { ok: true, value: home };
}

function denied(result) {
  return { output: JSON.stringify(result), isError: true };
}

const manifest = JSON.parse(readFileSync(new URL('./kimi.plugin.json', import.meta.url), 'utf8'));

export function register(api) {
  for (const definition of manifest['x-kiki'].tools) {
    api.registerTool(definition, async (args, context) => {
      const home = homeOf(context);
      if (!home.ok) return denied(home);
      const board = createBoard({ kikiHome: home.value });
      const workspaceId = args?.workspaceId ?? context.workspaceId;
      try {
        const result = definition.name === 'BoardRead'
          ? await board.read(args?.action === 'overview' ? args : { ...args, workspaceId })
          : await board.write({ ...args, workspaceId });
        return result.ok ? { output: JSON.stringify(result) } : denied(result);
      } catch (error) {
        return denied({ ok: false, error: { code: 'BOARD_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } });
      }
    });
  }
}

export async function handlePanelRequest(action, args, context) {
  const home = homeOf(context);
  if (!home.ok) return home;
  const board = createBoard({ kikiHome: home.value });
  const body = args !== null && typeof args === 'object' ? args : {};
  if (action === 'workspaces') return board.workspaces();
  if (action === 'read') return board.read(body);
  if (action === 'write') return board.write(body);
  return { ok: false, error: { code: 'BOARD_INPUT_INVALID', message: 'Unknown panel action.' } };
}
