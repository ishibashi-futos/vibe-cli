# Hook 機能

## 概要

- Agent Loop の `analyze` `execute` `verify` `done` 各フェーズと、message / tool / session の主要イベントに対して hook を差し込める基盤を導入する。
- hook は 2 系統に分ける。
  - 内部 hook: `src/hooks` 配下に実装し、アプリ内部サービスとして使う。session persistence などをここに置く。
  - 公開 hook: workspace の `.agents/hooks/<hookName>/index.ts` に配置し、`.agents/vibe-config.json` から有効化する。
- 公開 hook は品質ゲートなどの用途で、Node/Bun を用いた任意コード実行を行える。

## 目的

- session persistence や workflow gate を、chat loop / exec loop に散らばった個別ロジックではなく、共通の hook 基盤で扱えるようにする。
- `done` フェーズで `bun run sanity` のような品質ゲートを強制し、失敗時に最終化を止めて自己修復ループへ戻せるようにする。
- chat / exec で共通のイベント面を持ち、将来の監査、通知、独自ガード、メトリクス収集を同じ仕組みで拡張できるようにする。

## 非目的

- リモート URL から hook をロードすること
- shell command hook や webhook hook を設定ファイルだけで宣言すること
- hook による message や tool 結果の書き換え、イベント cancel、モデル応答の直接差し替え
- hook author 向けの型配布や SDK 整備

## 配置と公開面

### 内部 hook

- 内部 hook と dispatcher は `src/hooks` に集約する。
- built-in の session persistence、workflow gate、phase gate、public hook loader をここに置く。
- 内部 hook は非公開で、設定ファイルから差し替えない。

### 公開 hook

- 公開 hook の配置先は `.agents/hooks/<hookName>/index.ts` に固定する。
- `hookName` は config key とディレクトリ名を一致させる。
- `hookName` に path separator を含めることは認めない。
- 外部 module の解決先は上記 1 箇所に限定し、任意 path 指定は許可しない。

### 設定

`.agents/vibe-config.json` に次を追加する。

```json
{
  "hooks": {
    "sanity": {
      "on_error": "warn",
      "phases": {
        "done": true
      },
      "config": {
        "command": ["bun", "run", "sanity"]
      }
    }
  }
}
```

- `hooks` は object 形にする。
- public hooks の実行順は JSON object の宣言順とする。
- 各 entry は次を持てる。
  - `on_error?: "warn" | "abort"`
  - `phases?: { analyze?: boolean; execute?: boolean; verify?: boolean; done?: boolean }`
  - `config?: Record<string, unknown>`
- `on_error` の既定値は `warn`。
- `phases` 未指定時は、hook 側が受け取る全イベントを対象にする。

## Hook モジュール契約

- 公開 hook module は default export で hook object または factory を返す。
- factory には初期化 context を渡す。
- hook は少なくとも `handle(event, context)` を実装できる。
- `dispose()` は optional とする。
- hook author は plain JS / TS module を書く前提とし、型 import は必須にしない。

初期化 context の最低限の内容:

- `hookName`
- `workspaceRoot`
- `hookRoot`
- `config`
- `modeCapabilities`

## イベントとフェーズ

### フェーズ

- Agent Loop のフェーズを `analyze`, `execute`, `verify`, `done` の 4 つに定義する。
- chat / exec ともに同じ語彙を使う。
- `done` は最終応答確定直前のフェーズとする。

### 主要イベント

- `run.started`
- `run.completed`
- `run.failed`
- `session.started`
- `session.loaded`
- `session.reset`
- `session.state.changed`
- `message.appended`
- `model.requested`
- `model.responded`
- `tool.call.started`
- `tool.call.completed`
- `slash.executed`
- `phase.entered`
- `phase.check`

### 適用面

- フェーズ hook は `analyze` `execute` `verify` `done` の全フェーズで走らせる。
- `session.*` と `slash.executed` は chat 専用イベント。
- それ以外は chat / exec 共通イベントとする。

## 実行モデル

- dispatcher は built-in hooks を先に、public hooks を後に、逐次 `await` で実行する。
- hook は Node/Bun を使って任意コード実行してよい。
- ただし hook の戻り値は structured result に統一し、本体はそれを解釈して次動作を決める。

### HookResult

hook は次のいずれかを返せる。

- `continue`
- `warn`
- `fail`
- `block_finalize`

追加で `artifacts` を返せるようにする。

- `stdout`
- `stderr`
- `exitCode`
- `summary`
- `metadata`

### エラー時ポリシー

- `on_error=warn`: hook 例外をログに出して継続する。
- `on_error=abort`: hook 例外をそのまま main flow の失敗にする。
- `HookResult.kind="fail"` は phase 失敗扱いにする。
- `HookResult.kind="block_finalize"` は `done` フェーズでのみ有効とし、最終化を拒否する。

## 品質ゲート

- `done` フェーズでは `phase.check` を必須実行する。
- 例として `.agents/hooks/sanity/index.ts` が `bun run sanity` を直接実行し、成功しない限り finalize を通さない。
- 失敗時は次の挙動にする。
  - 最終化を拒否する
  - 失敗要約と標準出力 / 標準エラー要約を継続メッセージとして会話へ注入する
  - モデルに自己修復と再検証を促す
- 複数の `done` hook がある場合は宣言順に実行し、最初の `block_finalize` または `fail` でその周回の finalize を止める。

## 既存 workflow gate との関係

- 既存の analysis / task setup / verification の必須条件は、built-in の phase gate として `src/hooks` へ寄せる。
- mutation 前の直接ブロックは従来どおり維持できるが、最終化前の必須条件判定は phase hook に寄せる。
- `task_validate_completion` と mutation 後 verification の要件は、`verify` / `done` フェーズの built-in gate として整理する。

## session persistence との関係

- session persistence は built-in hook として実装する。
- 保存対象は chat のみ。
- `.agents/sessions/` への JSONL 追記は `message.appended`, `session.state.changed`, `session.*`, `hook_event` を使って実現する。
- `resume` / `/resume` は session persistence hook の loader を共有して実装する。

## テスト

### 設定 / loader

- `.agents/hooks/<hookName>/index.ts` を解決できる
- 不正な hook 名を reject できる
- object 宣言順で実行される
- `on_error` と `phases` を読める

### ランタイム

- built-in → public の順で逐次実行される
- `warn` は継続、`abort` は main flow を失敗させる
- `analyze` `execute` `verify` `done` の各 phase で event が発火する
- `tool.call.completed` に blocked / invalid / unavailable が反映される

### 品質ゲート

- `bun run sanity` 成功で Done を通す
- `bun run sanity` 失敗で finalize を拒否し、結果を会話へ注入する
- 修復後の再試行で通過できる

### session persistence 連携

- hook event が session log に残る
- resume 後も hook 前提の state が維持される

## 既定値と前提

- public hooks は `.agents/hooks/` 配下のローカル module のみを対象にする。
- public hooks は Node/Bun を直接使って任意コード実行できる。
- hook は観測と phase 判定まではできるが、message や tool 結果の書き換えは行わない。
- built-in hooks は `src/hooks` に閉じ、public hook と同じ interface で扱うが外部公開しない。
