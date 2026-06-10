# LogWatch Panel container image.
FROM node:26-bookworm-slim

# Build tools for better-sqlite3 (only used if a prebuilt binary isn't available).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY panel/package*.json ./panel/
RUN cd panel && npm install --omit=dev --no-audit --no-fund

COPY panel ./panel
COPY agent-bin ./agent-bin
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8088 \
    DB_PATH=/data/logwatch.db \
    AGENT_BIN_DIR=../agent-bin

VOLUME /data
EXPOSE 8088
WORKDIR /app/panel

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8088)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
