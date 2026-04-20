# hawc-stripe Specification

## 1. Overview

`hawc-stripe` は Stripe 決済を HAWC アーキテクチャに載せる。HAWC 分類上は **Case C(browser-anchored execution Shell)** に属する。

- **なぜ Case C か**: Stripe Elements の card input は PCI / XSS 隔離のため iframe として DOM に mount される必要があり、これは WebSocket 越しにサーバー Core へ委譲できない platform-anchored execution である。
- **なぜ Core が必要か**: PaymentIntent / SetupIntent の作成には `STRIPE_SECRET_KEY` が必須で、これをブラウザに渡せば PCI / 認可の両方で破綻する。webhook 検証も同様にサーバー側でしか成立しない。

### hawc-s3 との同型性

`hawc-s3` と構造的に双子。

| 観点 | hawc-s3 | hawc-stripe |
|---|---|---|
| 機密 payload | file bytes | card detail(number / CVC / exp) |
| データ経路 | Browser → presigned URL → S3(直送) | Browser → Elements iframe → Stripe(直送) |
| control plane | WebSocket(sign / complete) | WebSocket(createIntent / notify) |
| サーバー通過量 | O(connections), not O(bytes) | O(connections), not O(card ops) |

「機密 payload はサーバーを経由させず、control plane だけ WebSocket で」というパターンがそのまま適用される。

---

## 2. Design Principles

1. **Data plane bypass** — card data は Stripe Elements iframe が直接 Stripe に送る。`hawc-stripe` の JS、アプリの JS、我々のサーバーのいずれも card number / CVC に触れない。
2. **Core owns secrets** — `STRIPE_SECRET_KEY` はサーバー Core のみが保持。webhook signature 検証もサーバー Core。
3. **Publishable key は Shell が持つ** — `pk_live_...` は公開情報なので Shell / config 経由で可。
4. **Control plane over WebSocket** — intent 作成依頼、confirmation 結果の通知、webhook 起因の状態更新のみが流れる。
5. **amount の決定権はサーバー** — Shell から来た値は**ヒント**として扱い、サーバー側の `registerIntentBuilder` が最終値を決める(未登録なら `createIntent` RPC は失敗する)。
6. **Provider abstraction は v1 では載せない** — Stripe 専用として最短で出す。PayPal / Square / Adyen は `hawc-payment` 抽象として将来上載せする。

---

## 3. Architecture

```
┌──────────────────────────────── BROWSER (Shell) ─────────────────────────────┐
│                                                                               │
│   <hawc-stripe mode="payment" amount-value="1980" amount-currency="jpy">     │
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

### loading は別軸

`loading: boolean` は **Stripe.js のスクリプトロードおよび Elements の初期 mount 中** を指し、`status` とは直交する(hawc-s3 の `loading` / `uploading` 分離と同じ)。

### requires_action の扱い

3DS challenge は Stripe が `return_url` への redirect として処理する。Shell は redirect 前に `status = "requires_action"` を立てる。戻ってきたページでは:

1. URL のクエリから intent id **と** Stripe 発行の `client_secret` の**両方**を読む(Stripe は redirect URL に必ず両方を載せる):
   - `payment_intent=pi_xxx` + `payment_intent_client_secret=pi_xxx_secret_yyy`
   - または `setup_intent=seti_xxx` + `setup_intent_client_secret=seti_xxx_secret_yyy`
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

raw な authorizer 例外(ACL lookup 失敗、DB エラー、stack trace など)は **wire には乗らない**。代わりに Core の target に `hawc-stripe:authorizer-error` が dispatch され、`detail: { error, intentId, mode }` を運ぶ。operator はサーバー側でこの event を subscribe してログに流せばよい(`hawc-stripe:webhook-warning` と同じ観測点モデル)。

---

## 5. wcBindable Surface

### 5.1 Observable properties

| name | type | 説明 |
|---|---|---|
| `status` | `StripeStatus` | §4 の状態 |
| `loading` | `boolean` | Stripe.js / Elements の初期化中 |
| `amount` | `{ value: number; currency: string } \| null` | サーバーで確定した最終金額(payment モード時) |
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

### 5.4 Commands(Shell が外部公開)

| name | 説明 |
|---|---|
| `prepare()` | Core に `requestIntent` → clientSecret 取得 → Elements を DOM に mount。idempotent。通常は `connectedCallback` / `attachLocalCore` / `_connectRemote` から auto-fire するので明示呼び出しは不要 |
| `submit()` | Elements に対して `confirmPayment` / `confirmSetup` を呼ぶ。未 prepare 時は内部で prepare を走らせる |
| `reset()` | idle に戻し、Elements を unmount。サーバー intent はそのまま(cancel しない) |
| `abort()` | サーバー RPC で PaymentIntent.cancel + Elements unmount + Core を idle に |

Shell 内部の Core RPC(`requestIntent`, `reportConfirmation`, `cancelIntent`, `resumeIntent`)は**外部非公開**。`hawc-s3` が `upload()` / `abort()` だけを Shell 層で forward する設計と同型。

#### auto-prepare のライフサイクル

`<hawc-stripe publishable-key="..." mode="payment">` だけで prepare が自動発火する。発火条件は以下がすべて揃ったとき:

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
  // ... Stripe が受け付けるフィールド
}

interface SetupIntentOptions {
  customer?: string;
  metadata?: Record<string, string>;
  usage?: "on_session" | "off_session";
}

interface IntentRequest {
  mode: "payment" | "setup";
  hint: {
    amountValue?: number;
    amountCurrency?: string;
    customerId?: string;
  };
}

interface IStripeProvider {
  createPaymentIntent(opts: PaymentIntentOptions): Promise<{ id: string; clientSecret: string; amount: number; currency: string }>;
  createSetupIntent(opts: SetupIntentOptions): Promise<{ id: string; clientSecret: string }>;
  retrieveIntent(mode: "payment" | "setup", id: string): Promise<StripeIntent>;
  cancelPaymentIntent(id: string): Promise<void>;
  verifyWebhook(payload: string, signature: string, secret: string): StripeEvent;
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
   * 署名検証 → event ディスパッチ → 登録済み handler 実行 → status プロパティ更新。
   */
  handleWebhook(rawBody: string, signatureHeader: string): Promise<void>;
}
```

### 6.4 `reportConfirmation` の paymentMethod 補完

Stripe.js の `confirmPayment` が返す `paymentIntent.payment_method` は **id 文字列のみ**(expand 指定なしのため)であることが多い。Shell はその場合 `paymentMethod` を omit して `reportConfirmation` を投げる。

Core の succeeded 分岐は、`report.paymentMethod` が欠けており `this._paymentMethod` が未セットなら、`provider.retrieveIntent` を best-effort で叩いて補完する。Provider 側の `retrieveIntent` は `expand: ["payment_method"]` を付けて Stripe を呼ぶので、brand / last4 を得られる。失敗しても UI は succeeded のまま、webhook 経由でさらに補完される。

### 6.3 IntentBuilder 必須のふるまい

- 未登録時、`requestIntent` RPC は `{ code: "intent_builder_not_registered", message: "..." }` で即時失敗。
- これは hawc-s3 の presign がデフォルトで通る挙動より**厳しい**方針。決済は誤設定が直接金額事故になるため fail-loud を選ぶ。

---

## 7. Shell API(Browser)

### 7.1 HTML

```html
<hawc-stripe
  mode="payment"
  amount-value="1980"
  amount-currency="jpy"
  publishable-key="pk_live_..."
  return-url="https://example.com/checkout/complete"
></hawc-stripe>
```

### 7.2 JS Properties(bindable surface と同じ)

読み取り: `el.status`, `el.loading`, `el.amount`, `el.paymentMethod`, `el.intentId`, `el.error`

書き込み(inputs): `el.mode = "setup"`, `el.appearance = {...}`, `el.customerId = "..."`

### 7.3 Methods

- `el.submit(): Promise<void>`
- `el.reset(): void`
- `el.abort(): Promise<void>`

### 7.4 Events

`hawc-stripe:status-changed`, `hawc-stripe:loading-changed`, `hawc-stripe:amount-changed`, `hawc-stripe:paymentMethod-changed`, `hawc-stripe:intentId-changed`, `hawc-stripe:error` を `CustomEvent<detail>` として dispatch。

`error` は他と違い `-changed` サフィックスを持たない(Core の `wcBindable.properties` 宣言と一致)。

追加の非 property イベント:
- `hawc-stripe:element-ready` — Stripe Elements の mount 完了
- `hawc-stripe:element-change` — Elements の入力完全性のみ(card 情報は含まない)。`detail: { complete: boolean }`
- `hawc-stripe:stale-config` — `prepare()` 後に mode / amount / customer 属性が変わったとき。`detail: { field, message }`。`submit()` は prepared mode を使い続けるので、切り替えたい場合は `reset()` か `abort()` を挟む必要があることの通知
- `hawc-stripe:authorizer-error` — Core のみ(Shell には届かない)。resume authorizer が throw したときの raw 例外を operator ログ向けに surface
- `hawc-stripe:webhook-warning` — Core のみ。non-fatal webhook handler が throw したとき

---

## 8. Control Plane Messages

wc-bindable-protocol remote の既存ワイヤ形式に乗る(新しい message type は足さない)。

### 8.1 Shell → Core

- `{ type: "cmd", name: "requestIntent", id, args: [{ mode, hint }] }` → `{ type: "return", id, value: { intentId, clientSecret, amount?, currency? } }`
- `{ type: "cmd", name: "reportConfirmation", id, args: [{ intentId, outcome: "succeeded" | "requires_action" | "failed", failureCode? }] }`
- `{ type: "cmd", name: "cancelIntent", id, args: [{ intentId }] }`

### 8.2 Core → Shell

- `{ type: "update", name: "status", value: "succeeded" }` — webhook 起因で Core が主導する更新
- `{ type: "update", name: "paymentMethod", value: { id, brand, last4 } }`

### 8.3 禁止事項

- card number / CVC / exp を含む message は**一切定義しない**。将来の拡張でもこれに触れない。

---

## 9. Security

この節の宣言は `hawc-stripe` を採用する前提であり、Quick Start は production-ready ではない。

### 9.1 PCI scope(この設計が維持する範囲)

`hawc-stripe` を以下の通り使う限り、決済の PCI 影響範囲は **SAQ A** に留まる:

- `<hawc-stripe>` を DOM に配置し、card 入力を Stripe Elements の標準 iframe に任せる
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
| PaymentMethod 生データ | Stripe Elements iframe 内のみ | `hawc-stripe` コード全体 |

hawc-auth0 における token 非露出と同じ哲学。

### 9.3 Your Responsibilities

- **WebSocket の認証**: session cookie or bearer を upgrade 時に検証。未認証接続からの `createIntent` を許さない。
- **`registerIntentBuilder` でサーバー側 amount 算出**: Shell からの `amountValue` / `amountCurrency` は**ヒント**であり、カート / 商品 DB / 割引計算の結果をサーバーが最終決定する。Shell 値をそのまま渡すと、ブラウザから金額改竄ができる。
- **Webhook endpoint の raw body 保全**: body-parser が JSON parse する前に生文字列を確保(Express なら `express.raw({ type: 'application/json' })`)。parse 後に再 stringify した body は署名検証に通らない。
- **Idempotency key の付与**: 同一ユーザーからの連続 `requestIntent` に対し idempotency を保つ(Stripe 側の idempotency-key を使う or アプリ側でレート制限)。
- **Error sanitization**: Stripe が返す `code` / `decline_code` はそのまま返してよいが、Stripe の内部 error message、stack trace、PaymentIntent オブジェクト全体を error.message に入れて wire に流さない。
- **User 分離**: `registerIntentBuilder` に渡る `UserContext` は認証済み前提。ここで customer / metadata を他ユーザーのものに向けない検証を行う。

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

- **Stripe Checkout / Payment Links**: redirect 型のため Elements 前提の現設計に直接は載らない。別コンポーネント `<hawc-stripe-checkout>` を将来検討。
- **Subscriptions UI(Customer Portal)**: Portal も redirect 型。intent 系とは別カテゴリ。
- **Stripe Connect(platform payments)**: OnBehalfOf / destination charge などのマルチテナント構造は Core API に別軸の設計が要る。
- **複数通貨の動的切替え UI**: 現状 `amount-currency` は固定入力として扱う。
- **PayPal / Square / Adyen**: `hawc-payment` 抽象として v2 以降に上載せ。UI 資産(Elements 相当)の差が大きく、wire format 統一だけでは dent が浅い。

---

## 11. Package Layout(実装時)

```
packages/hawc-stripe/
  SPEC.md                       (this document)
  README.md                     (quick start / install / API ref)
  package.json                  @wc-bindable/hawc-stripe
  src/
    core/StripeCore.ts
    components/Stripe.ts        (<hawc-stripe> HTMLElement)
    providers/StripeSdkProvider.ts  (IStripeProvider, stripe-node wrap)
    config.ts
    types.ts
    index.ts                    (browser barrel)
  src/server/index.ts           (server barrel, no HTMLElement)
  src/auto/                     (auto-register)
  __tests__/                    (vitest)
  tests/                        (playwright e2e, Elements mount 検証)
```

- npm scope: `@wc-bindable/hawc-stripe`
- tag: `<hawc-stripe>`
- peerDependencies: `stripe`(server Provider が使う。optional: true)、`@stripe/stripe-js`(Shell がロードに使う。optional: true)

---

## 12. Versioning

- v1.0: 本 SPEC の範囲(PaymentIntent + SetupIntent + webhook + 3DS)
- v1.x: Appearance API の preset、i18n、Apple Pay / Google Pay の Payment Request Button 統合
- v2.0: `hawc-payment` 抽象との統合、または Checkout / Connect 追加に伴う breaking change が必要になった時点
