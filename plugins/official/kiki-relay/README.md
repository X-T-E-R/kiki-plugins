# Kiki Encrypted Relay (`kiki-relay`)

Zero-knowledge WebSocket rendezvous relay for reaching Kiki spaces without a public IP. Inner traffic stays end-to-end TLS 1.3 pinned to the target space's P-256 SPKI fingerprint (`fp`), so relay operators never terminate inner TLS or inspect session credentials.

## Quick Self-Host

Run directly on Node.js 24+:

```bash
export RELAY_HOST_TOKEN="$(openssl rand -hex 24)" RELAY_SECRET="$(openssl rand -hex 32)"
node server/kiki-relay-server.mjs \
  --host 127.0.0.1 \
  --port 9440 \
  --base-path /kiki-relay \
  --public-url wss://relay.example.com/kiki-relay \
  --name "Edge Relay"
```

On startup, `kiki-relay-server` prints a single share link:

```text
kiki-relay://relay.example.com/kiki-relay?name=Edge+Relay&token=replace-with-random-token
```

Paste that link into **Settings → Connection Services → Encrypted relay (kiki-relay)** or the **Encrypted Relay** sidebar panel.

## Docker Compose

```bash
cd server
RELAY_HOST_TOKEN="$(openssl rand -hex 24)" RELAY_SECRET="$(openssl rand -hex 32)" docker compose up -d
```

## Protocol Summary

- `GET [<basePath>]/v1/probe` and `GET [<basePath>]/v1/health`: latency & readiness probe (`Cache-Control: no-store`).
- `WSS [<basePath>]/v1/host` (`Sec-WebSocket-Protocol: kiki-relay-v1`, `perMessageDeflate: false`): P-256 challenge-response host registration issuing a stateless `capKey`.
- `WSS [<basePath>]/v1/pool`: pre-warmed reverse WebSocket data pool (`0ms` handoff, independent TCP congestion windows, zero head-of-line blocking).
- `WSS [<basePath>]/v1/stream?target=<fp>&rt=<ticket>`: client binary stream verified against pairing (`p.<exp>.<hmac>`) or grant (`g.<grantId>.<hmac>`) tickets.
