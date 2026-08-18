# Operator quickstart — app-cowork

**この repo で今日実際にできることを、踏める形で上から書く。** 所要 10 分
（うち大半はビルド待ち）。Cloudflare のアカウントは要らない（§8 の deploy だけ
が要る）。

出力はすべて 2026-08-18 に実際に walk した結果である。**歩けなかったものは
§9 に、歩けなかったと書いてある。**

## 0. 前提

| 要るもの | 確認 | この walk で使った版 |
|---|---|---|
| git | `git --version` | 2.51.0 |
| nbb | `npx --yes nbb --version` | v1.4.208 |
| node | `node --version` | v26.3.0 |
| clojure | `clojure --version` | 1.12.5.1654（ビルド時のみ） |

## 1. 取得して、書いてあることが本当か検査する

```bash
git clone git@github.com:cloud-itonami/app-cowork.git
cd app-cowork
REPO=$PWD
npx --yes nbb scripts/verify-docs-claims.cljs .
```

実際の出力:

```
SCANNED	29
PASS	tracked-files	expected=29	actual=29
PASS	preserved-files-unchanged	expected=[]	actual=[]
PASS	removed-by-migration-absent	expected=[]	actual=[]
PASS	appview-ts-files	expected=0	actual=0
PASS	canonical-files	expected=4	actual=4
PASS	kotoba-ts-files	expected=5	actual=5
PASS	wrangler-main	expected="../../dist/worker.js"	actual="../../dist/worker.js"
PASS	declared-vars	expected=16	actual=16
PASS	declared-routes	expected=2	actual=2
PASS	app-framework-is-cljs	expected="cljs-esm-worker"	actual="cljs-esm-worker"
PASS	no-stale-assets-binding	expected=true	actual=true
PASS	shadow-builds-that-main	expected=true	actual=true
PASS	kotodama-guest-language	expected="cljs"	actual="cljs"
PASS	kotodama-component-is-cljs	expected=true	actual=true
PASS	page-renders-route-table	expected=true	actual=true
PASS	public-routes	expected=3	actual=3
PASS	dropped-tools	expected=16	actual=16
PASS	readme-names-every-dropped-tool	expected=[]	actual=[]
OK	every claim in README.md and docs/operator-quickstart.md holds
```

末尾が `OK` なら README の数値・存在・不在は tree と一致している。
**exit 2（UNDETERMINED）は 0 ではない** —— tree を読み切れなかったという別の
答えで、「検査して問題なし」と混ぜない。

この検査には移行の不変条件が入っている: appview に TypeScript が戻っていない
こと（撤去した 8 パスの不在 **と** `.ts`/`.svelte` の総数の両方 —— 別々の
claim が別々の戻り方を捕まえる）、`kotoba/` が**まだ TypeScript 5 本のままで
ある**こと（移行していないので、README がそれを隠したら落ちる）、
`wrangler.jsonc` の `main` が shadow の出力先を指していること、ページが route
表から描かれていること、持ち越さなかった 16 tool を README が全部名指しして
いること。

## 2. 移行前の状態を自分で測り直す（この repo が何だったか）

`git show` で移行前の tree に当たれば、README の主張は自分で確かめられる。

```bash
BEFORE=caef100          # 移行の 1 つ前の commit
git show $BEFORE:appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/wrangler.jsonc | grep '"main"'
#   "main": "svelte/.svelte-kit/cloudflare/_worker.js",

git ls-tree -r --name-only $BEFORE | grep -c 'svelte-kit'
#   0                       <- main が指す先は tracked file を 1 つも持たない

git show $BEFORE:appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/src/app.ts | wc -l
#   882                     <- どの bundle にも入っていなかった 882 行

git grep -l 'kotodama-host-sdk' $BEFORE
#   caef100:appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/src/app.ts
#                           <- 唯一の出現は app.ts 自身の import 文
```

binding が 1 つも無いことも同じように測れる:

```bash
git show $BEFORE:appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/src/app.ts \
  | grep -oE 'env\.[A-Za-z_][A-Za-z0-9_]*' | sort -u
#   env.GRAPH_CLIENT_ID env.GRAPH_D1 env.GRAPH_SCOPE env.GRAPH_TENANT_ID
#   env.HYPERDRIVE env.SS_GRAPH_CLIENT_SECRET env.SS_GRAPH_TOKEN_KEK

python3 -c "import json,io,re,sys;s=sys.stdin.read();s=re.sub(r'(?m)^\s*//.*$','',s);print(sorted(json.loads(s)))" \
  < appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/wrangler.jsonc
#   ['compatibility_date','compatibility_flags','main','name','routes','rules','vars']
```

`d1_databases` も `hyperdrive` も `secrets_store_secrets` も無い。**したがって
16 個の Graph tool は、deploy されていなかっただけでなく、この設定では動けな
かった。** これが `README.md` の「持ち越さなかった経路」の根拠である。

呼び先の DNS も自分で引ける（実測 2026-08-18、3 つとも NXDOMAIN）:

```bash
for h in cowork-graph.etzhayyim.com c0w0rkg1.etzhayyim.com mcp.etzhayyim.com; do
  dig "$h" +noall +comment | grep -o 'status: [A-Z]*'; done
#   status: NXDOMAIN
#   status: NXDOMAIN
#   status: NXDOMAIN

dig +short graph.microsoft.com | tail -1        # 20.190.141.45  <- 上流は生きている
```

## 3. テストを走らせる（ビルド不要・ブラウザ不要）

判断（`route.cljc`）と描画（`view.cljc`）は純 `.cljc` なので、nbb だけで回る。

```bash
K=~/github/com-junkawasaki/orgs/kotoba-lang
CP="src:test:$K/jp-go-digital-design-system/src:$K/html/src:$K/css/src"
cat > /tmp/run.cljs <<'EOF'
(require '[cljs.test :refer [run-tests]] 'cowork.route-test)
(run-tests 'cowork.route-test)
EOF
npx --yes nbb --classpath "$CP" /tmp/run.cljs
```

実際の出力:

```
Testing cowork.route-test

Ran 6 tests containing 56 assertions.
0 failures, 0 errors.
```

何を固定しているか: `/xrpc/` と `/xrpc` が `{"error":"Missing XRPC method"}` の
400 になること、`/xrpc/a/b` が **そのまま中継される**こと（SvelteKit の
`[...path]` は rest parameter だったので、拒否に変えると deploy 済みの意味が
変わる）、`/health` を**足していない**こと、MCP router の URL 解決、
`result` / `structuredContent` の剥がし方と `?? {}`、そして**ページが route 表
から描かれること**（固定値を焼いていたら落ちる）。

## 4. ページを描画して採点する

```bash
K=~/github/com-junkawasaki/orgs/kotoba-lang
CP="src:$K/jp-go-digital-design-system/src:$K/html/src:$K/css/src"
DDS="$K/jp-go-digital-design-system" \
  npx --yes nbb --classpath "$CP" scripts/render-page.cljs /tmp/cowork-page.html

cd $K/design-quality && npx --yes nbb -m design-quality.cli score /tmp/cowork-page.html --min 95
```

実際の出力（末尾）:

```
  100.00  /tmp/cowork-page.html
aggregate: 100.00
findings (headroom-first):
  (none — converged)
gate: aggregate 100.00 >= min 95.00 -> PASS
```

## 5. bundle をビルドする

**高負荷ビルドは同時 1 本に制限されている**（superproject `CLAUDE.md` の
resource governor）。直接叩かず、必ず guard 経由で:

```bash
cd "$REPO"
node ~/github/com-junkawasaki/scripts/resource-guard.mjs run build -- \
  npx --yes shadow-cljs release worker
ls -la dist/worker.js
```

lock を他セッションが持っていると exit 2 で拒否される。**迂回しない** ——
`resource-guard: build is already running (pid=…)` はエラーではなく順番待ちで
ある（この walk では別セッションの build を **約 80 分** 待った（このマシンは load average 100 超で並行 agent が走っていた））。

実際の出力（末尾）:

```
[:worker] Build completed. (55 files, 12 compiled, 0 warnings, 104.72s)

-rw-r--r--  1 junkawasaki  wheel  246914  8月 18 18:58 dist/worker.js
```

## 6. ビルドした成果物を実際に叩く

ここが deploy されるものに触る唯一の検査である。

```bash
cd "$REPO" && npx --yes nbb scripts/smoke-worker.cljs dist/worker.js
```

```
PASS	default export has fetch	expected=true	actual=true
PASS	GET / status	expected=200	actual=200
PASS	GET / is html	expected=true	actual=true
PASS	page advertises /xrpc/*	expected=true	actual=true
PASS	page counts the routes it was handed	expected=true	actual=true
PASS	page names all 16 dropped tools	expected=16	actual=16
PASS	page shows a var key	expected=true	actual=true
PASS	page hides var values	expected=false	actual=false
PASS	no false 'no route' sentence	expected=false	actual=false
PASS	page carries the design system	expected=true	actual=true
PASS	POST /xrpc/ status	expected=400	actual=400
PASS	POST /xrpc/ body	expected=true	actual=true
PASS	OPTIONS preflight	expected=204	actual=204
PASS	preflight allows any origin	expected="*"	actual="*"
PASS	unknown path	expected=404	actual=404
PASS	no /health was added	expected=404	actual=404
PASS	wrong method on /	expected=405	actual=405
PASS	wrong method on /xrpc	expected=405	actual=405
PASS	405 names what is allowed	expected="POST, OPTIONS"	actual="POST, OPTIONS"
PASS	unreachable upstream is 502	expected=502	actual=502
PASS	unreachable upstream says so	expected=true	actual=true
OK	the built bundle answers as the route table says
```

**bundle が無ければ exit 2**（「判定できなかった」であって合格ではない）:

```
$ npx --yes nbb scripts/smoke-worker.cljs dist/worker.js     # bundle を退避して実行
UNDETERMINED	no bundle at /private/tmp/app-cowork-cljs/dist/worker.js
Refusing to report a pass: build it first (see docs/operator-quickstart.md §5).
$ echo $?
2
```

## 7. 検査が落ちることを確かめた（mutation の記録）

**落ちない検査は劇場である。** 各 gate について、それが読むものを実際に壊して
正しい検査が赤くなることを見てから戻した。**外した mutation（検査が読んでいない
別の場所を壊したもの）の赤は実演と数えない** —— 下の表にはその 1 件も、外した
と分かる形で載せてある。

| # | 何を壊したか | 何が赤くなったか | 判定 |
|---|---|---|---|
| M1 | `view.cljc` の `(count routes)` を `3` に焼く | test `page-renders-what-it-is-handed`（1 route を渡したのにページが「3 件」と言った）。1 failures | ✅ 狙いどおり |
| M2 | `xrpc-rest` が多段パスを拒否するようにする | test `dispatch-xrpc`（`/xrpc/a/b` が `:xrpc` でなくなった）。1 failures | ✅ 狙いどおり |
| M3 | `render` に渡す DADS の CSS を空にする | score 100.00 → **96.63、gate は PASS のまま** | ❌ **外した**。gate 95 に届かない |
| M3b | `jp-go-dds.page` を通さず shell を手書きする | score **56.18 < 95 → FAIL**（exit 1） | ✅ 狙いどおり |
| V1 | 撤去した `src/app.ts` を元のパスに戻す | `tracked-files` / `removed-by-migration-absent` / `appview-ts-files` の 3 つ | ✅ |
| V2 | TypeScript を**別名**（`handler.ts`）で入れる | `appview-ts-files`（`removed-by-migration-absent` は正しく緑のまま） | ✅ 別々の戻り方を別々の claim が捕まえる |
| V3 | `wrangler.jsonc` の `main` を SvelteKit の出力に戻す | `wrangler-main` / `shadow-builds-that-main` | ✅ |
| V4 | README から `graphMvQuery` の名前を 1 つ消す | `readme-names-every-dropped-tool`（消した名前を出力に名指しする） | ✅ |
| V5 | 継承ファイル `kotoba/src/types.ts` に 1 行足す | `preserved-files-unchanged` | ✅ |
| V6 | `route.cljc` に 4 本目の route を黙って足す | `public-routes` | ✅ |
| B1 | `worker.cljs` の `route/dispatch` を存在しない var に改名し、ビルドする | **何も赤くならなかった。** shadow は `WARNING #1 - :undeclared-var` を出して **exit 0**、壊れた bundle を書き出した | ❌ **gate が落ちなかった** → 下記で直した |
| B2 | 同じ mutation を `:build-options {:warnings-as-errors true}` を足した後にビルドする | **まだ落ちなかった**（rc=0、warning のまま）。shadow が読むのは `[:compiler-options :warnings-as-errors]` で、`:build-options` に置くと**黙って無視される** | ❌ **直し方を間違えた** |
| B3 | mutation を戻してビルドし直す | rc=0、`55 files, 0 compiled, 0 warnings, 29.56s`、bundle は元と**同一 sha**（`2672d6c2f406c871`）、smoke 21/21 | ✅ 復旧の確認 |
| B4 | `:warnings-as-errors` を `:compiler-options` へ移してから、同じ mutation を再投入 | **rc=1** / `------ ERROR ---` `Use of undeclared Var cowork.route/dispatch-typo` / **`dist/worker.js` は 1 バイトも書き換わらなかった**（sha 不変）/ 戻すと smoke は再び緑 | ✅ 狙いどおり |
| S1 | ビルド済み bundle から `/xrpc/*` の文字列を潰す | smoke の `page advertises /xrpc/*` **だけ**が落ちる（exit 1） | ✅ |
| S2 | `dist/worker.js` を退避して smoke を回す | `UNDETERMINED` を出して **exit 2**（0 とも 1 とも別の答え） | ✅ |
| S3 | env の**表示される**値（MCP router URL）を sentinel にする | smoke の `page hides var values` が **expected=false actual=true** で落ちる（exit 1） | ✅ |

**B1 がこの反復で一番の収穫である。** 「bundle がビルドできる」は、そのままでは
**検査ではなかった** —— shadow-cljs は `:undeclared-var` を warning 扱いにして
exit 0 を返し、最初のリクエストで
`Cannot read properties of undefined (reading 'h')` を投げる bundle を
`dist/worker.js` に**上書きした**。落ちないことを見て初めて分かったので、
直そうとして**もう一度同じ罠を踏んだ**（B2）: `:build-options
{:warnings-as-errors true}` は shadow が読まない場所で、**黙って無視され、
mutated build はまた exit 0 だった**。「落ちない検査」を直す変更が、それ自身
落ちない検査になっていた。shadow の実装
（`shadow/build/compiler.clj` の `should-warning-throw?` が
`[:compiler-options :warnings-as-errors]` を引く）を読んで置き場所を直し、
**B4 で初めて rc=1 になり、しかも `dist/worker.js` が 1 バイトも書き換わらない
ことまで確かめた。**

**このとき唯一 discriminate したのは smoke である** —— 壊れた bundle に対して
`UNDETERMINED ... could not exercise the bundle` を出して **exit 2** で終わり、
「合格」を報告するのを拒否した。gate を 2 本持っていたことが効いた。

**M3 は正直に失敗として残してある。** DADS の CSS を丸ごと落としても gate を
割らないのは、`jp-go-dds.page` が `ext-css`（safe-area / tap-target / responsive
を持つ層）を `:css` とは別に inline するからである。**「壊したのに緑だった」を
成功に読み替えない** —— 読み替えていたら、この gate は design system の欠落に
対して鈍いという事実を見落としていた。

**S3 は app-ongakuka で実測された落とし穴への答えである。** 「env の値がページに
出ていない」検査は、探す文字列を引用符ごと書くと renderer が `"` を `&quot;` に
escape するので**構造的に落ちなくなる**。ここでは最初から印
（`SENTINEL-c0w0rk-7b21e4`）を使い、その印が**実際に表示される値の側**に入ったら
検査が赤くなることを確かめてある。

## 8. deploy

```bash
cd "$REPO/appview/etzhayyim-wasm-cowork-graph-c0w0rkg1"
npx wrangler deploy
```

**この walk では deploy していない。** 加えて route が指すホストは解決しない
（`cowork-graph.etzhayyim.com` / `c0w0rkg1.etzhayyim.com` とも NXDOMAIN）ので、
deploy が成功しても誰も到達できない。`/xrpc/` の中継先 `mcp.etzhayyim.com` も
同様なので、到達できたとしても中継は **502 を返す**（成功と同じ形で隠さない）。

superproject の deploy guard は `origin/main` を含む checkout からの deploy しか
許さない点も併せて注意。

## 9. 歩けなかったもの

- **`wrangler dev` / workerd での起動**。したがって
  `compatibility_flags` の `nodejs_compat` / `nodejs_als` を**外して**も動くか
  どうかは**確かめていない**。bundle が node builtin を import しないことは
  読んで確かめたが、それは flag が不要であることの証明ではない。**検証して
  いない撤去はしないので、flag は残してある。**
- **`kotoba/` のテスト（10 tests / 152 行）**。移行していないだけでなく、
  この機械では install もできない:

  ```bash
  cd kotoba && npm install
  #   npm error code EALLOWSCRIPTS
  #   npm error --allow-scripts is not allowed in project-scoped installs.
  ```

  依存 2 本が git URL で、その準備が入れ子 install を起こし npm 11.16.0 が拒否
  する。**移植の oracle（移植前の振る舞い）が取れない**ので、この移行では
  触っていない。ここは何も「合格した」と言っていない。
- **`MIGRATION-TODO.md` の 7 項目の憲章適合レビュー**。移行は `app.ts` を撤去
  したので annotate 済みの違反行 5 件は消えたが、**ボックスは 1 つも ticked に
  していない** —— レビューそのものは行われていない。

## 10. ここに無いもの

- `mailList` / `mailGet` / `mailDraft` / `teamsChannelList` / `teamsMessageList`
  / `filesList` / `filesGet` / `calendarList` / `userGet` / `userList` /
  `graphActorGet` / `graphQuery` / `graphMvQuery` / `sendTeamsMessage` /
  `listMyFormTasks` / `sendBpmnGuidance` —— 移行前の `src/app.ts` にあり、
  どこにも deploy されておらず、binding も宣言されていなかった 16 経路。
  **持ち越していない**（README の「持ち越さなかった経路」）
- `/health` —— SvelteKit 側に無かったので**足していない**
- Microsoft Graph そのもの（credential custody と送信の実行は etzhayyim 側）
