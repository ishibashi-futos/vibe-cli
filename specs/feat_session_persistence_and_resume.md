# セッション永続化と Resume

## 概要

- chat モードの会話履歴とツール呼び出し履歴を、session persistence built-in hook 経由で append-only な JSONL として `.agents/sessions/yyyyMMddhhmmss-{sessionuuid}.jsonl` に保存する。
- 既存セッションを再開するために、`resume` サブコマンドと `/resume` スラッシュコマンドを追加する。
- セッション指定なしの resume は、最近のセッション一覧を対話的に選択する。
- v1 の対象は chat モードのみとし、`exec` セッションの保存・再開は行わない。
- 本機能は `src/hooks` 配下の内部 hook 基盤を前提に実装する。

## 目的

- 過去の chat セッションを十分な精度で復元し、そのまま次のモデルターンを継続できるようにする。
- ツール呼び出し履歴を会話の一部として保存し、監査性と resume 時の正しさを両立する。
- 挙動に影響するセッション内状態を保存する。
  - current model
  - chat workflow gate の状態
  - last usage
  - cumulative usage
- phase hook の結果、特に品質ゲートや finalize 拒否の記録も残せるようにする。
- 保存形式は append-only とし、部分書き込みやプロセス中断に対して壊れにくくする。

## 非目的

- `exec` モードの保存・再開
- ターミナル入力欄の履歴や HistoryManager 状態の復元
- セッション保持期間、クリーンアップ、圧縮、世代管理
- resume 時にデフォルトで新しいセッションファイルへ分岐すること
- session persistence を公開 hook として差し替え可能にすること

## 保存モデル

### 保存先

- セッションファイルは workspace 直下の `.agents/sessions/` に保存する。
- `-c/--config-file` で別の設定ファイルを指定しても、保存先は変えない。
- `.gitignore` に `.agents/sessions/` を追加する。
- 保存処理は `src/hooks` の built-in session persistence hook が担う。

### ファイル名

- 形式は `yyyyMMddhhmmss-{sessionuuid}.jsonl`
- `yyyyMMddhhmmss` はローカル時刻を使う。
- `sessionuuid` は生成した UUID を使う。

### イベントログ形式

1 行 1 イベントの append-only JSONL を使う。イベントのタイムスタンプは ISO8601 UTC とする。

最低限必要なイベント種別は次の 4 つ。

1. `session_meta`
   - schema version
   - session id
   - created timestamp
   - workspace root
   - config file path
   - mode=`chat`

2. `session_state`
   - current model
   - workflow gate の on/off
   - last usage
   - cumulative usage

3. `message`
   - `messages` に積んだものと同一の chat message payload
   - `role` をそのまま保持する
   - assistant の `tool_calls` を保持する
   - tool message の `tool_call_id` を保持する
   - tool message の content はメモリ上の値をそのまま保持する

4. `hook_event`
   - phase 名
   - hook 名
   - result kind
   - summary
   - artifacts 要約

会話コンテキスト復元のソースオブトゥルースは `message` ストリームとする。ツール履歴は assistant の `tool_calls` と、それに続く `tool` メッセージの組で復元する。`hook_event` は resume の厳密な再実行には使わないが、監査とデバッグに使う。

## 読み込みと復旧ルール

- セッション読み込み時に次を復元できること。
  - `messages`
  - current model
  - workflow gate の状態
  - last usage
  - cumulative usage
  - session metadata
- `hook_event` は監査用に読み込めること。ただし resume 時の会話コンテキスト復元は `messages` と `session_state` を正とする。
- ファイル末尾に壊れた JSON 行や途中までの JSON 行が 1 行だけ存在する場合、その最終行は無視して残りを読み込む。
- 保存済みメッセージ列の末尾に未完了の assistant tool-call ターンがある場合、その未完了部分を切り落としてから resume する。
  - 例: `tool_calls` を持つ assistant message はあるが、対応する `tool` message が 1 つ以上欠けている。
  - この場合、その assistant tool-call message から末尾までは破棄する。
- 保存されていた model が現在の config に存在しない場合は、現在の config の default model にフォールバックし、警告を表示する。会話メッセージ自体は保存内容をそのまま利用する。

## ランタイム挙動

### 新規 chat セッション

- chat モード開始時に新しい session file を作成する。
- 初期 system message と初期 session state を即座に保存する。
- 内部 hook ランタイムと session persistence built-in hook を初期化する。

### 通常の chat ターン保存

メモリ上の状態が変わるのと同じ論理タイミングで保存する。

- user message を追加したとき
- assistant final message を追加したとき
- assistant tool-call message を追加したとき
- tool result message を追加したとき
- `/model` で current model が変わったとき
- `/workflow` で gate 状態が変わったとき
- モデル応答後に usage 集計が変わったとき
- phase hook が `block_finalize` / `fail` / `warn` を返したとき

### `/new`

- 現在と同様に in-memory の chat 状態をリセットする。
- 新しい session file を開始する。
- 新しい system message と初期 state をそのファイルへ保存する。

### `/resume`

- 現在の in-memory session を、選択した保存済みセッションで置き換える。
- 再開後は、その既存 session file に対して追記を続ける。
- v1 では新規ファイルへの clone や fork はしない。
- 引数なしの場合は最近のセッション picker を開く。
- 引数ありの場合は次の順で解決する。
  - 明示的な path
  - 正確な basename
  - `.jsonl` を除いた basename
  - 一意に決まる UUID suffix
- 解決できない、または複数候補がある場合はエラーを表示し、現在の in-memory session は変更しない。

### `resume` サブコマンド

- `vibe-cli resume [session]` は、指定セッションを読み込んだ状態で chat を開始する。
- `[session]` 省略時は `/resume` と同じ最近のセッション picker を開く。
- 読み込み処理と検証ルールは `/resume` と共有し、別実装にしない。
- hook ランタイムは読み込み後の state を前提に再初期化する。

## UI / UX

### セッション picker

- 最近更新された順に並べる。
- ラベルには少なくとも次を含める。
  - updated timestamp
  - model
  - 最初の user message の preview

### Help と Status

- CLI の help / ドキュメントに `resume` を追加する。
- slash command help に `/resume` を追加する。
- `/status` に current session id と session file path を表示する。
- phase hook が有効な場合は、有効 hook 名も表示できるようにする。

## インターフェース変更

### CLI 引数

CLI 引数解析に resume 用の分岐を追加する。

- `mode: "resume"`
- optional な `sessionSelector`

### Console IO

CLI `resume` と `/resume` の両方で同じ picker を使えるように、Console IO 抽象にセッション選択 API を追加する。

### Hook 連携

session persistence は独立サービスではなく built-in hook として扱うため、次の型とも接続する。

- `HookEvent`
- `HookResult`
- `BuiltInHook`

### セッション関連型

永続化と読み込みのために、少なくとも次の型を追加する。

- `SessionEvent`
- `SessionStateSnapshot`
- `SessionSummary`
- `LoadedSession`

## テスト

### CLI

- `resume` を parse できる
- `resume <selector>` を parse できる
- `-c ... resume ...` を parse できる
- 不正な引数形を reject できる

### Session Store

- 期待どおりの file path を生成する
- state / messages の append と reload が正しく動く
- hook_event の append ができる
- path / basename / UUID suffix の解決ができる
- 壊れた trailing line を無視できる
- 未完了の assistant tool-call tail を切り落とせる

### Chat Loop

- chat 開始時に session file が作られる
- 通常会話中に messages と state update が追記される
- done フェーズの hook 結果が session log に残る
- `/new` で新しい file に切り替わる
- `/resume` で messages / model / workflow / usage を復元できる
- 保存済み model が無効でも fallback できる
- `/status` に session 情報が表示される

### ドキュメント

- README に保存先、`resume`、`/resume` が記載される

## 既定値と前提

- v1 で保存対象にするのは chat セッションのみ。
- selector なしの resume は対話 picker を使う。
- resume 時のコンテキスト復元では、保存済み会話を正とする。
- 入力履歴の復元は v1 では意図的に対象外とする。
- 自動 retention や pruning は v1 では実装しない。
- session persistence は `src/hooks` 配下の built-in hook として常時有効にする。
