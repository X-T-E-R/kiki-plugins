export const definitions = [
  {
    schemaVersion: 1,
    name: 'relay_status',
    disclosure: 'deferred',
    description: 'Read current kiki-relay encrypted rendezvous nodes, Home/Standby latency slots, team subscriptions, and local relay server state without exposing tokens.',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    accesses: [{ kind: 'all' }],
  },
  {
    schemaVersion: 1,
    name: 'relay_deploy_guide',
    disclosure: 'deferred',
    description: 'Generate ready-to-run Docker, docker-compose, Node.js, and reverse-proxy (Caddy, Nginx, OpenResty, Cloudflare) configuration snippets for self-hosting kiki-relay.',
    parameters: {
      type: 'object',
      properties: {
        publicHost: { type: 'string' },
        basePath: { type: 'string' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        proxyTarget: { type: 'string', enum: ['nginx', 'caddy', 'openresty', 'cloudflare'] },
      },
      additionalProperties: false,
    },
    accesses: [{ kind: 'all' }],
  },
];
