const common = { schemaVersion: 1, inbound: true, outbound: true, textLimit: 5000, maxInboundBytes: 8 * 1024 * 1024, supportsEdit: false, supportsReply: true };
const officialAudio = { mimeTypes: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/silk', 'audio/amr'], maxBytes: 20 * 1024 * 1024, rendering: 'qq-media-upload' };
const onebotAudio = { mimeTypes: ['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/silk', 'audio/amr'], maxBytes: 20 * 1024 * 1024, rendering: 'onebot-segment' };
export const officialAdapterDefinition = {
  ...common, id: 'qq-official', listenerRealm: 'qq-official', label: 'QQ Bot API (official)', supportsButtons: true, supportsMentions: false,
  mediaCapabilities: [
    { kind: 'image', mimeTypes: ['image/png', 'image/jpeg', 'image/gif'], maxBytes: 20 * 1024 * 1024, rendering: 'qq-media-upload' },
    { kind: 'voice', ...officialAudio },
    { kind: 'audio', ...officialAudio },
    { kind: 'video', mimeTypes: ['video/mp4'], maxBytes: 30 * 1024 * 1024, rendering: 'qq-media-upload' },
    { kind: 'file', maxBytes: 100 * 1024 * 1024, rendering: 'qq-media-upload' },
  ],
};
export const onebotAdapterDefinition = {
  ...common, id: 'qq-onebot', listenerRealm: 'qq-onebot', label: 'OneBot 11', supportsButtons: false, supportsMentions: true,
  mediaCapabilities: [
    { kind: 'image', mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], maxBytes: 20 * 1024 * 1024, rendering: 'onebot-segment' },
    { kind: 'voice', ...onebotAudio },
    { kind: 'audio', ...onebotAudio },
    { kind: 'video', mimeTypes: ['video/mp4'], maxBytes: 30 * 1024 * 1024, rendering: 'onebot-segment' },
  ],
};
export const qqListGroups = {
  schemaVersion: 1, name: 'qq_list_groups',
  description: 'Read the configured OneBot 11 account’s full group list. Reuses the verified running channel; otherwise verifies the configured HTTP account. Returns accountId and transport with the list. The official QQ Bot group/C2C API has no group-list endpoint.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  accesses: [{ kind: 'all' }], disclosure: 'deferred',
};
export const qqListGroupMembers = {
  schemaVersion: 1, name: 'qq_list_group_members',
  description: 'Read the configured OneBot 11 account’s full member list for one numeric group_id. Reuses the verified running channel; otherwise verifies the HTTP account. Returns accountId and transport. Official QQ OpenIDs are not accepted.',
  parameters: { type: 'object', properties: { groupId: { type: 'string', pattern: '^[0-9]+$' } }, required: ['groupId'], additionalProperties: false },
  accesses: [{ kind: 'all' }], disclosure: 'deferred',
};
export const toolDefinitions = [qqListGroups, qqListGroupMembers];
