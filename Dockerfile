# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY dashboard/public ./dashboard/public
COPY config/example.yaml ./config/example.yaml
RUN mkdir -p /data /config && chown node:node /data /config
USER node
VOLUME ["/data"]
EXPOSE 4747
ENV DROPCATCH_CONFIG=/config/config.yaml
ENTRYPOINT ["node", "dist/index.js"]
# Headless watcher by default. Use `dashboard --host 0.0.0.0` for the web UI inside the container.
CMD ["watch"]
