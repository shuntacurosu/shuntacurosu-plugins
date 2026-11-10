# hub — 開発メモ

コードを読めば分かることは書かない。ここにあるのは、読んでも分からない決めごとと、一度はまった落とし穴だけ。

## 変更したら必ず

```bash
claude plugin validate .        # フックモジュールをエンジンと同じ目で検査する
(cd server && node --test)      # 中継ロジック
```

型チェックは `plugin-authoring` スキルを読み込むと型定義ファイルの場所が示されるので、それと `hooks/` `types/` を `include` した tsconfig で `tsc --noEmit` する。

配送の動作は検査では分からないので、`dev/` の検証環境で実際に送って確かめる。見るのは 3 つ: 相手が待機中、相手がツール実行中、相手が長い最終回答の生成中。

## dev/ (利用者は使わない。開発用)

```bash
cd dev
cp .env.example .env               # CLAUDE_CODE_OAUTH_TOKEN を入れる。.env はコミットしない
docker compose up -d --build       # http://localhost:8080 に xterm + tmux のコンソール
./tm.sh say alpha "/hub:rc on"     # コンテナ内の claude を外から操作する (type / say / key / cap)
./tm.sh cap bravo 20
```

- セッションは `alpha@host-a`、`bravo@host-b`、`charlie@host-b`。alpha と bravo/charlie は別ネットワークで、サーバ経由でしか届かない。プラグインはこのフォルダの 1 つ上を読み取り専用でマウントしている。
- プラグインのファイルを保存すると、動いているセッションはホットリロードする。コマンド (`commands/*.md`) を足し引きしたときは `docker compose restart alpha bravo charlie`。再起動後は `rc on` し直す。
- スラッシュコマンドと `@@` の確認はモデルを呼ばない。メッセージを実際に届ける確認は受信側でモデルが動く。
- `dev/console/` は検証専用で、認証が無く docker.sock を握っている。外に出すものではない。中継ロジックは `server/hub.js` をそのまま読み込んでいるので、直すのは `server/` 側だけ。
- `dev/probe/` は「標準の SendMessage と同じタイミングで届けられる」という設計の根拠を測り直すための別プラグイン。Claude Code を更新して配送が怪しくなったら `dev/probe/measure.sh` (冒頭に期待値あり)。

## 配送の設計 (変えるなら理由が要る)

受信は標準の SendMessage と同じタイミングにしてある。

- ターン実行中 → `$.session.append` (user 行)。次のステップでモデルが読む。
- 待機中 → `$.prompt.submit`。新しいターンになる。
- 最終ステップ中に追記すると誰も読まないままターンが終わる。`unreadInTurn` が残っていたら `turn.complete` で起こす。「ツールが終われば次のステップが必ず来る」ので、`tool.call` の完了で 0 に戻している。

試して駄目だったもの:

- 自セッション宛ての `$.session.send` (標準の配送路に乗せる案) は、セッション ID 指定でもソケット指定でも「自分宛て」として拒否される。
- `ui.render` の `UserMessage` は、このプラグイン自身が `$.prompt.submit` した行には呼ばれない。待機中に届いた行を畳んで見せることはできない。だから封筒は短くし、読み方の説明は `send_message` ツールの説明文に置いている。
- `turn.step` はフックしない。モデルの応答ストリームが全部このプラグインを通ることになる。

## エンジン側の制約

- `$` を渡せるのは、ファイル直下の関数宣言だけ (クロージャやアロー関数の変数に渡すと validate が落とす)。`$.env.get` の名前と `$.state` の参照は文字列リテラルで書く。
- `/hub:rc` という名前は `commands/*.md` で宣言して得ている。`$.command.register` は `:` を使えず、素の `rc` は組み込みコマンドの別名と衝突する。代償として `immediate` (ターン実行中の即実行) を指定できない。送信用のスラッシュコマンドを置かず `@@` だけにしているのはこのため。
- `commands/*.md` の本文は、フックが答えなかったときにだけモデルへ渡る。「プラグインが動いていない」と報告させる文面にしてある。
- `{ drop }` したプロンプトはエンジンが入力欄に戻す。送信成功時は自分で消している (`clearDraft`)。
- モジュール変数はリロードで消える。消えて困るのは「on かどうか」だけで、それは `$.state` に置いている。

## 名前 `hub` が埋まっている場所

改名するなら全部そろえる: `plugin.json`、`types/index.d.ts` の `PluginState`、`isOnRef`、ツール名 `mcp__hub__*`、`command.run` の照合、利用者向けの文言。

## server/

- `hub.js` は HTTP を知らない純粋なロジック、`index.js` が HTTP。認証の継ぎ目は `index.js` の `userOf()` だけ。
- これは公開リポジトリの見本。特定の認証基盤や組織の事情を持ち込まない。依存パッケージも足さない。
- 生存判定はロングポールが張られているかどうか。`GRACE_MS` と `TAKEOVER_MS` を変えるときは、強制終了されたセッションの後継が同じ名前と未読を引き継げることをテストで確かめる。

## 文書の分担

`README.md` は使う人向けで、操作だけを書く。構成や実装の話はここに書く。
