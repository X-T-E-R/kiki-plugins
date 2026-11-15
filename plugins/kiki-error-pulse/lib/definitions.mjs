export const errorPulseReportTool = {
  schemaVersion: 1,
  name: 'error_pulse_report',
  description:
    'Inspect incremental workspace and session error statistics, high-error tools, normalized failure signatures, retry-streak hotspots, and redacted samples from wire.jsonl logs. Use summary, top_signatures, streaks, or samples for zero-scan reads, or scan_now for a bounded incremental refresh.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['summary', 'scan_now', 'top_signatures', 'streaks', 'samples'],
        default: 'summary',
        description:
          'summary returns window totals + top tools/signatures/streaks; scan_now runs a bounded incremental scan first; top_signatures lists normalized error clusters; streaks lists consecutive same-tool retry hotspots; samples returns redacted samples for signatureId (or top signatures).',
      },
      windowHours: {
        type: 'integer',
        minimum: 1,
        maximum: 720,
        default: 168,
        description: 'Lookback time window in hours (1..720, default 168 = 7 days).',
      },
      toolFilter: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          'Optional exact or case-insensitive tool / lifecycle event filter (e.g. "Bash", "Edit", "CallTool:mcp_name", "provider.error").',
      },
      signatureId: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'Signature identifier (e.g. "sig_...") when inspecting samples with action="samples".',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 15,
        description: 'Maximum rows to return (1..50, default 15).',
      },
      maxMegabytes: {
        type: 'integer',
        minimum: 1,
        maximum: 64,
        description:
          'Optional byte budget in MiB when action="scan_now" (1..64; defaults to maxScanMegabytesPerTick setting).',
      },
      reason: {
        type: 'string',
        maxLength: 500,
        description: 'Optional brief note on why this tool is being called (ignored at runtime).',
      },
    },
  },
  accesses: [{ kind: 'all' }],
  concurrencySafe: true,
  disclosure: 'deferred',
};

export const definitions = [errorPulseReportTool];
