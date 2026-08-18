(ns cowork.worker
  "Cloudflare Worker の入口。**この repo で唯一 Request/Response に触る層。**

  ここには判断を置かない —— どのハンドラが答えるかは `cowork.route/dispatch`
  が決め、ページの中身は `cowork.view` が組み、上流応答の畳み方は
  `cowork.route/unwrap-mcp` が決める。どれも `.cljc` なので、ブラウザもビルドも
  無しにテストできる。

  wrangler.jsonc の `main` は `dist/worker.js` を指し、それはこの名前空間を
  コンパイルしたものである。移行前は `svelte/.svelte-kit/cloudflare/_worker.js`
  という **tracked file が 1 つも無いパス**を指していて、読み手が開く
  `src/app.ts`(882 行) はどの bundle にも入っていなかった（docs/adr/0001）。

  `aget` を使うのは `:advanced-optimization` 下で env のキーが潰れないため
  （先例 `listingops.edge.worker` と同じ約束）。"
  (:require [cowork.route :as route]
            [cowork.view :as view]
            [shadow.resource :as rc]
            [clojure.string :as str]))

(def ^:private dds-css
  "DADS の CSS はビルド時に bundle へ焼く。外部リクエストゼロが design system
  の方針で、Worker から resource を読む経路も無い。"
  (rc/inline "jp_go_dds/dds.css"))

(defn- ->response [body {:keys [status content-type cache extra]}]
  (js/Response.
   body
   #js {:status status
        :headers (clj->js (merge {"content-type" content-type
                                  "cache-control" (or cache "no-store")}
                                 extra))}))

(defn- json
  "移行前の SvelteKit `json()` + `noStore()` と同じ形: JSON 本文・
  `application/json`・`cache-control: no-store`。"
  [body status]
  (->response (js/JSON.stringify (clj->js body))
              {:status status :content-type "application/json"}))

(defn- env->map
  "env の **キーだけ** を keyword で拾う。値はページにも応答にも出さない。"
  [env]
  (if env
    (into {} (map (fn [k] [(keyword k) (aget env k)])) (js/Object.keys env))
    {}))

(defn- preflight
  "移行前の `+server.ts` の `OPTIONS` と**同じ 4 ヘッダだけ**を返す。
  content-type も cache-control も足さない（足すと 204 のヘッダが変わる）。"
  []
  (js/Response.
   nil
   #js {:status 204
        :headers #js {"access-control-allow-origin" "*"
                      "access-control-allow-methods" "POST,OPTIONS"
                      "access-control-allow-headers" "content-type,authorization"
                      "access-control-max-age" "86400"}}))

(def ^:private drop-request-headers
  "上流へ載せ替えないヘッダ。`host` は移行前も落としていた。`content-length` は
  移行前は**落としていなかった**が、本文は JSON-RPC の封筒に包み直されて長さが
  変わるので、元の長さを付け直すのは実装のバグの側である（意図的な差分。
  README『移行前との差分』を参照）。"
  #{"host" "content-length" "connection" "transfer-encoding"})

(defn- upstream-headers
  "呼び手のヘッダを引き継いだ上で、中継用のヘッダを立てる。`authorization` を
  透過させるのは移行前と同じ挙動である。"
  [req nsid]
  (let [h (js/Headers. (.-headers req))]
    (doseq [k drop-request-headers] (.delete h k))
    (.set h "content-type" "application/json")
    (.set h "x-etzhayyim-bff" route/bff-tag)
    (.set h "x-etzhayyim-xrpc-method" nsid)
    h))

(defn- proxy-xrpc
  "XRPC を MCP router へ中継する。移行前に deploy されていた SvelteKit の
  `xrpc/[...path]/+server.ts` と同じ形（jsonrpc の封筒に包み、
  `result` / `structuredContent` を剥がす）。"
  [req env nsid]
  (let [url (route/mcp-router-url (env->map env))]
    (-> (.json req)
        (.catch (fn [_] #js {}))
        (.then
         (fn [input]
           (js/fetch url
                     #js {:method "POST"
                          :headers (upstream-headers req nsid)
                          :body (js/JSON.stringify
                                 #js {:jsonrpc "2.0"
                                      :id (.randomUUID js/crypto)
                                      :method "tools/call"
                                      :params #js {:name nsid :arguments input}})})))
        (.then (fn [resp]
                 (-> (.text resp)
                     (.then (fn [text]
                              (let [payload (try (when (seq text) (js/JSON.parse text))
                                                 (catch :default _ text))
                                    clj-payload (js->clj payload :keywordize-keys true)
                                    {:keys [status body]}
                                    (route/unwrap-mcp clj-payload
                                                      {:upstream-ok? (.-ok resp)
                                                       :upstream-status (.-status resp)})]
                                (json body status)))))))
        (.catch (fn [e]
                  ;; 到達できなかったことを 200 で隠さない。移行時点で
                  ;; mcp.etzhayyim.com は NXDOMAIN なので、これは想像上の経路では
                  ;; なく今日の既定の結末である。移行前は例外がそのまま抜けて
                  ;; SvelteKit の 500 エラーページになっていた（意図的な差分）。
                  (json {:error "MCP router unreachable"
                         :detail (str (.-message e))
                         :url url}
                        502))))))

(defn- page-response [env]
  (->response
   (view/render {:css dds-css
                 :routes route/routes
                 :vars (sort (keys (env->map env)))
                 :mcp-url (route/mcp-router-url (env->map env))
                 :not-carried-over route/not-carried-over
                 :built-at nil})
   {:status 200
    :content-type "text/html; charset=utf-8"
    :cache "public, max-age=60"}))

(defn fetch-handler [req env _ctx]
  (let [url (js/URL. (.-url req))
        path (.-pathname url)
        {:keys [action nsid allow reason]} (route/dispatch (.-method req) path)]
    (case action
      :page   (page-response env)
      :xrpc   (proxy-xrpc req env nsid)
      :cors-preflight (preflight)
      :bad-request (json {:error reason} 400)
      :method-not-allowed (->response (js/JSON.stringify #js {:error "Method Not Allowed"})
                                      {:status 405
                                       :content-type "application/json"
                                       :extra {"allow" allow}})
      (json {:error "Not Found"
             :routes (mapv (fn [r] (str (str/upper-case (name (:route/method r)))
                                        " " (:route/path r)))
                           route/routes)}
            404))))

(def handler #js {:fetch fetch-handler})
