(ns cowork.route-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.string :as str]
            [cowork.route :as route]
            [cowork.view :as view]))

(deftest dispatch-page
  (is (= :page (:action (route/dispatch "GET" "/"))))
  (testing "HEAD は GET として扱う（Workers が body を落とす）"
    (is (= :page (:action (route/dispatch "HEAD" "/")))))
  (is (= :method-not-allowed (:action (route/dispatch "POST" "/"))))
  (is (= "GET, HEAD" (:allow (route/dispatch "POST" "/"))))
  (testing "SvelteKit に /health は無かった。足していない"
    (is (= :not-found (:action (route/dispatch "GET" "/health")))))
  (is (= :not-found (:action (route/dispatch "GET" "/nope")))))

(deftest dispatch-xrpc
  (testing "nsid が空なら 400 —— 移行前と同じ本文"
    (is (= {:action :bad-request :reason "Missing XRPC method"}
           (route/dispatch "POST" "/xrpc")))
    (is (= {:action :bad-request :reason "Missing XRPC method"}
           (route/dispatch "POST" "/xrpc/"))))
  (testing "単一セグメント"
    (is (= {:action :xrpc :nsid "com.etzhayyim.apps.coworkGraph.mailList"}
           (route/dispatch "POST" "/xrpc/com.etzhayyim.apps.coworkGraph.mailList"))))
  (testing "多段はそのまま中継する —— SvelteKit の [...path] は rest parameter
            なので、拒否に変えると deploy 済みの意味が変わる"
    (is (= {:action :xrpc :nsid "a/b"} (route/dispatch "POST" "/xrpc/a/b"))))
  (testing "preflight と method"
    (is (= :cors-preflight (:action (route/dispatch "OPTIONS" "/xrpc/x"))))
    (is (= :cors-preflight (:action (route/dispatch "OPTIONS" "/xrpc"))))
    (is (= :method-not-allowed (:action (route/dispatch "GET" "/xrpc/x"))))
    (is (= "POST, OPTIONS" (:allow (route/dispatch "GET" "/xrpc/x")))))
  (testing "前方一致で他のパスを飲み込まない"
    (is (nil? (route/xrpc-rest "/xrpcx")))
    (is (= :not-found (:action (route/dispatch "POST" "/xrpcx"))))))

(deftest mcp-url-resolution
  (is (= "https://mcp.etzhayyim.com/xrpc/com.etzhayyim.mcp.message"
         (route/mcp-router-url {})))
  (is (= "https://a.example/x"
         (route/mcp-router-url {:AGENTGATEWAY_MCP_ROUTER_URL "https://a.example/x/"})))
  (testing "空白だけの設定は未設定として扱う"
    (is (= "https://b.example"
           (route/mcp-router-url {:AGENTGATEWAY_MCP_ROUTER_URL "   "
                                  :MCP_ROUTER_URL "https://b.example"})))))

(deftest unwrap
  (let [ok {:upstream-ok? true :upstream-status 200}]
    (is (= {:status 200 :body {:a 1}}
           (route/unwrap-mcp {:result {:structuredContent {:a 1}}} ok)))
    (is (= {:status 200 :body {:a 1}} (route/unwrap-mcp {:result {:a 1}} ok)))
    (testing "封筒が無ければ素通し"
      (is (= {:status 200 :body {:a 1}} (route/unwrap-mcp {:a 1} ok))))
    (testing "nil は空 map（移行前の `structured ?? {}`）"
      (is (= {:status 200 :body {}} (route/unwrap-mcp {:result nil} ok)))
      (is (= {:status 200 :body {}} (route/unwrap-mcp nil ok))))
    (testing "error つきは 502"
      (is (= {:status 502
              :body {:error "boom" :upstream {:error {:message "boom"}}}}
             (route/unwrap-mcp {:error {:message "boom"}} ok)))
      (is (= 502 (:status (route/unwrap-mcp {:error {}} ok)))))
    (testing "上流が ok でなければ、その status をそのまま返す"
      (let [r (route/unwrap-mcp {:x 1} {:upstream-ok? false :upstream-status 429})]
        (is (= 429 (:status r)))
        (is (= "MCP router request failed" (get-in r [:body :error])))))))

(deftest page-shows-the-real-routes
  (testing "ページは route 表・env・持ち越さなかった一覧から描く。固定値を焼かない"
    (let [html (view/render {:css "/*x*/"
                             :routes route/routes
                             :vars [:APP_NANOID :AGENTGATEWAY_MCP_ROUTER_URL]
                             :mcp-url "https://mcp.example/x"
                             :not-carried-over route/not-carried-over})]
      (doseq [r route/routes]
        (is (str/includes? html (:route/path r))
            (str (:route/path r) " がページに出ていない")))
      (testing "件数も数えた値であって literal ではない"
        (is (str/includes? html (str "公開ルート " (count route/routes) " 件"))))
      (is (str/includes? html "APP_NANOID"))
      (is (str/includes? html "https://mcp.example/x"))
      (doseq [t (:tools route/not-carried-over)]
        (is (str/includes? html (str "com.etzhayyim.apps.coworkGraph." t))
            (str t " が『持ち越さなかった』表に出ていない")))
      (testing "移行前のページが出していた偽の文がもう無い"
        (is (not (str/includes? html "No public route is declared")))
        (is (not (str/includes? html "No public vars are declared")))))))

(deftest page-renders-what-it-is-handed
  (testing "route 表を差し替えれば表示も変わる（= 焼いていない証拠）"
    (let [html (view/render {:css ""
                             :routes [{:route/path "/only" :route/method :get
                                       :route/kind :page :route/doc "one"}]
                             :vars []
                             :mcp-url "https://z.example"
                             :not-carried-over {:reason "r" :nsid-prefix "n" :tools ["t"]}})]
      (is (str/includes? html "/only"))
      (is (str/includes? html "公開ルート 1 件"))
      (is (not (str/includes? html "/xrpc/*")))
      (is (str/includes? html "env が渡されていない")))))
