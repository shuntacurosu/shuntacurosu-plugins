# セッションコンテナ: tmux の中で claude を動かす「リモートホスト」1台ぶん
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps less jq locales \
 && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_VERSION=2.1.322
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION}

RUN useradd -m -s /bin/bash dev && mkdir -p /workspace /mods && chown dev:dev /workspace
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 TERM=xterm-256color

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER dev
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["session"]
