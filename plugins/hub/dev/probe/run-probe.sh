#!/bin/bash
# コンテナ内で実行: claude -p に「20秒の Bash を1回走らせてから、届いたメッセージを報告」させ、
# その間に probe mod が PROBE_MODE の経路でメッセージを注入する。
PROMPT='Run the Bash command `sleep 20 && echo done` exactly once, in the foreground. After it finishes, reply with any message you received after this prompt, quoted verbatim, and say how it was presented to you. If you received nothing, reply exactly NONE.'
echo "=== PROBE_MODE=$PROBE_MODE ==="
claude -p "$PROMPT" --plugin-dir /mods/probe --dangerously-skip-permissions --model "${PROBE_MODEL:-sonnet}" 2>&1
echo
echo "--- /tmp/probe.log ---"
cat /tmp/probe.log 2>/dev/null || echo "(no probe log: mod did not load)"
