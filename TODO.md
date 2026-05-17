# TODO — Post-release doc improvements

リリースレビュー（2026-05-18, spec3 ブランチ）で抽出された推奨修正と任意改善のトラッキング。すべて互換破壊なしに追補可能。

## 推奨修正（patch リリース相当で対応推奨）

### 規範整合性

- [ ] **SPEC.md:207 lowercase `must` を MUST に格上げ**
  `Adapters MUST ignore unknown top-level fields. ... older adapters that do not recognize them must still bind successfully` — 後半 lowercase で規範力を失う。「ignore は規範、bind 成功は努力目標」と読まれかねない。

- [ ] **SPEC-extensions.md:128 "producer-side proxy" → "producer-side shell"**
  同文書の他箇所（L401, L516, L633, L772）と § Naming: factory vs class の定義は一貫して producer 側 = Shell、consumer 側 = Proxy。L128 のみ用語不整合。

- [ ] **SPEC-extensions.md § Methods — fire-and-forget `set` の JsonValue 検証必須条件を 1 箇所に集約**
  `set` 行は「Extension 2 採用時のみ JsonValue 検証」と読める一方、§ Pre-sync call state machine は「call site で MUST」と書く。Extension 1 単独実装で検証必須性が分岐。「Ext 2 採用時 MUST / Ext 1 単独時 SHOULD」など条件分岐を明示。

- [ ] **SPEC-extensions.md § Design invariants invariant 3 に producer 側 `cmd.args[i]` 検証 MUST を明記**
  現状は `args` が配列であることまでしか書かず、各要素の検証必須性は `WC_BINDABLE_INVALID_JSON_VALUE` 行からの逆引きでしか確認できない。「producer は inbound `set.value` / `cmd.args[i]` の各要素を JsonValue で検証 MUST」を 1 行追加。

### CONFORMANCE.md ベクトル補強（normative MUST 対応）

- [ ] **vector: `WC_BINDABLE_PRE_SYNC_QUEUE_FULL`**
  § Pre-sync queue depth bound (MUST) — default 1024、既存退避禁止、`set()` 同期 throw / `setWithAck`/`invoke` already-rejected Promise。grep 0 件。`maxPreSyncQueue: 2` で 3 件目 reject + 既存 2 件温存のシナリオ推奨。

- [ ] **vector: `syncTimeoutMs` 経過時の drain**
  producer 無応答 → デフォルト 30s で TerminalFailure、pending を caller order で `WC_BINDABLE_PROTOCOL_ERROR` reject。暗黙無限待機が naive smoke test を通過する典型パターン。

- [ ] **vector: `setWithAck` / `invoke` 未宣言名拒否**
  vector 17 は `set()` 同期 throw のみ。**Promise reject** 経路での `WC_BINDABLE_UNDECLARED_INPUT` / `WC_BINDABLE_UNDECLARED_COMMAND` 未検証。

- [ ] **vector: Mixed-method call-order preservation**
  § Call-order preservation MUST。`setWithAck("a"); invoke("b"); setWithAck("c")` 等の三方向順序保存を直接アサート。vector 17 は default vs low-latency profile 比較が主目的のため独立ベクトル要。

- [ ] **SPEC-extensions.md § Conformance summary に vector 31 / 32 を追加**
  現列挙：5, 6, 7, 9, 10, 15, 20, 21, 22, 23, 24, 25, 26, 27, 29, 30, 34, 35, 36, 37。Ext2 専用の 31（`getterFailures`）と 32（malformed `update` drop+warn）が抜けている。

### ユーザー体験

- [ ] **README.md:194-206 React Quick start に `customElements.define` 前提を明記**
  `<my-input ref={ref} />` を JSX で使うには登録済みが前提だが、Vanilla 節と切り離して読むと「コピペで動かない」。1 行注記または最小登録コード再掲。

- [ ] **README.md:235-243 Examples 表に取りこぼし対応**
  Packages 表は 19 全列挙、Examples は 6 行のみ。`examples/` 配下に `lit-todo` 等 20+ ディレクトリ実在。「他アダプターは `examples/<framework>/` 参照」を注記または表拡張。

---

## 任意改善（次回ドキュメント更新サイクルで）

### 規範強化

- [ ] `syncTimeoutMs` の最小値・無効値（0 / 負 / NaN）の挙動を `AckOptions.timeoutMs` 並みに規定
- [ ] `update` で producer が undeclared name を送った場合の producer-side rule を MUST NOT に倒すか、SHOULD の理由を 1 行添える
- [ ] `return.value` の JsonValue 検証失敗時 → `throw` 変換と `id` 重複規約の関係を明示（「`id` echo は最初の応答なので duplicate-id 規約の対象外」を補足）
- [ ] `onClose` 発火と `dispose()` 自己呼び出しの順序を明示（TerminalFailure 二重起動リスク回避）
- [ ] prototype-pollution 三語（`__proto__` / `constructor` / `prototype`）を「matched case-sensitively」と明示（`@wc-bindable/` プレフィックスとの非対称解消）

### CONFORMANCE.md 追補候補

- [ ] vector: `WC_BINDABLE_INVALID_RETURN_VALUE`（producer が返値を `throw` に変換するパス）
- [ ] vector: Pre-aborted `AbortSignal`（wire 送信なしで即 reject MUST）
- [ ] vector: Wire envelope unknown-fields rule の forward-compat MUST
- [ ] vector: Application-throw `code` pass-through（`throw.error.code === "MYAPP_X"` がそのまま届く）
- [ ] vector: `reconnect()` on disposed proxy が同期 throw する分岐（vector 28 本文記述あり、Expected で未アサート）

### 編集・整合性

- [ ] README.md:144 "All 19 packages" を「現状 19 パッケージ」と弱めるか数字を落とす（ドリフト対策）
- [ ] README.md:7 の bind target 定義の二重括弧を整理し、SPEC.md § Role model にリンク委譲
- [ ] SPEC-extensions.md:1058 "§ sync response capabilities" リンクラベルとアンカー名の乖離解消
- [ ] Conformance Levels facet shorthand の `+` と `,` 使い分けを SPEC 側で 1 文明示
- [ ] SPEC-extensions の 0.7.x divergence 参照に vector 6 の番号を併記（README と表記揃え）
- [ ] README.md:252-263 "Web Components as invisible service layers" の見出し階層を 1 段深くする（実行手順と概念解説の混在解消）
