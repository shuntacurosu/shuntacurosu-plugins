#!/bin/bash
# 「mod でターン実行中にメッセージを差し込めるか」を経路別に測り直す。
# Claude Code を更新して配送の挙動が変わっていないか確かめたいときに使う (モデルを 3 回呼ぶ)。
#
#   CLAUDE_CODE_OAUTH_TOKEN=... ./measure.sh            # append / selfsend / submit を順に
#   CLAUDE_CODE_OAUTH_TOKEN=... ./measure.sh append     # 1 つだけ
#
# 各回、claude -p に 20 秒の Bash を走らせ、開始 8 秒後に probe mod がその経路でメッセージを入れる。
# 出力の時系列で「inject」と、その後の「turn.step」の時刻を見る。期待値 (2.1.322):
#   append   … Bash 完了直後の turn.step で読まれ、回答に合言葉 PINEAPPLE-42 が出る
#   selfsend … isDelivered:false (自分宛ては拒否される)。回答は NONE
#   submit   … ターン終了後に別ターンとして届く
#
# 標準の SendMessage との比較は対話セッションが要る: コンテナ内で interactive.sh を 2 回
# (A none / B none) 起動し、A に `bash /mods/probe/wait.sh 30` を実行させている間に
# B から SendMessage させ、/tmp/probe-A.log の session.receive と turn.step の時刻を見る。
set -eu
: "${CLAUDE_CODE_OAUTH_TOKEN:?set CLAUDE_CODE_OAUTH_TOKEN}"

here=$(cd "$(dirname "$0")" && pwd)
if command -v cygpath >/dev/null 2>&1; then here=$(cygpath -w "$here"); fi
export MSYS_NO_PATHCONV=1

docker build -q -t hub-dev-session "$(dirname "$0")/../session" >/dev/null

for mode in "${@:-append selfsend submit}"; do
  for one in $mode; do
    docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN -e PROBE_MODE="$one" -e PROBE_MODEL="${PROBE_MODEL:-sonnet}" \
      -v "$here:/mods/probe:ro" hub-dev-session bash /mods/probe/run-probe.sh
    echo
  done
done
