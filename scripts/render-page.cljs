#!/usr/bin/env nbb
;; render-page — ページを 1 枚の HTML に書き出す。決定論的 audit
;; (kotoba-lang/design-quality) の入力を作るためだけのもので、Worker は
;; これを使わない（Worker は shadow.resource/inline で CSS を焼く）。
;;
;; Usage:  nbb scripts/render-page.cljs <out.html> [--dds <path>]
;; Exit:   0 書けた · 2 書けなかった（CSS が読めない等）

(require '["node:fs" :as fs]
         '[clojure.string :as str]
         '[cowork.view :as view]
         '[cowork.route :as route])

(def args (vec *command-line-args*))
(def out (or (first (remove #(str/starts-with? % "--") args)) "/tmp/cowork-page.html"))
(def dds-root (or (.-DDS js/process.env)
                  (second (drop-while #(not= % "--dds") args))))

(def css
  (try (.readFileSync fs (str dds-root "/resources/jp_go_dds/dds.css") "utf8")
       (catch :default e
         (println (str "UNDETERMINED\tcould not read dds.css under " (pr-str dds-root)
                       ": " (.-message e)))
         (js/process.exit 2))))

(.writeFileSync fs out
                (view/render {:css css
                              :routes route/routes
                              :vars [:AGENTGATEWAY_MCP_ROUTER_URL :APP_ACTOR_HANDLE
                                     :APP_CAPABILITIES :APP_NANOID :APP_UI_TYPE]
                              :mcp-url (route/mcp-router-url {})
                              :not-carried-over route/not-carried-over}))
(println (str "OK\t" out "\t" (.-size (.statSync fs out)) " bytes"))
