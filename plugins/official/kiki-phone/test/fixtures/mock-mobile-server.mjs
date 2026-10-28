import { readFile, writeFile } from 'node:fs/promises';
import { loadPhoneMcpSdk } from '../../lib/mobile-facade.mjs';
const sdk = await loadPhoneMcpSdk(process.env.KIKI_PHONE_MOCK_SDK);
const tools = JSON.parse(await readFile(process.env.KIKI_PHONE_MOCK_TOOLS, 'utf8'));
const state = { pid: process.pid, connections: 1, logCalls: 0, cancelled: false, closed: false };
const server = new sdk.Server({ name: 'fixed-mobile-mock', version: '1.0.13' }, { capabilities: { tools: {} } });
server.setRequestHandler(sdk.ListToolsRequestSchema, () => ({ tools }));
server.setRequestHandler(sdk.CallToolRequestSchema, async (request, extra) => {
  const name = request.params.name;
  const text = text => ({ content: [{ type: 'text', text }] });
  if (name === 'mobile_take_screenshot') return { content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }] };
  if (name === 'mobile_start_screen_recording') { state.recording = true; return text('started'); }
  if (name === 'mobile_stop_screen_recording') {
    if (!state.recording) return { ...text('recording state lost'), isError: true };
    state.recordingElapsed = 120000;
    return { content: [{ type: 'resource_link', uri: 'file:///mock/recording.mp4', name: 'recording.mp4', mimeType: 'video/mp4' }, { type: 'text', text: `recorded ${state.recordingElapsed}ms` }] };
  }
  if (name === 'mobile_launch_app') return { ...text('mock app failure: inspect state'), isError: true };
  if (name === 'mobile_get_device_logs') {
    state.logCalls++;
    return new Promise(resolve => {
      extra.signal.addEventListener('abort', () => { state.cancelled = true; resolve(text('cancelled')); }, { once: true });
    });
  }
  return text(name);
});
server.onclose = () => {
  state.closed = true;
  void writeFile(process.env.KIKI_PHONE_MOCK_LIFECYCLE, JSON.stringify(state));
};
await server.connect(new sdk.StdioServerTransport());
process.stdin.once('end', () => { void server.close(); });
