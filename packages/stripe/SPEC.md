# stripe-checkout Specification

## 1. Overview

`stripe-checkout` は Stripe 決済を HAWC アーキテクチャに載せる。HAWC 分類上は **Case C(browser-anchored execution Shell)** に属する。

- **なぜ Case C か**: Stripe Elements の card input は PCI / XSS 隔離のため iframe として DOM に mount される必要があり、これは WebSocket 越しにサーバー Core へ委譲できない platform-anchored execution である。
- **なぜ Core が必要か**: PaymentIntent / SetupIntent の作成には `STRIPE_SECRET_KEY` が必須で、これをブラウザに渡せば PCI / 認可の両方で破綻する。webhook 検証も同様にサーバー側でしか成立しない。

### s3-uploader との同型性

`s3-uploader` と構造的に双子。

| 観点 | s3-uploader | stripe-checkout |
|---|---|---|
| 機密 payload | file bytes | card detail(number / CVC / exp) |
| データ経路 | Browser → presigned URL → S3(直送) | Browser → Elements iframe → Stripe(直送) |
| control plane | WebSocket(sign / complete) | WebSocket(createIntent / notify) |
| サーバー通過量 | O(connections), not O(bytes) | O(connections), not O(card ops) |

「機密 payload はサーバーを経由させず、control plane だけ WebSocket で」というパターンがそのまま適用される。

---

## 2. Design Principles

1. **Data plane bypass** — card data は Stripe Elements iframe が直接 Stripe に送る。`stripe-checkout` の JS、アプリの JS、我々のサーバーのいずれも card number / CVC に触れない。
2. **Core owns secrets** — `STRIPE_SECRET_KEY` はサーバー Core のみが保持。webhook signature 検証もサーバー Core。
3. **Publishable key は Shell が持つ** — `pk_live_...` は公開情報なので Shell / config 経由で可。
4. **Control plane over WebSocket** — intent 作成依頼、confirmation 結果の通知、webhook 起因の状態更新のみが流れる。
5. **amount の決定権はサーバー** — Shell から来た値は**ヒント**として扱い、サーバー側の `registerIntentBuilder` が最終値を決める(未登録なら `createIntent` RPC は失敗する)。
6. **Provider abstraction は v1 では載せない** — Stripe 専用として最短で出す。PayPal / Square / Adyen は `payment-abstract` 抽象として将来上載せする。

---

## 3. Architecture

```
┌──────────────────────────────── BROWSER (Shell) ─────────────────────────────┐
│                                                                               │
│   <stripe-checkout mode="payment" amount-value="1980" amount-currency="jpy">     │
│                                                                               │
│   ┌─────────────────────┐        ┌───────────────────────────────────┐       │
│   │  StripeShell        │        │  Stripe Elements (iframe)          │       │
│   │  (HTMLElement)      │◄──────►│  - card number                     │       │
│   │                     │ mount  │  - CVC                             │       │
│   │  status             │        │  - expiry                          │       │
│   │  loading            │        │  (JS からは touch 不可)            │       │
│   │  amount             │        └────────────────┬──────────────────┘       │
│   │  paymentMethod      │                         │  confirmPayment           │
│   │  intentId           │                         │  (clientSecret)           │
│   │  error              │                         │                           │
│   └──────────┬──────────┘                         │                           │
│              │ cmd: requestIntent                 │                           │
│              │ cmd: reportConfirmation            ▼                           │
└──────────────┼──────────────────────┐     ┌─────────────┐                    │
               │ WebSocket            │     │  api.stripe.com              │    │
               ▼                      │     │  (card detail 直送)          │    │
                                      │     └─────────────┘                    │
┌──────────────────────────────── SERVER (Core) ───────────────────────────────┐
│                                                                               │
│   StripeCore (EventTarget)                                                    │
│   ├─ createPaymentIntent / createSetupIntent  (uses STRIPE_SECRET_KEY)        │
│   ├─ registerIntentBuilder((req, ctx) => options)   ← amount 決定点          │
│   ├─ registerWebhookHandler(type, handler, { fatal })                         │
│   └─ handleWebhook(rawBody, signatureHeader)  ← app の HTTP ルートから呼ぶ   │
│                                                                               │
│   (秘密鍵と clientSecret は Core 内部にのみ存在)                             │
└───────────────────────────────────────────────────────────────────────────────┘
                       ▲
                       │ webhook POST(アプリ側の HTTP ハンドラ経由)
              Stripe──┘
```

---

## 4. State Machine

```
      ┌─────────── reset() ──────────────┐
      │                                  │
      ▼                                  │
    idle ──requestIntent()──► collecting (Elements mounted, user entering)
                                │
                                └── submit() ──► processing
                                                  │
                                                  ├──► succeeded
                                                  │
                                                  ├──► requires_action
                                                  │       │
                                                  │       └─ redirect(3DS)
                                                  │              │
                                                  │              ▼
                                                  │          processing (再入)
                                                  │
                                                  └──► failed ──reset()──► idle
```

### status の union

```ts
type StripeStatus =
  | "idle"            // 初期・reset 後
  | "collecting"      // Elements が mount 済、ユーザーが入力中
  | "processing"      // confirmPayment 呼び出し中 / webhook 待ち
  | "requires_action" // 3DS などの追加アクション中(redirect 前後)
  | "succeeded"       // PaymentIntent が succeeded / SetupIntent が succeeded
  | "failed";         // Stripe から失敗が返った、または client-side error
```

### Stripe 側 status との対応

Stripe の PaymentIntent/SetupIntent ネイティブ status から `StripeStatus` へのマッピング:

| Stripe status | StripeStatus | 備考 |
|---|---|---|
| `succeeded` | `succeeded` | チャージ確定 |
| `requires_capture` | `succeeded` | **manual-capture flow** (`capture_method: "manual"`)。charge は authorized + hold 済で、ユーザー側の UX 完了。キャプチャは merchant 側で `paymentIntents.capture()` を別途呼ぶ。browser 観察面は "payment complete" 相当 |
| `requires_action` | `requires_action` | 3DS 等 |
| `requires_confirmation` | `requires_action` | `_reconcileFromIntentView` (retrieve side) で観測。Bank debit 系で稀に発生 |
| `processing` | `processing` | 非同期決済 (bank debit 等) の中間 |
| `requires_payment_method` | `failed` | 直前の attempt が decline 等で失敗し PM 再入力要 |
| `canceled` | `failed` | `last_payment_error` があれば error に反映 |
| 上記以外 | **unchanged** | `stripe-checkout:unknown-status` を dispatch し status は現状維持 (webhook 権威) |

### loading は別軸

`loading: boolean` は **何らかの非同期操作が進行中** であることを示し、`status` とは直交する(s3-uploader の `loading` / `uploading` 分離と同じ)。具体的には次のいずれかで `true` となる:

- Shell 側: Stripe.js のスクリプトロード、Elements の初期 mount 中
- Core 側: `requestIntent` / `resumeIntent` の provider 呼び出し中、`reportConfirmation` の `processing` 分岐での provider polling 中

UI を `loading` に直結すると、サーバーサイドの intent 作成や 3DS 復帰中もスピナが立つ。ブラウザ側の Stripe.js 初期化だけを区別したい場合は `stripe-checkout:element-ready` を使うこと。

### requires_action の扱い

3DS challenge は Stripe が `return_url` への redirect として処理する。Shell は redirect 前に `status = "requires_action"` を立てる。戻ってきたページでは:

1. URL のクエリから intent id **と** Stripe 発行の `client_secret` の**両方**を読む(Stripe は redirect URL に必ず両方を載せる):
   - `payment_intent=pi_xxx` + `payment_intent_client_secret=pi_xxx_secret_yyy`
   - または `setup_intent=seti_xxx` + `setup_intent_client_secret=seti_xxx_secret_yyy`
  - 万一 malformed URL で両方の tuple が同時に存在する場合、Shell は決定的に payment tuple を優先する
2. `StripeCore.resumeIntent(intentId, mode, clientSecret)` RPC を呼ぶ。
3. Core は server-side で `provider.retrieveIntent` を叩き、**retrieve された intent の `client_secret` と Shell から渡された `clientSecret` が一致すること**を検証する(default-secure、常時有効)。
4. 追加で `registerResumeAuthorizer` が登録されていればそれを呼び、`false` なら reject(defense-in-depth、任意)。
5. 全認可を通過したら `_activeIntent` を再構築し observable state を fold する。

**Authorization model**: resume での所有権証明は Stripe が `return_url` に載せる `client_secret` の知識。これは Stripe 自身が `stripe.retrievePaymentIntent(clientSecret)` で使っているモデルと同じ。Bare intent id だけ(secret なし)で resume を通す経路は存在しない。

**clientSecret の扱い(非露出 invariant との整合)**: resume RPC の引数として一度だけ wire を通るが、Core は受け取り比較のみを行い保存しない。observable state・`CustomEvent.detail`・attribute・`data-wcs` には一切出ない(SPEC §5.2)。

**Authorizer が必要なケース**: clientSecret 検証で「この intent を正規に保有していること」は担保できるが、intent と authenticated user の結びつき(メタデータに `userId` を入れて `ctx.sub` と照合するなど)はアプリのドメインロジック。`registerResumeAuthorizer` は任意だが、マルチテナント・管理画面など「clientSecret 漏洩時の被害を最小化したい」ケースでは登録推奨。

**Authorizer の denial 契約**: authorizer が `false` を返した場合と例外を throw した場合は**同じ denial パス**を通る:
- observable `error` は `{ code: "resume_not_authorized", message: "resume rejected by registered authorizer." }` に正規化される。
- 呼び出し側(`resumeIntent` の caller)が catch する Error の `code` も `resume_not_authorized`。
- `_activeIntent` は触らず `status = "idle"` に戻る。

raw な authorizer 例外(ACL lookup 失敗、DB エラー、stack trace など)は **wire には乗らない**。代わりに Core の target に `stripe-checkout:authorizer-error` が dispatch され、`detail: { error, intentId, mode }` を運ぶ。operator はサーバー側でこの event を subscribe してログに流せばよい(`stripe-checkout:webhook-warning` と同じ観測点モデル)。

---

## 5. wcBindable Surface

### 5.1 Observable properties

| name | type | 説明 |
|---|---|---|
| `status` | `StripeStatus` | §4 の状態 |
| `loading` | `boolean` | Core / Shell の非同期操作進行中(§4.loading 参照) |
| `amount` | `{ value: number; currency: string } \| null` | サーバーで確定した最終金額(payment モード時のみ。setup モードでは常に `null`) |
| `paymentMethod` | `{ id: string; brand: string; last4: string } \| null` | 成功後のみ。card number / CVC / exp は**絶対に含めない** |
| `intentId` | `string \| null` | PaymentIntent / SetupIntent の id |
| `error` | `StripeError \| null` | 失敗時のサニタイズ済みエラー |

### 5.2 Observable surface に出さないもの(非露出 invariant)

- **`clientSecret`** — Shell 内部の private field のみで保持。`bind()` / `data-wcs` にも `.clientSecret` プロパティにも出さない。理由: 単一 intent の confirmation トークンであり、露出しても致命ではないが、露出しないことで誤った再送・ログ混入・XSS 経由流出の窓を完全に閉じる。debug が必要な場合は開発時のみ console にダンプする開発者の責任とする(本体には debug フラグを設けない)。
- **`publishableKey`** — 静的 config(attribute / property で入る)であり observable の意味が無いため含めない。
- **`stripe` / `elements` インスタンス** — DOM に隠蔽。外部 JS からの direct 操作を許すと Case C の前提(iframe 隔離 + Core control)が崩れる。
- **サーバー側の秘密情報(`STRIPE_SECRET_KEY`, webhook signing secret)** — Core の constructor に渡された後、getter / toString も生やさない。

### 5.3 Inputs(attribute / property)

| name | attribute | 説明 |
|---|---|---|
| `mode` | `mode` | `"payment"` \| `"setup"` |
| `amountValue` | `amount-value` | payment モード時のヒント(サーバーが最終決定) |
| `amountCurrency` | `amount-currency` | 同上 |
| `customerId` | `customer-id` | setup モード時に Stripe Customer に紐付ける場合 |
| `appearance` | (property only) | Stripe Elements Appearance API の JSON |
| `publishableKey` | `publishable-key` | `pk_live_...` or `pk_test_...` |
| `returnUrl` | `return-url` | 3DS redirect 後の戻り先 URL |

**wcBindable.inputs との差異について**: 上表 7 項目のうち、`wcBindable.inputs`(`src/core/wcBindable.ts`)には `mode` / `amountValue` / `amountCurrency` / `customerId` の 4 つのみが登録される。これは **Core の観測可能入力**(= Remote 経由で Shell↔Core 間を双方向同期する値)だけを wcBindable protocol に乗せるという意図的な設計であり、残り 3 項目は Shell ローカルな Stripe.js 設定だから除外している:

- `appearance` — Stripe Elements の UI テーマ設定。Core はこの値を一切読まない (iframe 内で Stripe.js が直接消費する)。Remote 経由で送っても Core の挙動に影響しないため、input に載せない。
- `publishableKey` — ブラウザ側の Stripe.js インスタンスを構築するためのキー。Core は `STRIPE_SECRET_KEY` しか使わない(Shell と対になる別経路)。Remote モードでも Shell は自前で Stripe.js を起動するため、Core に送る意味がない。
- `returnUrl` — 3DS redirect の戻り先 URL。Shell の `submit()` が `stripe.confirmPayment({ confirmParams: { return_url } })` に渡すだけで、Core 側には到達しない。

したがって `wcBindable.inputs` と本セクションの表が不一致なのは仕様通りであり、Shell 側ローカル設定は `Stripe.observedAttributes` で attribute 変化を監視しつつ、Core への入力同期は行わない。

### 5.4 Commands(Shell が外部公開)

| name | 説明 |
|---|---|
| `prepare()` | Core に `requestIntent` → clientSecret 取得 → Elements を DOM に mount。idempotent。通常は `connectedCallback` / `attachLocalCore` / `_connectRemote` から auto-fire するので明示呼び出しは不要 |
| `submit()` | Elements に対して `confirmPayment` / `confirmSetup` を呼ぶ。未 prepare 時は内部で prepare を走らせる |
| `reset()` | idle に戻し、Elements を unmount。サーバー intent はそのまま(cancel しない) |
| `abort()` | サーバー RPC で PaymentIntent.cancel + Elements unmount + Core を idle に |

Shell 内部の Core RPC(`requestIntent`, `reportConfirmation`, `cancelIntent`, `resumeIntent`)は**外部非公開**。`s3-uploader` が `upload()` / `abort()` だけを Shell 層で forward する設計と同型。

#### auto-prepare のライフサイクル

`<stripe-checkout publishable-key="..." mode="payment">` だけで prepare が自動発火する。発火条件は以下がすべて揃ったとき:

- `isConnected` が true
- `publishable-key` 属性が設定済み
- 動く Core(local `attachLocalCore` か remote proxy)が紐付き済み
- Elements が未 mount かつ prepare が未 in-flight
- URL に `payment_intent` / `setup_intent` が**無い**(後者なら `resumeIntent` が優先)

これらは `connectedCallback` / `attachLocalCore` / `_connectRemote` の各フックから `_maybeAutoPrepare()` で冪等に試みられる。順序依存なく、最後にプレ条件が揃った時点で一度だけ発火する。

---

## 6. Core API(Server)

### 6.1 Types

```ts
interface PaymentIntentOptions {
  amount: number;
  currency: string;
  customer?: string;
  metadata?: Record<string, string>;
  setup_future_usage?: "off_session" | "on_session";
  // ... common subset (typed)
  [key: string]: unknown; // additional Stripe create params are pass-through
}

interface SetupIntentOptions {
  customer?: string;
  metadata?: Record<string, string>;
  usage?: "on_session" | "off_session";
  [key: string]: unknown; // additional Stripe create params are pass-through
}

interface IntentRequest {
  mode: "payment" | "setup";
  hint: {
    amountValue?: number;
    amountCurrency?: string;
    customerId?: string;
  };
}

interface IntentCreationResult {
  intentId: string;
  clientSecret: string;
  mode: "payment" | "setup";
  amount?: { value: number; currency: string };  // payment モード時のみ
}

interface IStripeProvider {
  createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult>;
  createSetupIntent(opts: SetupIntentOptions): Promise<IntentCreationResult>;
  retrieveIntent(mode: "payment" | "setup", id: string): Promise<StripeIntentView>;
  cancelPaymentIntent(id: string): Promise<void>;
  cancelSetupIntent?(id: string): Promise<void>;
  // rawBody は Buffer / Uint8Array / string のいずれか。Express の
  // `express.raw()` が返す Buffer も、生文字列を渡す手書き router も
  // 両方サポートする。HMAC は渡されたバイト列そのものに対して計算する。
  verifyWebhook(
    rawBody: string | Buffer | Uint8Array,
    signatureHeader: string,
    secret: string,
  ): StripeEvent;
}

type IntentBuilder = (req: IntentRequest, ctx: UserContext) => PaymentIntentOptions | SetupIntentOptions | Promise<...>;
type WebhookHandler = (event: StripeEvent) => Promise<void> | void;

interface WebhookRegisterOptions {
  fatal?: boolean; // default: true
}
```

### 6.2 StripeCore

```ts
class StripeCore extends EventTarget {
  constructor(provider: IStripeProvider, opts: {
    webhookSecret?: string;
    userContext?: UserContext;
  });

  /**
   * amount / currency / metadata の最終決定点。必須登録。
   * 未登録のまま requestIntent が来た場合、Core は即座に throw し
   * Shell には error イベントが返る(誤設定の fail-loud)。
   */
  registerIntentBuilder(build: IntentBuilder): () => void;

  /**
   * Stripe webhook event type → handler。
   * fatal: true (default) の hook が throw した場合、handleWebhook は reject し、
   * アプリの HTTP ルートは Stripe に 5xx を返すべき(Stripe が再送)。
   * fatal: false は audit / notification など副次的用途。
    *
    * Core は署名検証後の `event.id` に対して best-effort の in-memory dedup
    * window(1024件)を持つ。duplicate delivery は正常扱いで抑止されるが、
    * これは process-local で durable ではない(マルチプロセス/再起動を跨がない)。
    * handler 側は引き続き `event.id` をキーに冪等化すること。
    *
    * fatal handler が throw した場合は、当該 `event.id` を dedup window から
    * evict して re-throw する。これにより HTTP 5xx + Stripe retry で再配送可能。
   */
  registerWebhookHandler(type: string, handler: WebhookHandler, opts?: WebhookRegisterOptions): () => void;

  /**
   * 3DS redirect 復帰時に呼ばれる。Shell が URL の intent id と Stripe
   * 発行の client_secret を渡し、Core は provider.retrieveIntent で
   * authoritative な状態を取り、retrieve 結果の client_secret と引数の
   * clientSecret を照合してから `_activeIntent` を再構築する。不一致なら
   * `resume_client_secret_mismatch` で reject。
   */
  resumeIntent(intentId: string, mode: StripeMode, clientSecret: string): Promise<void>;

  /**
   * オプション。clientSecret 検証後、`_activeIntent` 再構築前に呼ばれる
   * defense-in-depth フック。false を返すと `resume_not_authorized` で
   * reject。マルチテナント環境での intent 所有者検証に使う。
   */
  registerResumeAuthorizer(authorizer: ResumeAuthorizer): () => void;

  /**
   * アプリの HTTP ルートから呼ぶ。
   * rawBody は Buffer/string(body-parser の前段で保全されたもの)。
   * signatureHeader は `stripe-signature` ヘッダの値。
  * 署名検証 → event ディスパッチ → status fold → 登録済み handler 実行。
   */
  handleWebhook(rawBody: string | Buffer | Uint8Array, signatureHeader: string): Promise<void>;
}
```

設計トレードオフ: Core は webhook を受けると handler 実行前に observable state を fold する。
そのため fatal handler が throw した場合でも UI は先に `succeeded` などを観測しうる一方、
HTTP ルートは 5xx を返して Stripe retry が走る。これは意図的な eventual consistency で、
UI の即時反映を優先しつつ、配送確定(ack)の最終判定は handler 側の永続化成功/失敗に委ねる。

**Fold の冪等性**: fatal handler が throw したとき、Core は該当 `event.id` を dedup window から**取り除き** Stripe の再送を受け入れる。再送時は fold が 2 度実行される — 従って fold は常に idempotent でなければならない。具体的には:

- `_setStatus(v)` / `_setLoading(v)` / `_setAmount(a)` / `_setPaymentMethod(pm)` / `_setError(err)` は同一値の 2 回目呼び出しで `dispatchEvent` を抑制する (setter 内 dedup)。
- 従って `payment_intent.succeeded` が 2 回配送されても、状態が既に `succeeded` ならイベント再発火はない。
- アプリ側 webhook handler は **別途** `event.id` + DB uniqueness でべき等化すること (SPEC §6.2 の原則)。

**並列 webhook の直列化**: `_foldWebhookIntoState` は succeeded 分岐で `await this._provider.retrieveIntent(...)` を持つ。同一 PaymentIntent に対して `payment_intent.processing` → `payment_intent.succeeded` が短時間連続で配送され、**HTTP ルート側で並列に処理された場合** (Fastify の並列リスナ、µWebSockets 系、個別 request を独立 goroutine 風に扱うフレームワーク)、retrieve await を跨いだ fold 間で finalize 順が逆転する余地がある。具体的には:

- A (`processing` 配送) が fold 同期プレフィクス実行 → 同期完
- B (`succeeded` 配送) が interleave し `retrieveIntent` await 中
- C (`processing` もう 1 件) が Flow A のあと着弾 → 古いステータスで上書きしうる

Express デフォルト / 単一プロセス Node の request 直列化運用では顕在化しないが、**高並列 HTTP フレームワーク利用時は HTTP ルート側で webhook を intent-id 単位にシリアライズすることを推奨** (単純には Mutex / in-memory queue、水平スケール時は DB 行ロック or Stripe の `event.id` を key にしたキュー消化)。Core 側は **シリアライズ済み配送を前提に fold 正当性を保証**している。並列配送対応の per-intent-id mutex を Core に内蔵する案は v1 スコープ外 — アプリ側の運用層で解決する。

### 6.4 `reportConfirmation` の paymentMethod 補完

Stripe.js の `confirmPayment` が返す `paymentIntent.payment_method` は **id 文字列のみ**(expand 指定なしのため)であることが多い。Shell はその場合 `paymentMethod` を omit して `reportConfirmation` を投げる。

Core の succeeded 分岐は、`report.paymentMethod` が欠けており `this._paymentMethod` が未セットなら、`provider.retrieveIntent` を best-effort で叩いて補完する。Provider 側の `retrieveIntent` は `expand: ["payment_method"]` を付けて Stripe を呼ぶので、brand / last4 を得られる。失敗しても UI は succeeded のまま、webhook 経由でさらに補完される。

#### 6.4.1 Stripe.js 異常応答時のフォールバック

Stripe.js の契約上、`confirmPayment` / `confirmSetup` の戻り値は `{ paymentIntent }` / `{ setupIntent }` / `{ error }` のいずれか。これが壊れて **3 つとも不在**で返ってきた場合 (stripe.js の未知バグや互換性非互換の前向きな変化)、Shell は UI を `processing` / `loading=true` のまま塩漬けにしないため以下のフォールバックを取る:

1. `stripe-checkout:unknown-status` を `detail: { intentId, status: "", preparedMode, reason: "stripe.confirm returned no intent and no error" }` で dispatch
2. Core に `reportConfirmation({ outcome: "processing" })` を送る

結果、UI は `status=processing` / `loading=true` で webhook の着信を待つ形になり、webhook path が終局状態を反映する。アプリは `stripe-checkout:unknown-status` を subscribe してタイムアウト/エスカレーション policy を実装する。

### 6.3 IntentBuilder 必須のふるまい

- 未登録時、`requestIntent` RPC は `{ code: "intent_builder_not_registered", message: "..." }` で即時失敗。
- これは s3-uploader の presign がデフォルトで通る挙動より**厳しい**方針。決済は誤設定が直接金額事故になるため fail-loud を選ぶ。

#### なぜ `IntentBuilder` は必須で `buildIdempotencyKey` は optional なのか

両方とも「多重請求 / 重複処理」を抑える安全弁だが、**必要性のレベルが異なる** ため設計上の扱いを分けている:

- **`IntentBuilder` は「正しく動くため」に必須**: 金額・通貨・customer はサーバー側で権威的に決定する責任の置き場であって、Shell 由来のヒントを素通しで Stripe API に投げると「ブラウザが金額を自由に改竄できる」という即時・致命的な脆弱性になる。未登録で動く仕様は安全に成立しない ─ fail-loud 一択。
- **`buildIdempotencyKey` は「転送失敗時の二重化を抑える」オプション**: 正常系では重複発行は発生しない。ネットワーク再送・tab 二重サブミット等のリトライ経路で PaymentIntent が二重作成されるのを防ぐための追加防衛層であり、**未設定でも決済フロー自体は成立する**。small-scale / retry 事象が稀な環境では運用上問題が無いので、全員に強制する代わりに optional にしている (README §Security の "Enable idempotent intent creation" 推奨枠)。

この非対称は `s3-uploader` の registerPresign (必須) / registerPostProcess (optional) と同じ哲学 — プロダクトが破綻する装備は必須、運用ヘッジの装備は opt-in。多重化の実測リスクが高いアプリは必ず設定すること、という README の推奨文言が運用上の整合点。

#### 6.3.1 IntentBuilder / サードパーティ例外の運用契約

`IntentBuilder` が throw する Error は Core の `_sanitizeError` を通り、Shell 経由でブラウザ側へ到達しうる。`_sanitizeError` は Stripe SDK 由来の型トークン (`card_error`, `invalid_request_error`, …) および `Stripe*Error` クラス名形式を allowlist し、該当する場合に限り `message` フィールドを wire に転送する。したがって **IntentBuilder の実装者は次の契約を守ること**:

- **Stripe の型トークンを人工的に付与しない**。例:
  - ❌ `throw Object.assign(new Error("DB credentials at 10.0.0.5 rejected"), { type: "card_error" });`
  - `type: "card_error"` を捏造すると、本来 wire 転送しない内部メッセージが allowlist を通過してしまう。
- **DB / 外部サービス由来の生例外はサニタイズしてから throw する**。例:
  - ✅ `throw Object.assign(new Error("[@wc-bindable/stripe] builder: cart lookup failed"), {});`
  - ✅ `try { ... } catch { raiseError("builder: unable to resolve amount for cart"); }`
- Stripe SDK が自然に throw する `StripeCardError` 等は **そのまま** 通して良い。Stripe 側のメッセージはユーザー向けに設計されている。

この契約が破られた場合、`_sanitizeError` は Stripe API エラーとの区別がつかないため内部メッセージが wire へ漏れる。Core 側では検知できないため、アプリ実装側の責務となる。

---

## 7. Shell API(Browser)

### 7.1 HTML

```html
<stripe-checkout
  mode="payment"
  amount-value="1980"
  amount-currency="jpy"
  publishable-key="pk_live_..."
  return-url="https://example.com/checkout/complete"
></stripe-checkout>
```

### 7.2 JS Properties(bindable surface と同じ)

読み取り: `el.status`, `el.loading`, `el.amount`, `el.paymentMethod`, `el.intentId`, `el.error`

書き込み(inputs): `el.mode = "setup"`, `el.appearance = {...}`, `el.customerId = "..."`

### 7.3 Methods

- `el.submit(): Promise<void>`
- `el.reset(): void`
- `el.abort(): Promise<void>`

### 7.4 Events

`stripe-checkout:status-changed`, `stripe-checkout:loading-changed`, `stripe-checkout:amount-changed`, `stripe-checkout:paymentMethod-changed`, `stripe-checkout:intentId-changed`, `stripe-checkout:error` を `CustomEvent<detail>` として dispatch。

`error` は他と違い `-changed` サフィックスを持たない(Core の `wcBindable.properties` 宣言と一致)。

追加の非 property イベント:

**Shell (`<stripe-checkout>` エレメント) 経由で dispatch されるもの:**
- `stripe-checkout:trigger-changed` — `trigger` の declarative pulse の開始/終了。`detail: true` で submit 開始、`detail: false` で終了。**エッジトリガ**: `false → true` の遷移でのみ submit を開始し、`true` が連続書き込まれても再発火しない (React / Vue の controlled prop で毎レンダ `el.trigger = true` を書いても二重送信にならない)。内部 `submit()` の reject はここでは再 throw せず、通常の `error` state / `stripe-checkout:error` で観測する。`reset()` / `abort()` が cancel パスで、trigger 自体に cancel セマンティクスはない (`el.trigger = false` は読み戻し整合のみ)。
- `stripe-checkout:appearance-warning` — `appearance` setter の hot-swap (`elements.update({ appearance })`) が throw したとき。`detail: { message, error }` を通知しつつ、setter 自体は throw せず次回 mount での反映にフォールバック
- `stripe-checkout:element-ready` — Stripe Elements の Payment Element が `ready` を発火したとき。`detail` なし
- `stripe-checkout:element-change` — Payment Element の `change` イベント。`detail: { complete: boolean }` のみ (入力値そのものは PCI スコープを避けるため転送しない)
- `stripe-checkout:stale-config` — `prepare()` 成功後に `mode` / `amount-value` / `amount-currency` / `customer-id` 属性が変更されたとき。現在の mounted Elements はその時点の値に束縛されているため、変更を効かせるには `reset()` / `abort()` + 再 `prepare()` が必要。`detail: { field, message }`
- `stripe-checkout:unknown-status` — Stripe.js confirm 結果または retrieve の `status` が既知ユニオン外だったとき、あるいは Stripe.js が `{ paymentIntent, setupIntent, error }` いずれも返さない malformed レスポンスを返したとき。`detail: UnknownStatusDetail = { source, intentId, mode, status, reason? }`。`source` で派生を識別: `"shell-confirm"` (Shell `_applyIntentOutcome` default) / `"shell-malformed"` (Stripe.js 異常応答) / `"core"` (Core `_reconcileFromIntentView` default, retrieve 由来)。webhook 権威に委ねる運用のためエラーとは扱わないが、webhook 未配送時のタイムアウト / エスカレーション判断に使える
- `stripe-checkout:missing-return-url-warning` — `submit()` 到達時点で `return-url` 未設定かつ `mode="payment"` だった場合に一度だけ発火 (prepare ライフサイクルごとに再武装)。redirect を要する PM (3DS cards, Konbini, wallets, Klarna, 等) では confirm 時に Stripe.js が throw する
- `stripe-checkout:dispose-warning` — remote モードの disconnect 時 best-effort cleanup (`cancelIntent` / `reset` / `unbind` / `proxy.dispose` / `ws.close`) が失敗したときに、`detail: { phase, error }` で通知。要素は DOM-detached 直前のため、`el.addEventListener` で先行登録された listener (テスト / オブザーバビリティ) のみが受け取る

**Core (`StripeCore` の EventTarget) 経由で dispatch されるもの:**
- `stripe-checkout:webhook-deduped` — 同一 `event.id` の webhook が dedup window でスキップされたとき。`detail: { eventId, type }`
- `stripe-checkout:webhook-warning` — `fatal: false` で登録された webhook handler が throw したとき。`detail: { error, event }`
- `stripe-checkout:authorizer-error` — `registerResumeAuthorizer` が登録した authorizer が throw したとき。`detail: { error, intentId, mode }` (server-side 運用者向け; 生例外は wire には流さず denial として扱う)
- `stripe-checkout:unknown-status` — Core 側の `_reconcileFromIntentView` が未知 Stripe status を観測したとき。`detail: { source: "core", intentId, mode, status }`

`error` は `-changed` サフィックスを持たない (Core の `wcBindable.properties` 宣言と一致)。`-warning` 接尾辞は「UI を壊さない補足情報」の共通ファミリー (`appearance-warning` / `webhook-warning` / `missing-return-url-warning` / `dispose-warning`)。

### 7.5 disconnectedCallback の契約

要素 DOM 削除時、Shell は以下の順序で graceful shutdown を行う:

1. `_markSupersede(true)` で parked prepare を中止マーク
2. `_teardownElements()` で Stripe Elements iframe を同期破棄
3. remote モードの場合:
  - 現 proxy/ws ハンドルをローカル変数にキャプチャ
  - インスタンスフィールドを即時 null 化(rapid reconnect 対応)
  - 非同期 cleanup で: in-flight prepare 待機 → (known orphan id があれば) `cancelIntent` → `reset` RPC → unbind → proxy dispose → ws close

3 の即時 null 化により、同期的 `removeChild` + `appendChild` の連続呼び出しでも
`connectedCallback` が新セッションを起動できる。

既知の制約: `requestIntent` RPC in-flight 中に disconnect が起きると、
Core が作成した intent が Stripe 自然 expiry まで残存する可能性がある。
Core の `reset` は Stripe API cancel を叩かない設計であるため。実害はないが
stale row が気になるアプリは DOM 削除前に `await el.abort()` を呼ぶ。

---

## 8. Control Plane Messages

wc-bindable-protocol remote の既存ワイヤ形式に乗る(新しい message type は足さない)。独自 Shell を実装する場合はこの節が wire 契約のソース。型は [types.ts](./src/types.ts) の `IntentRequest` / `IntentRequestHint` / `IntentCreationResult` / `ConfirmationReport` / `StripeError` / `StripePaymentMethod` / `StripeAmount` と一対一に対応する。

### 8.1 Shell → Core(`cmd` / 戻りは `return`)

- `requestIntent` — `args: [{ mode: "payment"|"setup", hint: { amountValue?, amountCurrency?, customerId? } }]` → `return.value: { intentId, clientSecret, mode, amount?: { value, currency } }`
  - `hint` は助言扱い(SPEC §9.3)。`amount` は payment mode のみ返る可能性があり、`{ value, currency }` の入れ子で `value` は最小通貨単位の整数。
- `reportConfirmation` — `args: [{ intentId, outcome, paymentMethod?, error? }]` → `return.value: undefined`
  - `outcome: "succeeded" | "requires_action" | "processing" | "failed"` — `processing` は Stripe が非同期決済(bank debit 等)で返す状態で、Core は `processing` 分岐で `retrieveIntent` を一度叩いた後 webhook 経由の終局を待つ。
  - `paymentMethod?: { id, brand, last4 }` — `confirmPayment` の戻りが expand 済み object のときのみ Shell が同梱。id 文字列のみの場合は omit し、Core の succeeded 分岐が server-side retrieve で補完する(§6.4)。
  - `error?: { code?, declineCode?, message, type? }` — `outcome: "failed"` 時に `StripeError` の sanitized 形で同梱。`failureCode` のような flat 文字列ではない。`message` のみ必須。
- `cancelIntent` — `args: [intentId: string]` → `return.value: undefined`
  - 引数は intent id 文字列そのもの(オブジェクトで包まない)。PaymentIntent は Stripe の cancel を叩く。SetupIntent はデフォルトでは Core 側の状態 reset のみ(コスト最適化)だが、`new StripeCore(provider, { cancelSetupIntents: true })` を指定し、provider が `cancelSetupIntent(id)` を実装していれば `setupIntents.cancel` を呼ぶ。
- `resumeIntent` — `args: [intentId: string, mode: "payment"|"setup", clientSecret: string]` → `return.value: undefined`
  - 3DS redirect 戻り時に Shell が呼ぶ。`clientSecret` は Stripe の redirect URL から抽出した所有権証明として必須(§9.2 / §2.6 authorization model)。
- `reset` — `args: []` → `return.value: undefined`
  - Shell の `reset()` / `abort()` / `disconnectedCallback` 経由で Core を idle に戻す。Stripe API は叩かない(cancel は `cancelIntent` の役割)。

### 8.2 Core → Shell(`update`)

`StripeCore.wcBindable.properties` が宣言する 6 プロパティが、変更時に `{ type: "update", name, value }` として流れる:

- `status` — `"idle" | "collecting" | "processing" | "requires_action" | "succeeded" | "failed"`
- `loading` — `boolean`
- `amount` — `{ value: number, currency: string } | null`(payment mode のみ populate)
- `paymentMethod` — `{ id, brand, last4 } | null`
- `intentId` — `string | null`
- `error` — `{ code?, declineCode?, message, type? } | null`

駆動元は Shell 経由の RPC 結果、webhook handler の fold、および 3DS resume の view 反映(§6.2 / §6.4)。

### 8.3 禁止事項

- card number / CVC / exp を含む message は**一切定義しない**。将来の拡張でもこれに触れない。
- `clientSecret` は `requestIntent` の `return.value` と `resumeIntent` の `args` でしか現れない。`update` / CustomEvent detail / `data-wcs` 等の observable / wire 上の他チャネルに乗せない(§5.2 / §9.2)。

---

## 9. Security

この節の宣言は `stripe-checkout` を採用する前提であり、Quick Start は production-ready ではない。

### 9.1 PCI scope(この設計が維持する範囲)

`stripe-checkout` を以下の通り使う限り、決済の PCI 影響範囲は **SAQ A** に留まる:

- `<stripe-checkout>` を DOM に配置し、card 入力を Stripe Elements の標準 iframe に任せる
- card 関連のカスタム `<input>` を**作らない**
- `paymentMethod` 以外の card 情報を observable に載せない
- webhook を Core の `handleWebhook` で受ける(署名検証を自前で書かない)

**崩れる場合**: カスタム card 入力 UI を作る、Stripe の生 API を Shell から直接叩く、`clientSecret` をログに残す、等。

### 9.2 Secret 非露出 invariant

| secret | 存在してよい場所 | 禁止 |
|---|---|---|
| `STRIPE_SECRET_KEY` | サーバー Core の constructor / Provider 内部のみ | Shell、wire、ログ、error.message |
| webhook signing secret | 同上 | 同上 |
| `clientSecret` | Shell の private field、Elements への引数 | bindable surface、`data-wcs`、ログ、URL のクエリ(redirect 後の戻りは Stripe 正規仕様の範囲内) |
| PaymentMethod 生データ | Stripe Elements iframe 内のみ | `stripe-checkout` コード全体 |

auth0-gate における token 非露出と同じ哲学。

**dispose 後の残留禁止**: `StripeCore.dispose()` は以下を null 化する:

- `_webhookSecret` (webhook signing secret)
- `_userContext` (認証済みユーザーコンテキスト)
- `_provider` (`STRIPE_SECRET_KEY` を間接的に保持する `IStripeProvider` 実装への参照)

マルチテナントサーバで tenant 単位に Core を生成 / 破棄する運用で、disposed Core への stray reference が残っても heap dump に secret が載らないことを保証する。`_target` (`EventTarget`) は secret を持たないため保持継続 (late-dispatch の target を維持)。`_disposed` flag が全 public command の入口で `raiseError` するため、null 化された `_provider` が誤って dereference される経路は閉じている。

### 9.3 Your Responsibilities

- **WebSocket の認証**: session cookie or bearer を upgrade 時に検証。未認証接続からの `createIntent` を許さない。

  **Core の wcBindable surface は wire に直接露出している**: `StripeCore.wcBindable.commands` には `requestIntent` / `reportConfirmation` / `cancelIntent` / `resumeIntent` / `reset` の 5 つが並び、Shell が内部的に叩く RPC がそのまま remote proxy 経由で wire にも公開される。Shell の public 4 コマンド (`prepare` / `submit` / `reset` / `abort`) は **ブラウザ側のエレメント API** であって wire プロトコルではない ─ 認証されていない(あるいは認証された別ユーザーの) WebSocket から `reportConfirmation({ intentId: "pi_victim", outcome: "succeeded" })` を直打ちされる攻撃面は残る。Core が更新するのは observable state のみで実際の入金判定は webhook ハンドラ + DB 整合性で行うため決済事故には直結しないが、`cancelIntent` / `resumeIntent` は実害 (他ユーザー intent の cancel や hydrate) があるため、WebSocket セッションのユーザー識別 + `UserContext` に基づく intent 所有権チェック (`registerResumeAuthorizer`、または IntentBuilder 内で `metadata.userId` を set しておく) が必須。
- **`registerIntentBuilder` でサーバー側 amount 算出**: Shell からの `amountValue` / `amountCurrency` は**ヒント**であり、カート / 商品 DB / 割引計算の結果をサーバーが最終決定する。Shell 値をそのまま渡すと、ブラウザから金額改竄ができる。
- **Webhook endpoint の raw body 保全**: body-parser が JSON parse する前に生文字列を確保(Express なら `express.raw({ type: 'application/json' })`)。parse 後に再 stringify した body は署名検証に通らない。
- **Idempotency key の付与**: 同一ユーザーからの連続 `requestIntent` に対し idempotency を保つ(Stripe 側の idempotency-key を使う or アプリ側でレート制限)。
- **Error sanitization**: Stripe が返す `code` / `decline_code` はそのまま返してよいが、Stripe の内部 error message、stack trace、PaymentIntent オブジェクト全体を error.message に入れて wire に流さない。
- **User 分離**: `registerIntentBuilder` に渡る `UserContext` は認証済み前提。ここで customer / metadata を他ユーザーのものに向けない検証を行う。
- **Remote 切断時の再接続はアプリ側責務**: `<stripe-checkout>` の remote モード (`config.remote.enableRemote === true`) は `new WebSocket(url)` を 1 回だけ張り、`error` / `close` いずれかで `_disposeRemote` して Shell を transport 不能状態に確定させる。**自動再接続は行わない**。モバイル端末の回線瞬断 / サーバ rolling deploy / LB idle timeout 等で切断された後、ユーザーが `submit()` を叩くと proxy が null の `raiseError` 経路に落ちる。復旧は以下のいずれか:

  1. 切断 event (`stripe-checkout:error` with `code: "transport_unavailable"`) を listen し、アプリ側で element を `removeChild` → `appendChild` で再マウント (推奨)。
  2. ページ全体を reload する。
  3. 将来的に `reconnect-on-close="true"` 等の opt-in 属性が提供される可能性はあるが v1 では実装しない。

  ポリシー: 自動再接続を Shell に埋めると、(a) 指数 backoff / jitter 等の選択がアプリに押し付けられ、(b) 接続中の `_preparePromise` / `_submitPromise` の扱いが s3-uploader 側 presign と整合せず、(c) 無限リトライで Stripe API を叩き続けるリスクが発生する。アプリが明示的に再マウントする方が副作用を観察しやすい。

### 9.4 Threat model(短縮版)

| 脅威 | 緩和 |
|---|---|
| 金額改竄 | `registerIntentBuilder` 必須、Shell 値はヒント扱い |
| card data 漏洩 | Elements iframe 隔離(設計上コードで触れない) |
| webhook forgery | `handleWebhook` の署名検証、raw body 必須 |
| replay attack(webhook) | Stripe の `timestamp` 検証(provider 層で実施) |
| clientSecret 漏洩 | observable / wire 非露出(resume の引数として一度だけ通るが保存せず)、Shell private 保持 |
| 認証バイパス(他ユーザーの決済) | WebSocket 認証 + `UserContext` に基づく builder 検証 |
| 他人の intent を URL で resume / cancel | resume は `clientSecret` 知識を所有権証明として要求(Stripe 自身の authorization model)。bare intent id だけでは通さない。追加で `registerResumeAuthorizer` による metadata/tenant 検証を推奨 |

---

## 10. Non-goals(v1)

以下は v1 スコープ外。将来 v2 以降で扱う。

- **Stripe Checkout / Payment Links**: redirect 型のため Elements 前提の現設計に直接は載らない。別コンポーネント `<stripe-checkout-checkout>` を将来検討。
- **Subscriptions UI(Customer Portal)**: Portal も redirect 型。intent 系とは別カテゴリ。
- **Stripe Connect(platform payments)**: OnBehalfOf / destination charge などのマルチテナント構造は Core API に別軸の設計が要る。
- **複数通貨の動的切替え UI**: 現状 `amount-currency` は固定入力として扱う。
- **PayPal / Square / Adyen**: `payment-abstract` 抽象として v2 以降に上載せ。UI 資産(Elements 相当)の差が大きく、wire format 統一だけでは dent が浅い。

---

## 11. Package Layout(実装時)

```
packages/stripe/
  SPEC.md                       (this document)
  README.md                     (quick start / install / API ref)
  package.json                  @wc-bindable/stripe
  src/
    core/StripeCore.ts
    components/Stripe.ts        (<stripe-checkout> HTMLElement)
    providers/StripeSdkProvider.ts  (IStripeProvider, stripe-node wrap)
    config.ts
    types.ts
    index.ts                    (browser barrel)
  src/server/index.ts           (server barrel, no HTMLElement)
  src/auto/                     (auto-register)
  __tests__/                    (vitest)
  tests/                        (playwright e2e, Elements mount 検証)
```

- npm scope: `@wc-bindable/stripe`
- tag: `<stripe-checkout>`
- peerDependencies: `stripe`(server Provider が使う。optional: true)、`@stripe/stripe-js`(Shell がロードに使う。optional: true)

---

## 12. Versioning

- v1.0: 本 SPEC の範囲(PaymentIntent + SetupIntent + webhook + 3DS)
- v1.x: Appearance API の preset、i18n、Apple Pay / Google Pay の Payment Request Button 統合
- v2.0: `payment-abstract` 抽象との統合、または Checkout / Connect 追加に伴う breaking change が必要になった時点
