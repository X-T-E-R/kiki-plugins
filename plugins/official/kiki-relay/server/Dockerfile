FROM node:24-alpine

WORKDIR /opt/kiki-relay

COPY vendor/ws ./vendor/ws
COPY server/kiki-relay-server.mjs ./server/kiki-relay-server.mjs

ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=9440

EXPOSE 9440

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.RELAY_PORT || 9440) + '/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "./server/kiki-relay-server.mjs"]
