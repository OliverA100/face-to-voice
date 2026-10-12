# The character agent for LiveKit Cloud agent hosting (`lk agent create` / `lk agent deploy` build this) or any
# container host. Node runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:24-slim

ENV NODE_ENV=production
# The framework's info, warn and error lines can carry what the visitor and the character said ("lk.pii.*" fields,
# not redacted on stdout): only fatal ones reach the host's logs. The agent's own [ftv] lines are numbers only.
ENV LOG_LEVEL=fatal
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY src ./src

# A non-root user, as LiveKit's agent templates do.
RUN useradd --create-home --uid 10001 agent
USER agent

CMD ["node", "src/main.ts", "start"]
