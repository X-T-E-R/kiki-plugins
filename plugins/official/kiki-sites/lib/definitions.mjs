const string = { type: 'string' };
export const definitions = [
  {
    schemaVersion: 1, name: 'sites', disclosure: 'deferred',
    description: 'Read current Kiki Sites connections, enabled-service guidance, authentication, repositories or deployment jobs. Login consumes the official CLI browser/device flow; API tokens are entered in the panel, never in tool parameters. Code hosting is not a deployment.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['state', 'guidance', 'check_auth', 'repositories', 'login', 'job', 'cancel_job', 'deployment_status'] }, id: string, owner: string, page: { type: 'integer', minimum: 1 }, jobId: string }, required: ['action'], additionalProperties: false }, accesses: [{ kind: 'all' }],
  },
  {
    schemaVersion: 1, name: 'sites_project', disclosure: 'deferred',
    description: 'Configure, preview or deploy a project using an enabled Kiki Sites deployment connection. project is the workspace-relative or approved absolute project directory. Deployment automatically performs necessary preview/checks and waits for the result; existing cloud targets are required. Uses official CLIs/API, may upload code, run provider builds and incur provider costs.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['save_target', 'preview', 'deploy'] }, project: string, id: string, previewId: string, target: { type: 'object', properties: { id: string, service: string, connectionId: string, label: string, projectId: string, orgId: string, production: { type: 'boolean' }, prebuilt: { type: 'boolean' }, siteId: string, directory: string, projectName: string, branch: string, config: string, environment: string, serviceId: string, app: string }, required: ['service', 'connectionId'], additionalProperties: false } }, required: ['action', 'project'], additionalProperties: false }, accesses: [{ kind: 'file', operation: 'readwrite', path: '$.project', recursive: true }, { kind: 'all' }],
  },
];
