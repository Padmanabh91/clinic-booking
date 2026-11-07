# Clinic Booking: production image.
# Node 22 is the LTS line the app supports (package.json "engines"); 22.13+ has node:sqlite
# without a flag. The slim Debian image keeps the image small.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/clinic.db

WORKDIR /app

# Production dependencies only (Express). Playwright and axe are for tests and are left out.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# The SQLite file lives in a volume at /data so it survives new containers.
# The app runs as the unprivileged "node" user that the base image provides.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run node directly (not through npm) so it receives SIGTERM from "docker stop" and can
# close the database cleanly.
CMD ["node", "src/server.js"]
