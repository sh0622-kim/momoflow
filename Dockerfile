FROM node:22-bookworm-slim AS codex
ARG CODEX_VERSION=0.163.0
RUN npm install --global @openai/codex@${CODEX_VERSION} && npm cache clean --force

FROM elixir:1.19.5-otp-28
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
COPY --from=codex /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && ln -s /usr/local/lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
ARG SYMPHONY_REF=be10a1b79df723d6d7612b5651c8522704dafb2e
RUN git clone https://github.com/openai/symphony.git /opt/symphony \
    && cd /opt/symphony && git checkout --detach "${SYMPHONY_REF}"
WORKDIR /opt/symphony/elixir
COPY patches/github-token-file.patch /opt/momoflow/github-token-file.patch
RUN git -C /opt/symphony apply --check /opt/momoflow/github-token-file.patch \
    && git -C /opt/symphony apply /opt/momoflow/github-token-file.patch
COPY patches/role-flow.patch /opt/momoflow/role-flow.patch
RUN git -C /opt/symphony apply --check /opt/momoflow/role-flow.patch \
    && git -C /opt/symphony apply /opt/momoflow/role-flow.patch
COPY patches/admission.patch /opt/momoflow/admission.patch
RUN git -C /opt/symphony apply --check /opt/momoflow/admission.patch \
    && git -C /opt/symphony apply /opt/momoflow/admission.patch
COPY engine/admission.ex /opt/symphony/elixir/lib/symphony_elixir/admission.ex
COPY engine/role_runner.ex /opt/symphony/elixir/lib/symphony_elixir/role_runner.ex
ENV MIX_ENV=prod
RUN mix local.hex --force && mix local.rebar --force && mix deps.get --only prod && mix build
RUN useradd --create-home --uid 1000 momo \
    && mkdir -p /data/workspaces /data/log /home/momo/.codex /run/momoflow-auth \
    && chown -R momo:momo /data /home/momo /run/momoflow-auth \
    && chmod 700 /run/momoflow-auth
COPY scripts/git-askpass.sh /opt/momoflow/git-askpass.sh
COPY scripts/github-app-auth.mjs /opt/momoflow/github-app-auth.mjs
RUN chmod 755 /opt/momoflow/git-askpass.sh
USER momo
ENV HOME=/home/momo CODEX_HOME=/home/momo/.codex GIT_ASKPASS=/opt/momoflow/git-askpass.sh GIT_TERMINAL_PROMPT=0
EXPOSE 4000
CMD ["./bin/symphony", "--i-understand-that-this-will-be-running-without-the-usual-guardrails", "--port", "4000", "--logs-root", "/data/log", "/config/WORKFLOW.md"]
