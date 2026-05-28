FROM node:18-alpine AS base
RUN apk add --no-cache git

FROM base AS builder
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile --production=false
COPY . .
RUN yarn build
COPY database ./dist/database

FROM base
WORKDIR /app
COPY package.json yarn.lock* ./
RUN yarn install --frozen-lockfile --production && yarn cache clean
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/database/ ./database/

ARG VERSION
ENV VERSION=${VERSION}
ARG ENVIRONMENT
ENV ENVIRONMENT=${ENVIRONMENT}

ENV NODE_ENV=production
ENV TZ=Etc/GMT

EXPOSE 3000

CMD ["sh", "-c", "yarn start"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1
