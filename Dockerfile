FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    SERVER_IP=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build /app/index.js ./index.js
COPY --from=build /app/config ./config
COPY --from=build /app/middlewares ./middlewares
COPY --from=build /app/routes ./routes
COPY --from=build /app/services ./services
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 7776 8776
CMD ["node", "index.js"]
