---
name: firebase2pocketbase
description: Convert Gemini Canvas React+Firebase JSX files to executable React+PocketBase projects. Analyzes Firebase SDK usage, creates Vite project, generates PocketBase migrations, and verifies in browser.
argument-hint: <path/to/App.jsx>
disable-model-invocation: true
---

# Firebase to PocketBase Converter

このスキルは、Gemini Canvasで生成されたReact+FirebaseのJSXファイルを、PocketBaseバックエンドを使用するReactプロジェクトに変換します。

## 使用方法

```
/firebase2pocketbase path/to/App.jsx
```

---

> [!IMPORTANT]
> ## Windows環境での注意事項
> 
> このワークフローは**Windows + PowerShell**環境を前提としています。
> 
> **シェルコマンドについて**:
> - `Remove-Item`, `Copy-Item` 等はPowerShellコマンドです
> - WSLやGit Bash環境の場合は `rm -f`, `cp -r` 等のUnixコマンドを使用してください
> - エラー `command not found: Remove-Item` が出た場合はBash環境なので、代わりに `rm -f` を使用

> [!TIP]
> ## ファイル編集のベストプラクティス
> 
> **`vite.config.js` や `src/index.css` を編集する際**:
> 1. まず `view_file` でファイル内容を確認
> 2. その後 `replace_file_content` で編集
> 
> **初回Writeでエラーが出た場合**:
> - ファイルがまだ作成されていない可能性があります
> - `npm create vite@latest` 完了後にWriteを実行してください

---

## ワークフロー

以下のステップを**順番に**実行してください。各ステップは前のステップが完了してから実行すること。

---

### Step 1: JSXファイルの解析

1. `$ARGUMENTS` で指定されたJSXファイルを読み取る
2. Firebase SDKの使用箇所を特定:
   - `import ... from 'firebase/app'`
   - `import ... from 'firebase/auth'`
   - `import ... from 'firebase/firestore'`
   - `collection(db, 'コレクション名')` の呼び出し
   - `addDoc`, `updateDoc`, `deleteDoc` のペイロードからフィールド名を抽出
3. 使用されているライブラリを確認（lucide-react等のUI系ライブラリ）

---

### Step 2: Vite Reactプロジェクトの作成

**作業ディレクトリ**: 現在のワークスペース直下（プロジェクトルート）

```powershell
npm create vite@latest ./ -- --template react
npm install
```

#### 2.1 必須依存関係のインストール

```powershell
npm install pocketbase lucide-react
```

#### 2.2 TailwindCSS v4 のセットアップ（必須！）

> **重要**: 現在のnpmはTailwind v4がデフォルト。v4は設定方法がv3と異なる。

**Viteプラグイン方式**（推奨）:

```powershell
npm install tailwindcss @tailwindcss/vite
```

#### 2.3 vite.config.js を更新（Tailwind v4 + Firebase エイリアス）

`vite.config.js` を以下で**完全に上書き**:

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: [
      { find: 'firebase/app', replacement: path.resolve(__dirname, 'firebase_impl/app.js') },
      { find: 'firebase/auth', replacement: path.resolve(__dirname, 'firebase_impl/auth.js') },
      { find: 'firebase/firestore', replacement: path.resolve(__dirname, 'firebase_impl/firestore.js') },
      { find: 'pocketbase', replacement: path.resolve(__dirname, 'node_modules/pocketbase') }
    ]
  },
  define: {
    __firebase_config: JSON.stringify(JSON.stringify({ pocketbaseUrl: "http://127.0.0.1:8090" })),
    __app_id: JSON.stringify("local-app"),
  }
})
```

#### 2.4 src/index.css を更新（Tailwind v4形式）

`src/index.css` を以下で**完全に上書き**（Viteのデフォルトスタイルは削除）:

```css
@import "tailwindcss";
```

> **注意**: v3の `@tailwind base; @tailwind components; @tailwind utilities;` は使わない！

#### 2.5 postcss.config.js を削除（不要）

Viteプラグイン方式では不要。存在する場合は削除:

```powershell
Remove-Item -Path "postcss.config.js" -ErrorAction SilentlyContinue
```

#### 2.6 tailwind.config.js を削除（v4では不要）

v4はCSSファーストでcontent設定不要:

```powershell
Remove-Item -Path "tailwind.config.js" -ErrorAction SilentlyContinue
```

> **注意**: `firebase` パッケージはインストールしない（ラッパーで代替）

---

### Step 3: リソースのコピー

スキルの`resources/`ディレクトリから以下をコピー:

```powershell
# firebase_impl のコピー
Copy-Item -Path "skills\firebase2pocketbase\resources\firebase_impl" -Destination ".\" -Recurse

# pocketbase のコピー
Copy-Item -Path "skills\firebase2pocketbase\resources\pocketbase" -Destination ".\" -Recurse
```

コピー後の構造:
```
./
├── firebase_impl/
│   ├── app.js
│   ├── auth.js
│   └── firestore.js
├── pocketbase/
│   ├── pocketbase.exe
│   └── pb_migrations/
└── src/
```

---

### Step 4: PocketBaseマイグレーションの生成

Step 1で解析したFirestoreコレクションに基づいてマイグレーションスクリプトを生成。

**ファイル名**: `pocketbase/pb_migrations/{timestamp}_create_{collection}.js`

タイムスタンプ例: `1738100000`

```javascript
/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
    const collection = new Collection({
        name: "コレクション名",  // collection(db, 'xxx') から抽出
        type: "base",
        fields: [
            // Step 1で抽出したフィールド
            // String → { name: "fieldName", type: "text", required: true/false }
            // Boolean → { name: "fieldName", type: "bool", required: false }
            // Number → { name: "fieldName", type: "number", required: false }
            // userId → { name: "userId", type: "text", required: false }
        ],
    });

    // ローカル開発用: 全ルールをパブリックに
    collection.listRule = "";
    collection.viewRule = "";
    collection.createRule = "";
    collection.updateRule = "";
    collection.deleteRule = "";

    app.save(collection);
}, (app) => {
    try {
        const collection = app.findCollectionByNameOrId("コレクション名");
        app.delete(collection);
    } catch (_) { }
})
```

---

### Step 5: App.jsx の配置

元のJSXファイルを `src/App.jsx` にコピー。

**変更は不要** - Viteエイリアスがfirebaseインポートを自動的にラッパーに向けます。

---

### Step 6: 動作確認（必須）

> **重要**: `npm run dev`だけではエラー検出不可。必ずブラウザで確認すること！

#### 6.1 PocketBaseを起動

**別ターミナルで**（バックグラウンドで実行）:

```powershell
cd pocketbase
Start-Process -FilePath "pocketbase.exe" -ArgumentList "serve" -NoNewWindow
```

または単純に:

```powershell
cd pocketbase
pocketbase.exe serve
```

初回のみスーパーユーザー作成:
```powershell
pocketbase.exe superuser create admin@example.com password123
```

#### 6.2 Reactアプリを起動

**別ターミナルで**:

```powershell
npm run dev
```

#### 6.3 ブラウザで確認

`browser_subagent` を使用してhttp://localhost:5173 を開き、以下を確認:

**確認項目**:
- ✅ UIが正しくスタイリングされている（Tailwindクラスが効いている）
- ✅ コンソールに `[Firebase Wrapper] Initialized PocketBase at http://127.0.0.1:8090`
- ✅ JavaScriptエラーがない
- ✅ ネットワークタブで `http://127.0.0.1:8090/api/...` へのリクエスト

**エラーがあれば修正**して、再度ブラウザで確認すること。

---

## 完了条件

- [ ] UIが正しくスタイリングされている
- [ ] コンソールエラーがない
- [ ] PocketBaseへの通信が成功している

## トラブルシューティング

### Tailwindが効かない場合
- `vite.config.js` に `tailwindcss()` プラグインがあるか確認
- `src/index.css` が `@import "tailwindcss";` のみになっているか確認
- `postcss.config.js` と `tailwind.config.js` を削除

### PocketBase起動エラー
- `pocketbase.exe serve` を直接実行してエラーメッセージを確認
- ポート8090が使用中なら `--http=127.0.0.1:8091` で別ポート指定

### シェルコマンドエラー

**`command not found: Remove-Item`**:
- Bash環境で実行されています
- PowerShellコマンドの代わりに以下を使用:
  - `Remove-Item` → `rm -f`
  - `Copy-Item` → `cp -r`

**PowerShellが使えない場合の代替コマンド**:
```bash
# ファイル削除
rm -f postcss.config.js tailwind.config.js

# ディレクトリコピー
cp -r "skills/firebase2pocketbase/resources/firebase_impl" ./
cp -r "skills/firebase2pocketbase/resources/pocketbase" ./
```

### ブラウザ確認について

> [!CAUTION]
> `web_fetch` ツールは `localhost` URLでは動作しません。ローカル開発サーバーの確認には `browser_subagent` を使用してください。

**推奨方法**:
```
browser_subagent を使用して http://localhost:5173 を開き、UIとコンソールを確認
```

### Write/Editエラー

**`Error writing file` が発生する場合**:
1. `npm create vite@latest` が完了しているか確認
2. ターゲットファイルが存在するか確認
3. 並列実行でエラーが出た場合は、順次実行で再試行

---

## 参考資料

- [TailwindCSS v4 with Vite](https://tailwindcss.com/docs/installation/vite)
- [PocketBase Docs](https://pocketbase.io/docs/)
