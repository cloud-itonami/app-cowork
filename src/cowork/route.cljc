(ns cowork.route
  "Which handler answers a request — as data, decided by a pure function.

  This is `.cljc` and not `.cljs` on purpose. Routing is the part of an edge
  worker that is worth testing, and it is testable here without a browser, a
  build, or a network. `cowork.worker` is the only namespace that touches
  Request/Response, and it does nothing this file has not already decided.

  It is also the first thing that should move to `.kotoba` once the ingress
  capability qualifies (`:native-aot`/`:wasm-aot` are pending today —
  ADR-2606290000): a route table is a decision over scalars and strings,
  which is exactly the shape that survives that move.

  **The surface below is the SvelteKit surface that was actually deployed**,
  not a redesign of it. `/health` is deliberately absent because the SvelteKit
  app had no such route, and adding one would change `/health` from 404 to 200
  — the migration is not the place to change what the deployment answers."
  (:require [clojure.string :as str]))

(def routes
  "The public surface, as data. The landing page renders THIS, so a route that
  exists and a route the page advertises cannot drift apart.

  Derived by reading the deployed SvelteKit tree before it was removed:
  `svelte/src/routes/+page.svelte` (the page) and
  `svelte/src/routes/xrpc/[...path]/+server.ts` (which exported exactly `POST`
  and `OPTIONS`; SvelteKit answers every other method on that path with 405)."
  [{:route/path "/"        :route/method :get     :route/kind :page
    :route/doc "この appview の説明ページ"}
   {:route/path "/xrpc/*"  :route/method :post    :route/kind :proxy
    :route/doc "XRPC を MCP router へ中継する（jsonrpc tools/call に包む）"}
   {:route/path "/xrpc/*"  :route/method :options :route/kind :cors
    :route/doc "CORS preflight。204 を返す"}])

(def not-carried-over
  "`appview/…/src/app.ts` にあって、この移行が **意図的に持ち越さなかった**
  16 個の MCP tool。黙って消していないことを、ページ・README・検証器が同じ
  この 1 つの値から言うためにここに置く。

  持ち越さない理由は 1 つで、**全部同じ**である: これらが読む binding
  （`GRAPH_D1` / `SS_GRAPH_CLIENT_SECRET` / `SS_GRAPH_TOKEN_KEK` /
  `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_SCOPE` / `HYPERDRIVE`）は
  **1 つも wrangler.jsonc に宣言されていない**（実測 2026-08-18、
  `d1_databases` も `hyperdrive` も `secrets_store_secrets` も無く、`vars` の
  16 件は `APP_*` メタデータ + MCP router URL + `INTERFACES_REQUIRES`）。
  上流ホスト自体は解決する（`graph.microsoft.com` /
  `login.microsoftonline.com` とも A レコードあり）ので、死んでいるのは
  宛先ではなく **credential と DB の側**である。

  動かない経路を移植して『移行済み』と言わないため持ち越さない。必要になった
  時点で、binding の宣言とテストを伴って戻す。"
  {:reason "wrangler.jsonc に binding が 1 つも宣言されていない（GRAPH_D1 / SS_GRAPH_CLIENT_SECRET / SS_GRAPH_TOKEN_KEK / GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_SCOPE / HYPERDRIVE のいずれも無い）"
   :nsid-prefix "com.etzhayyim.apps.coworkGraph"
   :tools ["mailList" "mailGet" "mailDraft"
           "teamsChannelList" "teamsMessageList"
           "filesList" "filesGet"
           "calendarList"
           "userGet" "userList"
           "graphActorGet" "graphQuery" "graphMvQuery"
           "sendTeamsMessage" "listMyFormTasks" "sendBpmnGuidance"]})

(def bff-tag
  "中継時に上流へ名乗る runtime。移行前は `sveltekit-edge-bff` だったが、
  SvelteKit はもう無いので**名乗りを実態に合わせた**（意図的な差分）。"
  "cljs-esm-worker")

(defn xrpc-rest
  "`/xrpc` および `/xrpc/<rest>` の rest 部分。それ以外は nil。

  **多段パスをそのまま返すのは、deploy されていた挙動に忠実だからである。**
  SvelteKit の `[...path]` は rest parameter なので `/xrpc/a/b` は
  `params.path = \"a/b\"` になり、そのまま nsid として中継されていた。
  ここで拒否に変えると、移行が deploy 済みの意味を変えてしまう。"
  [path]
  (let [p (or path "")]
    (cond
      (= p "/xrpc") ""
      (str/starts-with? p "/xrpc/") (subs p (count "/xrpc/"))
      :else nil)))

(defn dispatch
  "method + path → 何をするか。Request も Response も知らない。

  返すのは `{:action …}` で、`:action` は
  `:page` / `:xrpc` / `:cors-preflight` / `:bad-request` /
  `:method-not-allowed` / `:not-found` のいずれか。

  HEAD は GET として扱う（Workers が body を落とす）。"
  [method path]
  (let [m (keyword (str/lower-case (or method "GET")))
        m (if (= m :head) :get m)
        rest' (xrpc-rest path)]
    (cond
      (some? rest')
      (case m
        :post    (if (seq rest')
                   {:action :xrpc :nsid rest'}
                   ;; 移行前と同じ本文・同じ status。
                   {:action :bad-request :reason "Missing XRPC method"})
        :options {:action :cors-preflight}
        {:action :method-not-allowed :allow "POST, OPTIONS"})

      (= path "/")
      (if (= m :get)
        {:action :page}
        {:action :method-not-allowed :allow "GET, HEAD"})

      :else {:action :not-found})))

(defn mcp-router-url
  "env の設定 → MCP router の URL。末尾スラッシュは落とす。

  移行前の `+server.ts` と同じ優先順（`AGENTGATEWAY_MCP_ROUTER_URL` →
  `MCP_ROUTER_URL` → 既定値）。空白だけの設定は未設定として扱う。

  既定値をここに焼くのは、設定が無いときに黙ってどこかへ POST しないため
  ではなく、**どこへ行くのかを 1 箇所で読めるようにする**ためである。"
  [{:keys [AGENTGATEWAY_MCP_ROUTER_URL MCP_ROUTER_URL]}]
  (let [pick (fn [s] (when (and (string? s) (seq (str/trim s))) s))]
    (-> (or (pick AGENTGATEWAY_MCP_ROUTER_URL)
            (pick MCP_ROUTER_URL)
            "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message")
        (str/replace #"/+$" ""))))

(defn unwrap-mcp
  "MCP router の応答 → 呼び手に返す値と status。

  移行前の `+server.ts` の分岐をそのまま写したもの:

    upstream が ok でない            → `{:error \"MCP router request failed\" :upstream p}` / upstream の status
    payload に `error` がある        → `{:error <message>} ` / 502
    `{:result {:structuredContent X}}` → X / 200
    `{:result X}`                    → X / 200
    それ以外                          → payload そのもの / 200

  最後に `?? {}` —— nil は空 map になる（TS 側の `structured ?? {}`）。"
  [payload {:keys [upstream-ok? upstream-status]}]
  (let [nil->empty (fn [v] (if (nil? v) {} v))]
    (cond
      (not upstream-ok?)
      {:status (or upstream-status 502)
       :body {:error "MCP router request failed" :upstream payload}}

      (and (map? payload) (contains? payload :error))
      {:status 502
       :body {:error (or (get-in payload [:error :message])
                         "MCP router returned an error")
              :upstream payload}}

      :else
      (let [result (if (and (map? payload) (contains? payload :result))
                     (:result payload)
                     payload)
            structured (if (and (map? result) (contains? result :structuredContent))
                         (:structuredContent result)
                         result)]
        {:status 200 :body (nil->empty structured)}))))
