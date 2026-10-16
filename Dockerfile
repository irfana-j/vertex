# One container, one Node process: this app's own backend (server/) now
# serves the built client, the /api routes (auth, shared state), and the
# Symphony reverse proxy — nginx is gone, it would just be a second process
# doing a job the backend already does.

FROM node:22-alpine AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Brings in .env.local too (git-ignored, not .dockerignore-excluded) — Vite
# picks it up here and bakes it into the client bundle. The same trade-off
# .env.example calls out: fine for a base URL or a same-origin proxy path,
# not for a real token on anything shared further than this image.
COPY . .
RUN npm run build

FROM node:22-alpine AS server-deps
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS server-build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/dist ./client-dist
ENV CLIENT_DIST=/app/client-dist
ENV PORT=80
ENV DB_PATH=/app/data/app.db
EXPOSE 80
CMD ["node", "dist/index.js"]
