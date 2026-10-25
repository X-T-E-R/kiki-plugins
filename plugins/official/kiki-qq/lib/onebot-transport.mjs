import WebSocket from '../vendor/ws/wrapper.mjs';

/** Adapted from @nb-im/core 0.3.0 session/onebot-ws.js connect/linkFrom. */
export async function connectOneBot({ url, headers, signal }) {
  signal.throwIfAborted();
  const socket = new WebSocket(url, { headers, handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 });
  const frames = new Set(), closes = new Set(), errors = new Set(), buffered = [];
  let isClosed = false;
  const stop = () => socket.terminate();
  signal.addEventListener('abort', stop, { once: true });
  socket.on('message', (data) => {
    let value;
    try { value = JSON.parse(Buffer.from(data).toString('utf8')); } catch { return; }
    if (!frames.size) buffered.push(value);
    for (const handler of frames) handler(value);
  });
  socket.on('close', () => { isClosed = true; signal.removeEventListener('abort', stop); for (const handler of closes) handler(); });
  socket.on('error', (error) => { for (const handler of errors) handler(error); });
  try {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        signal.removeEventListener('abort', abort);
        socket.removeListener('open', opened); socket.removeListener('error', failed); socket.removeListener('close', closed);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(Object.assign(new Error('OneBot connection cancelled'), { code: 'ABORTED' }));
      const opened = () => finish();
      const failed = (error) => finish(error);
      const closed = () => finish(new Error('OneBot closed before connection opened'));
      signal.addEventListener('abort', abort, { once: true });
      socket.once('open', opened); socket.once('error', failed); socket.once('close', closed);
      if (signal.aborted) abort();
    });
  } catch (error) { socket.terminate(); throw error; }
  return {
    send(frame) { if (socket.readyState !== WebSocket.OPEN) throw Object.assign(new Error('OneBot socket closed before send'), { code: 'NOT_SENT' }); socket.send(JSON.stringify(frame)); },
    onFrame(handler) { frames.add(handler); for (const frame of buffered.splice(0)) handler(frame); },
    onClose(handler) { closes.add(handler); if (isClosed) handler(); },
    onError(handler) { errors.add(handler); },
    close() { socket.terminate(); },
  };
}
