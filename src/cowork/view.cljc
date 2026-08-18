(ns cowork.view
  "この appview の説明ページ。純 hiccup。

  基盤は `jp-go-dds`(デジタル庁デザインシステム) —— superproject の
  skill `kotoba-uiux` が定める新規 UI の base。色・寸法は `--hig-*` トークン
  契約で書き、raw hex も px フォントサイズも置かない。

  **表示する事実は引数で受け取る。ページの中に焼かない。**
  移行前の `+page.svelte` は route 数・route 一覧・var 一覧を literal の
  オブジェクトとして持っていて、隣の `wrangler.jsonc` を読んでいなかった。
  一度は `Routes 0` / `No public route is declared` と表示し（隣の設定は
  route 2・var 16 を宣言していた）、それを手で書き直したあとも**手で
  同期し続けるしかない**形のままだった。ここでは route 表と env を渡す側が
  持ち、ページは描くだけなので、両者がずれる余地が無い。"
  (:require [jp-go-dds.core :as dds]
            [jp-go-dds.page :as page]
            [jp-go-dds.tokens :as tokens]
            [clojure.string :as str]))

(def app-css
  "app 固有の最小 CSS。`--hig-*` 契約だけを使う(bridge が DADS の上に再定義する)。
  DADS を base にした app の下には `shitsuke.hig` が居ないので、bridge が運んで
  いないトークンは何にも解決しない —— 使うのは運ばれているものの中だけ。"
  (str/join
   "\n"
   [".cw-lede { color: var(--hig-color-secondary-label); max-width: 42rem; }"
    ".cw-note { color: var(--hig-color-secondary-label); font-size: var(--hig-text-footnote-font-size); }"
    ".cw-mono { font-family: var(--hig-font-mono); overflow-wrap: anywhere; }"]))

(defn- route-rows [routes]
  (mapv (fn [r]
          [(str/upper-case (name (:route/method r)))
           [:span {:class "cw-mono"} (:route/path r)]
           (:route/doc r)])
        routes))

(defn- dropped-rows [{:keys [nsid-prefix tools]}]
  (mapv (fn [t] [[:span {:class "cw-mono"} (str nsid-prefix "." t)]]) tools))

(defn body
  "opts:
   :routes           cowork.route/routes（この Worker が実際に答えるもの）
   :vars             wrangler が渡した env のキー（値は出さない）
   :mcp-url          XRPC の中継先（route/mcp-router-url の戻り値）
   :not-carried-over cowork.route/not-carried-over（持ち越さなかった経路）
   :built-at         bundle のビルド時刻（不明なら nil）"
  [{:keys [routes vars mcp-url not-carried-over built-at]}]
  (dds/container
   (dds/section
    {}
    (dds/heading 1 "Cowork Graph Connector")
    [:p {:class "cw-lede"}
     "Claude Cowork 向けの MCP ブリッジの公開面。この Worker が実際にやるのは "
     "XRPC を MCP router へ中継することと、この説明ページを返すことの 2 つで、"
     "Microsoft Graph そのものへは触らない。"])

   (dds/section
    {:title "この面が答えるもの"}
    (dds/table {:caption (str "公開ルート " (count routes) " 件")
                :headers ["METHOD" "PATH" "何をするか"]
                :rows (route-rows routes)})
    [:p {:class "cw-note"}
     "この表も件数も Worker の route 表そのものから描いている。ページに焼いた"
     "値ではないので、実際に答えるものと表示がずれない。"])

   (dds/section
    {:title "実行時の設定"}
    (if (seq vars)
      [:div
       (into [:p] (interpose " " (map (fn [k] (dds/chip-label (name k))) vars)))
       [:p {:class "cw-note"}
        (str "キー名のみ " (count vars) " 件。値は出さない。")]]
      [:p {:class "cw-note"} "env が渡されていない（ローカル描画）。"])
    [:p {:class "cw-note"} "XRPC の中継先: "
     [:span {:class "cw-mono"} mcp-url]])

   (dds/section
    {:title "持ち越さなかった経路"}
    [:p {:class "cw-lede"}
     "移行前の " [:span {:class "cw-mono"} "src/app.ts"]
     " は Microsoft Graph の MCP tool を "
     (str (count (:tools not-carried-over)))
     " 個宣言していたが、どの bundle にも入っておらず deploy されていなかった。"
     "この移行はそれを持ち越していない。"]
    (dds/table {:caption (str "移していない tool " (count (:tools not-carried-over)) " 件")
                :headers ["NSID"]
                :rows (dropped-rows not-carried-over)})
    [:p {:class "cw-note"} "理由: " (:reason not-carried-over)])

   (dds/section
    {:title "現在地"}
    [:p {:class "cw-lede"}
     "この appview は TypeScript/Svelte から ClojureScript へ移行済み。"
     "deploy される bundle は、いま読んでいるソースからコンパイルされたもので"
     "ある（docs/adr/0001）。"]
    (when built-at
      [:p {:class "cw-note"} "bundle build: " built-at]))))

(defn render
  "完全な HTML 文書。`css` は呼び出し側が渡す(ライブラリは I/O を持たない)。"
  [{:keys [css] :as opts}]
  (page/->page
   {:title "Cowork Graph Connector"
    :description "Claude Cowork 向け MCP ブリッジの公開面。XRPC を MCP router へ中継する。"
    :lang "ja"
    :css css
    :app-css (str tokens/bridge-css "\n" app-css)}
   (body opts)))
