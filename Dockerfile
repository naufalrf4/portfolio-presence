# syntax=docker/dockerfile:1.7
FROM docker.io/oven/bun:1.3.14 AS dev
WORKDIR /app
COPY package.json ./
COPY src ./src
CMD ["bun", "run", "dev"]

FROM docker.io/oven/bun:1.3.14 AS builder
WORKDIR /app
COPY . .

FROM docker.io/oven/bun:1.3.14 AS prod
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3006
COPY --from=builder /app /app
USER bun
EXPOSE 3006
CMD ["bun", "run", "start"]
