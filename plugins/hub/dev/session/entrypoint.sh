#!/bin/bash
# セッションコンテナの入口。
#   session (既定): オンボーディング済みの設定を置き、tmux セッション "main" で claude を起動して常駐
#   それ以外       : 渡されたコマンドをそのまま実行 (claude -p での単発検証用)
set -e

# 対話起動時にログイン/テーマ選択/信頼ダイアログで止まらないようにする
if [ ! -f "$HOME/.claude.json" ]; then
  cat > "$HOME/.claude.json" <<'JSON'
{
  "hasCompletedOnboarding": true,
  "bypassPermissionsModeAccepted": true,
  "theme": "dark",
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true
    }
  }
}
JSON
fi
mkdir -p "$HOME/.claude"
if [ ! -f "$HOME/.claude/settings.json" ]; then
  echo '{"skipDangerousModePermissionPrompt": true}' > "$HOME/.claude/settings.json"
fi

if [ "$1" != "session" ]; then
  exec "$@"
fi

PLUGIN_ARGS=""
for d in /mods/*/; do
  [ -f "${d}.claude-plugin/plugin.json" ] && PLUGIN_ARGS="$PLUGIN_ARGS --plugin-dir ${d%/}"
done

tmux new-session -d -s main -x 200 -y 50 \
  "claude --dangerously-skip-permissions ${CLAUDE_MODEL:+--model $CLAUDE_MODEL} $PLUGIN_ARGS ${CLAUDE_EXTRA_ARGS}; exec bash"
tmux set-option -t main history-limit 50000 >/dev/null
tmux set-option -g mouse on >/dev/null

# tmux が生きている間コンテナを生かす
while tmux has-session -t main 2>/dev/null; do sleep 2; done
