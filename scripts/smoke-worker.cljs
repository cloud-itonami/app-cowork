#!/usr/bin/env nbb
;; smoke-worker — 実際にビルドされた bundle を import して叩く。
;;
;; ここが「deploy される成果物」に触る唯一の検査である。テスト
;; (test/cowork/route_test.cljc) はソースの判断を固定するが、bundle が本当に
;; Worker の形で答えるかは言えない —— export の形、shadow の
;; :advanced-optimization による名前の潰れ、`shadow.resource/inline` で焼いた
;; CSS は、どれもビルドを通って初めて存在する。
;;
;; Usage:  nbb scripts/smoke-worker.cljs [<dist/worker.js>]
;; Exit:   0 全て期待どおり · 1 期待と違う · 2 判定できなかった（bundle が無い等）

(require '["node:fs" :as fs] '["node:path" :as path] '["node:url" :as url]
         '[clojure.string :as str])

(def bundle
  "ESM の import は相対パスを package 名と読むので、必ず絶対パスに直してから
  file:// URL にする（`dist/worker.js` をそのまま渡すと『Cannot find package
  dist』になる。実測）。"
  (let [a (first (remove #(str/starts-with? % "--") *command-line-args*))]
    (.resolve path (or a "dist/worker.js"))))

(def failures (atom []))
(defn check! [label expected actual]
  (let [ok (= expected actual)]
    (println (str (if ok "PASS" "FAIL") "\t" label
                  "\texpected=" (pr-str expected) "\tactual=" (pr-str actual)))
    (when-not ok (swap! failures conj label))))

(when-not (.existsSync fs bundle)
  (println (str "UNDETERMINED\tno bundle at " bundle))
  (println "Refusing to report a pass: build it first (see docs/operator-quickstart.md §5).")
  (js/process.exit 2))

(def sentinel
  "env の VALUE がページに出ていないことを確かめるための印。実在しそうな値
  （\"appview\" 等）だと二つの問題がある: 他の文言と偶然一致しうるし、引用符
  ごと探すと renderer が \" を &quot; に escape するので**決して一致しない**
  —— つまり検査が構造的に落ちなくなる。app-ongakuka の移行で実測したので、
  ここでは最初から印を使う。"
  "SENTINEL-c0w0rk-7b21e4")

(def env
  ;; MCP router は到達できない先を明示的に指す。127.0.0.1:9 は discard port で
  ;; 即 refuse されるので、外に一切出ず、しかも決定論的に「上流に届かない」を
  ;; 作れる（本番の既定 mcp.etzhayyim.com は NXDOMAIN なので同じ結末になるが、
  ;; そちらは DNS に依存する）。
  #js {"APP_NANOID" "c0w0rkg1"
       "APP_UI_TYPE" sentinel
       "AGENTGATEWAY_MCP_ROUTER_URL" "http://127.0.0.1:9/unreachable"})

(defn- call
  ([h method p] (call h method p nil))
  ([h method p body]
   (let [init (if body
                #js {:method method
                     :body (js/JSON.stringify (clj->js body))
                     :headers #js {"content-type" "application/json"}}
                #js {:method method})
         req (js/Request. (str "https://cowork-graph.etzhayyim.com" p) init)]
     (-> (js/Promise.resolve ((.-fetch h) req env #js {}))
         (.then (fn [res] (-> (.text res)
                              (.then (fn [b] {:status (.-status res)
                                              :ct (.get (.-headers res) "content-type")
                                              :allow (.get (.-headers res) "allow")
                                              :acao (.get (.-headers res)
                                                          "access-control-allow-origin")
                                              :body b})))))))))

(-> (js/import (.-href (.pathToFileURL url bundle)))
    (.then
     (fn [m]
       (let [h (.-default m)]
         (check! "default export has fetch" true (fn? (.-fetch h)))
         (-> (js/Promise.all
              #js [(call h "GET" "/") (call h "POST" "/xrpc/")
                   (call h "OPTIONS" "/xrpc/x") (call h "GET" "/nope")
                   (call h "POST" "/") (call h "GET" "/xrpc/x")
                   (call h "GET" "/health")
                   (call h "POST" "/xrpc/com.etzhayyim.apps.coworkGraph.mailList" {:userId "u"})])
             (.then
              (fn [[page bad pre nf mna wrong health proxied]]
                (check! "GET / status" 200 (:status page))
                (check! "GET / is html" true (str/includes? (or (:ct page) "") "text/html"))
                ;; ページは route 表から描かれる。表にある path が全部出ていること。
                (doseq [p ["/xrpc/*"]]
                  (check! (str "page advertises " p) true (str/includes? (:body page) p)))
                (check! "page counts the routes it was handed" true
                        (str/includes? (:body page) "公開ルート 3 件"))
                ;; 持ち越さなかった 16 経路をページが名指しする（黙って消していない）
                (check! "page names all 16 dropped tools" 16
                        (count (filter #(str/includes? (:body page)
                                                       (str "com.etzhayyim.apps.coworkGraph." %))
                                       ["mailList" "mailGet" "mailDraft" "teamsChannelList"
                                        "teamsMessageList" "filesList" "filesGet" "calendarList"
                                        "userGet" "userList" "graphActorGet" "graphQuery"
                                        "graphMvQuery" "sendTeamsMessage" "listMyFormTasks"
                                        "sendBpmnGuidance"])))
                ;; env のキーは出す、値は出さない
                (check! "page shows a var key" true (str/includes? (:body page) "APP_NANOID"))
                (check! "page hides var values" false (str/includes? (:body page) sentinel))
                ;; 移行前のページが出していた偽の文がもう無い
                (check! "no false 'no route' sentence" false
                        (str/includes? (:body page) "No public route is declared"))
                ;; DDS の CSS が bundle に焼かれている
                (check! "page carries the design system" true
                        (str/includes? (:body page) "dads-table"))
                ;; nsid 無しの XRPC は 400。本文は移行前と同じ
                (check! "POST /xrpc/ status" 400 (:status bad))
                (check! "POST /xrpc/ body" true
                        (str/includes? (:body bad) "Missing XRPC method"))
                (check! "OPTIONS preflight" 204 (:status pre))
                (check! "preflight allows any origin" "*" (:acao pre))
                (check! "unknown path" 404 (:status nf))
                (check! "no /health was added" 404 (:status health))
                (check! "wrong method on /" 405 (:status mna))
                (check! "wrong method on /xrpc" 405 (:status wrong))
                (check! "405 names what is allowed" "POST, OPTIONS" (:allow wrong))
                ;; 上流に届かないことを 200 で隠さない
                (check! "unreachable upstream is 502" 502 (:status proxied))
                (check! "unreachable upstream says so" true
                        (str/includes? (:body proxied) "MCP router unreachable"))
                (let [f @failures]
                  (if (seq f)
                    (do (println (str "FAILED\t" (count f) " check(s): " (str/join ", " f)))
                        (js/process.exit 1))
                    (do (println "OK\tthe built bundle answers as the route table says")
                        (js/process.exit 0))))))))))
    (.catch (fn [e]
              (println (str "UNDETERMINED\tcould not exercise the bundle: " (.-message e)))
              (js/process.exit 2))))
