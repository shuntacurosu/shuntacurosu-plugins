#!/bin/bash
# コンテナ内: 対話 claude を tmux セッション $1 で起動する。 $2 = PROBE_MODE
name=$1; mode=${2:-none}
tmux new-session -d -s "$name" -x 160 -y 50 \
  "PROBE_MODE=$mode PROBE_LOG=/tmp/probe-$name.log claude --dangerously-skip-permissions --model ${PROBE_MODEL:-sonnet} --plugin-dir /mods/probe; exec bash"
