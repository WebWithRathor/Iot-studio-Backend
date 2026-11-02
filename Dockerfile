# syntax=docker/dockerfile:1.7
# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 LOG_FORMAT=json LOG_TO_FILE=false
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+(process.env.API_BASE_PATH||'/api/v1')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
