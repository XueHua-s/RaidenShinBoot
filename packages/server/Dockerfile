FROM node:22-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY config ./config
COPY personas ./personas

RUN pnpm install --frozen-lockfile
RUN pnpm -r --sort build

EXPOSE 8787

CMD ["pnpm", "--filter", "@raiden/server", "start"]
