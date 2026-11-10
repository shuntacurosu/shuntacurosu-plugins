#!/bin/bash
# 検証環境 (docker-compose.yml) のセッションコンテナの tmux を、外から操作する。
#   tm.sh type <container> <text>   文字を打つ (Enter なし)
#   tm.sh say  <container> <text>   文字を打って Enter
#   tm.sh key  <container> <key>..  tmux のキー名を送る (Enter, Tab, Escape, C-c ...)
#   tm.sh cap  <container> [lines]  画面を表示 (空行を除いた末尾 lines 行)
export MSYS_NO_PATHCONV=1
cmd=$1; c=$2; shift 2
case "$cmd" in
  type) docker exec "$c" tmux send-keys -t main -l "$1" ;;
  say)  docker exec "$c" tmux send-keys -t main -l "$1"; sleep 0.6; docker exec "$c" tmux send-keys -t main Enter ;;
  key)  docker exec "$c" tmux send-keys -t main "$@" ;;
  cap)  docker exec "$c" tmux capture-pane -p -t main | grep -v '^\s*$' | tail -n "${1:-25}" ;;
  *) echo "usage: tm.sh type|say|key|cap <container> ..." >&2; exit 2 ;;
esac
