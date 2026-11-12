# The app has no npm dependencies and no build step, so the runtime image only needs the
# `node` binary: no npm, yarn or corepack. Both stages share the Alpine release so the
# copied musl binary and C++ runtime match.
FROM node:24-alpine3.24 AS node

FROM alpine:3.24
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/lib/libstdc++.so.6* /usr/lib/libgcc_s.so.1 /usr/lib/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
# Root-owned and read-only for the runtime user: works with readOnlyRootFilesystem.
COPY package.json server.js ./
COPY public ./public

# Numeric UID/GID so Kubernetes `runAsNonRoot: true` can verify it.
USER 65532:65532
EXPOSE 8080

CMD ["node", "server.js"]
