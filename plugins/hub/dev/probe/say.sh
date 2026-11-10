#!/bin/bash
# コンテナ内: tmux セッション $1 のプロンプトに $2 を打ち込んで Enter する
tmux send-keys -t "$1" -l "$2"
sleep 0.5
tmux send-keys -t "$1" Enter
