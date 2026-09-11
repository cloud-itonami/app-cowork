# app-cowork

**Cowork Graph Connector — Claude Cowork 向けの MCP ブリッジの appview。**
`etzhayyim/root` の `60-apps/etzhayyim-project-cowork` からの抽出物で、
**2026-08-18 に appview を TypeScript/Svelte から ClojureScript へ移行した**
（`docs/adr/0001`）。数字はすべて `scripts/verify-docs-claims.cljs` が tree から
再計算して検査する。

## deploy されるものは、いま読んでいるソースである

```
src/cowork/route.cljc    判断（どの handler が答えるか）  ← 純 .cljc、テスト対象
src/cowork/view.cljc     ページ（jp-go-dds の hiccup）    ← 純 .cljc、テスト対象
src/cowork/worker.cljs   Request/Response に触る唯一の層
        ↓ shadow-cljs :target :esm
dist/worker.js           ← wrangler.jsonc の "main" が指すもの
```

移行前の `main` は `svelte/.svelte-kit/cloudflare/_worker.js` を指していた
——**tracked file が 1 つも無いパス**（ビルド出力）である。そして読み手が開く
882 行の `appview/…/src/app.ts` は、どの package.json からも宣言されておらず
（`@etzhayyim/kotodama-host-sdk` という文字列は tree 全体で app.ts 自身の
import 文にしか無い）、どの bundle にも入っていなかった。いまは `main` が指す
bundle が上のソースからコンパイルされたものなので、その形は構造的に起こり得ない。
`scripts/verify-docs-claims.cljs` が **shadow の出力先と wrangler の `main` と
export の ns 名の 3 つが噛み合っていること**を検査し、噛み合わなくなれば落ちる。

判断を `.cljc` に置いてあるのは、ブラウザもビルドも無しにテストするためであり、
ingress capability が qualify した時に **最初に `.kotoba` へ移る部分**だからで
ある（入口を当面 cljs に置くのは ADR-2606290000 の判断）。

## 公開ルート

| METHOD | PATH | 何をするか |
|---|---|---|
| GET | `/` | この appview の説明ページ |
| POST | `/xrpc/*` | XRPC を MCP router へ中継する（jsonrpc `tools/call` に包む） |
| OPTIONS | `/xrpc/*` | CORS preflight。204 |

**この表の出所は `cowork.route/routes` で、ページもそこから描く。**
移行前のページ（`+page.svelte`）は route 数・route 一覧・var 一覧を literal の
オブジェクトとして持ち、隣の `wrangler.jsonc` を読んでいなかった。一度は
`Routes 0` / `No public route is declared` と表示し（同じディレクトリの設定は
route 2・var 16 を宣言していた）、それを手で書き直したあとも**手で同期し続ける
しかない**形のままだった。いまは表を渡す側が持ち、ページは描くだけなので、
両者がずれる余地が無い。

**`/health` は足していない。** SvelteKit 側に無かったので、足すと `/health` の
応答が 404 から 200 に変わる —— 移行は deploy 済みの意味を変える場所ではない。

### 移行前との差分（5 つ、すべて意図的）

移行前後で client から見た **status は同じ**である。違うのは次の 5 点だけ:

| 差分 | 移行前 | 移行後 | なぜ |
|---|---|---|---|
| 上流に届かないとき | 例外が抜けて SvelteKit の **500 HTML エラーページ** | **502 JSON** `{"error":"MCP router unreachable",…}` | 中継先の障害を自分の crash と同じ形で出さない |
| `x-etzhayyim-bff` | `sveltekit-edge-bff` | `cljs-esm-worker` | SvelteKit はもう無い。名乗りを実態に合わせた |
| 上流へ載せ替えるヘッダ | 元の `content-length` ごと転送 | `content-length` を落とす | 本文は jsonrpc の封筒に包み直されて長さが変わる |
| 404 / 405 の**本文** | SvelteKit の error envelope（`Accept` 次第で HTML の error page か `{"type":"error",…}`） | `{"error":…}` の JSON（404 は route 一覧も返す） | SvelteKit の error page ごと移植する意味が無い。**status は同じ**（404 / 405、`allow` ヘッダも同じ） |
| `GET /` の `cache-control` | 無し（SvelteKit 既定） | `public, max-age=60` | 静的な 1 枚に毎回 origin まで来させない |

`POST /xrpc/*` の応答（status・JSON 本文・`content-type: application/json` ・
`cache-control: no-store`）と `OPTIONS` の 204（CORS 4 ヘッダのみ、他は足さない）は
**バイト単位で移行前と同じ形**である。

`authorization` の透過、`/xrpc/a/b` のような多段パスを nsid としてそのまま
中継すること（SvelteKit の `[...path]` は rest parameter だった）、`/xrpc/` が
`{"error":"Missing XRPC method"}` の 400 になることは、**移行前のまま**である。

## 持ち越さなかった経路（黙って消していない）

移行前の `appview/…/src/app.ts` は Microsoft Graph の MCP tool を **16 個**
宣言していた。どこにも deploy されておらず、この移行は**持ち越していない**:

| NSID (`com.etzhayyim.apps.coworkGraph.` +) |
|---|
| `mailList` / `mailGet` / `mailDraft` |
| `teamsChannelList` / `teamsMessageList` |
| `filesList` / `filesGet` |
| `calendarList` |
| `userGet` / `userList` |
| `graphActorGet` / `graphQuery` / `graphMvQuery` |
| `sendTeamsMessage` / `listMyFormTasks` / `sendBpmnGuidance` |

**理由は 16 件とも同じで、測ったものである**（2026-08-18）: これらが読む
binding が `wrangler.jsonc` に 1 つも宣言されていない。

```
app.ts が読む env:  GRAPH_CLIENT_ID  GRAPH_D1  GRAPH_SCOPE  GRAPH_TENANT_ID
                    HYPERDRIVE  SS_GRAPH_CLIENT_SECRET  SS_GRAPH_TOKEN_KEK
wrangler の top-level キー:
                    compatibility_date  compatibility_flags  main  name
                    routes  rules  vars
```

`d1_databases` も `hyperdrive` も `secrets_store_secrets` も無く、`vars` の 16 件は
`APP_*` メタデータ + MCP router URL + `INTERFACES_REQUIRES` である。したがって
client secret も KEK も tenant id も DB も、実行時に存在しない。

**上流ホストの側は生きている** —— `graph.microsoft.com` も
`login.microsoftonline.com` も A レコードを返す（実測）。死んでいるのは宛先では
なく **credential と DB の側**である。動かない経路を移植して「移行済み」と言わ
ないために持ち越さず、必要になった時点で binding の宣言とテストを伴って戻す。

この一覧の実体は `cowork.route/not-carried-over` の 1 箇所だけにあり、ページも
この README も検証器もそこを読む（`readme-names-every-dropped-tool` claim が
README との一致を検査する）。

## いま在るもの

| 面 | ファイル |
|---|---|
| 判断・描画・edge | `src/cowork/{route.cljc, view.cljc, worker.cljs}` |
| テスト | `test/cowork/route_test.cljc`（6 tests / 56 assertions） |
| ビルド | `deps.edn` / `shadow-cljs.edn` |
| 検査 | `scripts/{verify-docs-claims,smoke-worker,render-page}.cljs` |
| Worker 設定 | `appview/…/wrangler.jsonc` |
| actor 記述子 | `appview/…/kotodama.jsonld` |
| 由来・権利・識別 | `NOTICE` / `OWNERS` / `PROJECT.jsonld` / `README.edn` / `migration.edn` / `MIGRATION-TODO.md` |
| 文書 | `README.md` / `docs/operator-quickstart.md` / `docs/adr/*.edn` |
| **未移行** | `kotoba/`（TypeScript 5 本。下記） |

**appview の TypeScript / Svelte は 4 本から 0 本になり、正本言語
（`.cljs`/`.cljc`）が 0 本から 4 本になった。** この 2 つの数は検証器の claim
なので、TS が戻れば落ちる —— 撤去した 8 パスに戻る場合
（`removed-by-migration-absent`）も、別名で入る場合（`appview-ts-files`）も、
別々の claim が捕まえる。

### `kotoba/` は移していない

`kotoba/` は **TypeScript のまま 5 本残っている**（`src/{index,registry,types}.ts`
/ `test/cowork.test.ts` / `vitest.config.ts`）。これは appview ではなく、
`@etzhayyim/sdk` に対する product-front ライブラリ（M365 コラボレーション graph の
plaintext / E2E レジストリ）で、wrangler は deploy しない。移していない理由:

1. **今日この機械で走らせられない。** 依存 2 本が git URL で、その準備が入れ子
   install を起こし npm 11.16.0 が `EALLOWSCRIPTS` で拒否する。つまり移植の
   **oracle（移植前の振る舞い）が取れない**。
2. appview の移行とは別の決定であり、別の ADR で扱うべき範囲である。

したがって **repo 全体の TypeScript/Svelte は 9 本（`.ts` 8 + `.svelte` 1）から
`.ts` 5 本になった**のであって、0 本になったのではない。検証器は `kotoba-ts-files` claim でこの 5 本を固定して
おり、この README が「TypeScript は無い」と読めるようになった時点で落ちる。

## UI

基盤は `kotoba-lang/jp-go-digital-design-system`（デジタル庁デザインシステム）。
色・寸法は `--hig-*` トークン契約だけで書き、raw hex も px フォントサイズも
置かない。app 固有 CSS は 3 行。CSS は外部リクエストゼロの方針どおり
`shadow.resource/inline` で bundle に焼く。

決定論的 audit（`kotoba-lang/design-quality`）で **100.00 / 100（gate 95）**。

## 呼び先が 1 つも解決しない（移行では直らない）

| ホスト | 役割 | DNS（実測 2026-08-18） |
|---|---|---|
| `cowork-graph.etzhayyim.com` | 公開ホスト（wrangler の route） | **NXDOMAIN** |
| `c0w0rkg1.etzhayyim.com` | 同（nanoid 側） | **NXDOMAIN** |
| `mcp.etzhayyim.com` | `/xrpc/*` の中継先 | **NXDOMAIN** |

deploy 先も中継先も、いま存在しない。`/xrpc/` は到達できなければ **502 を返す**
——成功と同じ形で隠さない。

`wrangler.jsonc` は `APP_DEPLOY_AT: 2026-05-07T02:00:37Z` / `APP_DEPLOY_SHA:
06194f69d5d` を記録しているが、この sha はここでも抽出元の monorepo でも解決
しない。**deploy は日付が付いているが再現できない。**

## 由来（custody）

`migration.edn` は出所を `etzhayyim/root` の tree `66443c00` と宣言する。移行後:

- 継承した 13 ファイル（`NOTICE` / `OWNERS` / `PROJECT.jsonld` / `README.edn` /
  `migration.edn` / `appview/README.md` / `kotoba/**` の 7 本）は **1 バイトも
  変わっていない**（sha256 を検証器に固定）
- **意図的に変更した**のは 3 つ: `appview/…/wrangler.jsonc`（`main` の付け替え、
  消えた SvelteKit client を指す `assets` の撤去、`APP_FRAMEWORK` の更新）、
  `appview/…/kotodama.jsonld`（`guestLanguage: ts → cljs`、`component.path` を
  cljs のソースへ）、`MIGRATION-TODO.md`（annotate 済みの違反行のうち 5 件が
  app.ts と共に消えたことを記録。**ボックスは 1 つも ticked にしていない**）
- TypeScript/Svelte の 8 ファイルは**移行で撤去**した。検証器はその 8 パスを
  名指しで「不在であること」を検査する —— byte 合計は「TS が消えた」と言えない

`PROJECT.jsonld` と `appview/README.md` は**意図的に触っていない**。どちらも
TypeScript / SvelteKit に言及するが、指しているのは抽出元プロジェクトの別の
コンポーネント（`cowork` の Go backend、nginx で配る `cowork-ui`、
`cowork-ui-72p8lz7d` / `cowork-v1gy375u`）であって、この repo の appview では
ない —— この移行はそれらを偽にしていないので、書き換えるとかえって嘘になる。

## 残っている欠陥（移行では直っていない）

1. **`kotoba/` は未移行で、そのテストは一度も走っていない**（上記）。
2. **`MIGRATION-TODO.md` のチェックボックス 7 件が未チェック**のまま。憲章適合の
   手動レビューは未実施であると文書自身が書いている。
3. **`compatibility_flags` の `nodejs_compat` / `nodejs_als` を残した。** cljs の
   bundle は node builtin を 1 つも import しないが、それは bundle を**読んで**
   確かめたのであって、flag 無しで workerd を起動して確かめたのではない。
   検証していない撤去はしない。
4. **`OWNERS` が approver と reviewer に同じ 1 名（`etzhayyim`）を置いている。**

## この移行で見つかった「落ちない検査」

**gate は緑を見ただけでは landed としない**という規律を当てた結果、2 つが
**壊しても赤くならなかった**:

1. **「bundle がビルドできる」は検査ではなかった。** `route/dispatch` を存在
   しない var に改名しても、shadow-cljs は `:undeclared-var` を warning 扱いして
   **exit 0** で終わり、最初のリクエストで落ちる bundle を `dist/worker.js` に
   **上書きした**。`shadow-cljs.edn` の `:compiler-options` に
   `:warnings-as-errors true` を足して直した（最初は `:build-options` に置いて
   しまい、**shadow が読まない場所なので黙って無視され、また exit 0 で通った**
   —— 落ちない検査を直す変更が、それ自身落ちない検査だった）。直したあとは
   rc=1 で落ち、`dist/worker.js` は 1 バイトも書き換わらない。
   このとき discriminate したのは
   `scripts/smoke-worker.cljs` だけで、**exit 2 で「判定できなかった」と言って
   合格を拒否した**。
2. **design-quality の gate は design system の欠落に鈍い。** DADS の CSS を
   丸ごと落としても 100.00 → 96.63 で、gate 95 を割らなかった
   （`jp-go-dds.page` が `ext-css` を `:css` とは別に inline するため）。
   これは**直していない**——測って記録した。gate が実際に赤くなるのは
   `jp-go-dds.page` 自体を通さない場合（56.18）。

全 mutation の記録は `docs/operator-quickstart.md` §7。

## 検証

```bash
kbb --backend sci scripts/verify-docs-claims.cljk .          # <dir> は先頭に置く
```

exit 0 = 全一致 / 1 = 食い違い / **2 = 判定できなかった**（0 と区別する）。
テスト・採点・ビルド・bundle の実行は `docs/operator-quickstart.md`。
