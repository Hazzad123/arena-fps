# Two stages: build the client with Vite, then serve it from the Node server.
# The result is one container on one port — the game and its server are the same
# process, so there's nothing to wire together at deploy time.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so a source-only change doesn't reinstall everything.
COPY package.json package-lock.json ./
RUN npm ci

COPY vite.config.js ./
COPY shared ./shared
COPY client ./client
RUN npm run build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Production dependencies only — Vite and friends aren't needed to serve.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist

# Don't run as root.
USER node

EXPOSE 3000

# The health endpoint the platform can poll. Reads PORT at runtime rather than
# hardcoding 3000, because hosts like Render inject their own port and a
# hardcoded probe would report the container unhealthy forever.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
