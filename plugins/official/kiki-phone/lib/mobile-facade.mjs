import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const facadeTools = [
  {
    name: 'phone_help',
    description: 'Find advanced phone operations by name or keyword. Omit arguments for a compact operation index; pass name for that operation’s exact upstream schema, description and safety guidance. Prefer phone_run for semantic UI scripts.',
    inputSchema: {
      type: 'object', properties: {
        name: { type: 'string', description: 'Exact upstream mobile_* operation name.' },
        query: { type: 'string', description: 'Filter operation names and descriptions, e.g. recording, clipboard or remote.' },
      }, additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'phone_call',
    description: 'Call one advanced phone operation using its exact name and arguments from phone_help. Preserves upstream results, including images and files. Cloud login/allocation requires the user’s explicit request and applicable cost authorization. Use absolute host file paths. Observe unclear modifying outcomes before retrying; cancellation does not undo completed actions.',
    inputSchema: {
      type: 'object', properties: {
        name: { type: 'string', description: 'Exact upstream mobile_* operation name returned by phone_help.' },
        arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching that operation’s exact phone_help schema.' },
      }, required: ['name', 'arguments'], additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export async function loadPhoneMcpSdk(dataDir) {
  const base = resolve(dataDir, 'runtime/node_modules/@modelcontextprotocol/sdk/dist/esm');
  const load = file => import(pathToFileURL(resolve(base, file)));
  const [client, transport, server, stdio, types, validation] = await Promise.all([
    load('client/index.js'), load('client/stdio.js'), load('server/index.js'),
    load('server/stdio.js'), load('types.js'), load('validation/ajv-provider.js'),
  ]);
  return { ...client, ...transport, ...server, ...stdio, ...types, ...validation };
}

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

// One upstream connection belongs to the MCP server, not the short-lived native
// plugin entry. Recording and cloud state survive arbitrary gaps between calls.
export function createPhoneFacade({ connect, validator }) {
  let connection;
  let closing;
  let closed = false;
  const validators = new Map();
  const upstream = () => {
    if (closed) throw new Error('Phone MCP is closed. Reconnect the mobile MCP server.');
    return connection ??= connect();
  };
  const tools = async signal => {
    const { client } = await upstream();
    const all = [];
    let cursor;
    do {
      signal?.throwIfAborted();
      const page = await client.listTools(cursor ? { cursor } : {}, { signal });
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  };
  const check = (definition, args) => {
    const key = JSON.stringify(definition.inputSchema);
    if (!validators.has(key)) validators.set(key, validator.getValidator(definition.inputSchema));
    const checked = validators.get(key)(args);
    if (!checked.valid) throw new Error(`Invalid arguments for ${definition.name}: ${checked.errorMessage}`);
  };
  return {
    async execute(name, args = {}, { signal } = {}) {
      try {
        const facade = facadeTools.find(tool => tool.name === name);
        if (!facade) throw new Error(`Unknown facade tool: ${name}. Use phone_help.`);
        check(facade, args);
        const available = await tools(signal);
        if (name === 'phone_help') {
          if (args.name) {
            const exact = available.find(tool => tool.name === args.name);
            if (!exact) throw new Error(`Unknown phone operation: ${args.name}. Use phone_help to find its exact name.`);
            return textResult(exact);
          }
          const query = args.query?.toLowerCase();
          return textResult({ operations: available.filter(tool => !query || `${tool.name} ${tool.title || ''} ${tool.description || ''}`.toLowerCase().includes(query))
            .map(tool => ({ name: tool.name, ...(tool.title ? { title: tool.title } : {}) })) });
        }
        const definition = available.find(tool => tool.name === args.name);
        if (!definition) throw new Error(`Unknown phone operation: ${args.name}. Use phone_help to find its exact name.`);
        check(definition, args.arguments);
        signal?.throwIfAborted();
        const { client } = await upstream();
        return await client.callTool({ name: definition.name, arguments: args.arguments }, undefined, { signal, timeout: 30 * 60 * 1000 });
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: `${error.message || String(error)}${signal?.aborted ? ' Observe the device before repeating an action; completed actions are not rolled back.' : ''}` }] };
      }
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => { if (connection) await (await connection).client.close(); })();
      }
      return closing;
    },
  };
}

export async function servePhoneFacade({ sdk, upstream, inputTransport = new sdk.StdioServerTransport() }) {
  const facade = createPhoneFacade({
    validator: new sdk.AjvJsonSchemaValidator(),
    connect: async () => {
      const client = new sdk.Client({ name: 'kiki-phone', version: '0.1.1' });
      const transport = new sdk.StdioClientTransport(upstream);
      try { await client.connect(transport); return { client, transport }; }
      catch (error) { await client.close(); throw error; }
    },
  });
  const server = new sdk.Server({ name: 'kiki-phone-mobile', version: '0.1.1' }, {
    capabilities: { tools: {} },
    instructions: 'Prefer phone_run for semantic UI tasks. Use phone_help to find advanced mobile operations and obtain one exact schema, then phone_call with that name and arguments. Sequence operations on each phone. Cloud access requires explicit user request and applicable cost authorization.',
  });
  server.setRequestHandler(sdk.ListToolsRequestSchema, () => ({ tools: facadeTools }));
  server.setRequestHandler(sdk.CallToolRequestSchema, (request, extra) => facade.execute(request.params.name, request.params.arguments, extra));
  let closing;
  const close = () => closing ??= (async () => { try { await facade.close(); } finally { await server.close(); } })();
  server.onclose = () => { void close().catch(error => console.error(error.message)); };
  try { await server.connect(inputTransport); }
  catch (error) { await close(); throw error; }
  return { server, facade, close };
}
