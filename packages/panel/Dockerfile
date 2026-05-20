FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @raiden/panel build

FROM nginx:1.27-alpine

COPY packages/panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/panel/dist /usr/share/nginx/html

EXPOSE 80
