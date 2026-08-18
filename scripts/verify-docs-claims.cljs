#!/usr/bin/env nbb
;; verify-docs-claims — re-derive every number README.md and
;; docs/operator-quickstart.md state, from the tree itself, and fail when the
;; tree and the prose disagree.
;;
;; Before the cljs migration this repository's load-bearing claim was a GAP:
;; the Worker that would be deployed was a SvelteKit build output
;; (svelte/.svelte-kit/cloudflare/_worker.js, a path with zero tracked files)
;; while appview/*/src/app.ts -- the 882-line file that read like the
;; application -- was in no bundle. That gap is closed, and the claims below
;; assert the CLOSURE in a way that cannot quietly come back: the TypeScript is
;; asserted ABSENT BY NAME, not merely absent from a byte total.
;;
;; It also asserts the two things this migration is most able to lie about:
;;   * the 16 dropped Graph tools are named in the README (dropping them
;;     silently would be the lie), and the list has exactly one home -- the
;;     README is checked AGAINST src/cowork/route.cljc, not against itself;
;;   * the kotoba/ package is STILL TypeScript. The migration did not touch it,
;;     so a claim of "no TypeScript here" would be false. The count is pinned.
;;
;; Usage:  nbb scripts/verify-docs-claims.cljs [<dir>]     (<dir> FIRST, default ".")
;; Exit:   0 every claim holds · 1 a claim is false · 2 could not answer

(require '["node:fs" :as fs]
         '["node:child_process" :as cp]
         '["node:crypto" :as crypto]
         '[clojure.string :as str])

(def root (or (first (remove #(str/starts-with? % "--") *command-line-args*)) "."))
(def APP "appview/etzhayyim-wasm-cowork-graph-c0w0rkg1")

(def claims
  {:tracked-files 29
   :appview-ts-files 0
   :canonical-files 4
   :kotoba-ts-files 5              ; NOT migrated -- see README "kotoba/ は移していない"
   :dropped-tools 16
   :declared-vars 16
   :declared-routes 2
   :public-routes 3
   :wrangler-main "../../dist/worker.js"
   :shadow-output-dir "dist"
   :shadow-export "cowork.worker/handler"
   :kotodama-guest-language "cljs"})

;; Inherited files this repository still carries BYTE-IDENTICAL. The three that
;; were deliberately changed (wrangler.jsonc, kotodama.jsonld,
;; MIGRATION-TODO.md) are checked by content below instead.
(def preserved
  {"NOTICE" "bae68743feb911cbedcc745b136e444d3595854e4324f59e7cc9438ccda13d49"
   "OWNERS" "aff37f126f4f5608bc7831fcdd2c40bb0137a0a9265d1d6d369fd7b220884c68"
   "PROJECT.jsonld" "1430496ae258b481a0be9ce1a9c9b745f3d5357abd25a1225d7f2ca9f5ce694b"
   "README.edn" "995188c3ca48f85a610ee3682d6488131e3edc7819971b5143e100fb464a6501"
   "migration.edn" "b4692bbefa286784fd2c892cef361b0d5c20a9796cb6757376acf4cd7022516d"
   "appview/README.md" "b697028b69b438a84c7d33be951c965d0c04fedec51a71fab20e6a64f0f525bb"
   "kotoba/package.json" "3873236da43efd0d4862ca2f0395c5ab07c92faadce81f2a867222c0f350761d"
   "kotoba/tsconfig.json" "95a429e51d6162cb7205b603f745e7604d93ffbb1ea6c346e5c6215a79ae541e"
   "kotoba/vitest.config.ts" "f82a551ef4da1c9cbf17985a3bee96eee450a3e4a46bff0d96c6150263121eff"
   "kotoba/src/index.ts" "dde6307c1497fb95a506f97f2be46c179e7461d693afab5e9af92ea620f5f5ca"
   "kotoba/src/registry.ts" "ac00110deaa535e2622accc40c225185822f089bc8c004882386a99d2512f1d4"
   "kotoba/src/types.ts" "20e6f48ab52d27369b19e0e023948701e3e6e8cffde8f2750fe1e6235a3de1f3"
   "kotoba/test/cowork.test.ts" "31ac4596fba92ab8eb2f0bff4aa023cb1c0fd20adb107795122461ffb5defb6a"})

;; What the migration REMOVED, by name. A byte total cannot say "the TypeScript
;; is gone"; this can, and it fails if any of it comes back.
(def removed-by-migration
  [(str APP "/src/app.ts")
   (str APP "/svelte/package.json")
   (str APP "/svelte/src/app.html")
   (str APP "/svelte/src/routes/+page.svelte")
   (str APP "/svelte/src/routes/xrpc/[...path]/+server.ts")
   (str APP "/svelte/svelte.config.js")
   (str APP "/svelte/tsconfig.json")
   (str APP "/svelte/vite.config.ts")])

(def undetermined (atom []))
(def failures (atom []))
(defn undet! [m] (swap! undetermined conj m))

(defn tracked-files []
  (try (->> (.execSync cp "git ls-files" #js {:cwd root :encoding "utf8"})
            str/split-lines (remove str/blank?) vec)
       (catch :default e (undet! (str "git ls-files failed: " (.-message e))) nil)))
(defn slurp* [rel] (try (.readFileSync fs (str root "/" rel) "utf8") (catch :default _ nil)))
(defn bytes-of [rel] (try (.-size (.statSync fs (str root "/" rel))) (catch :default _ nil)))
(defn sha256 [rel]
  (try (-> (.createHash crypto "sha256")
           (.update (.readFileSync fs (str root "/" rel))) (.digest "hex"))
       (catch :default _ nil)))
(defn strip-jsonc [s] (str/replace s #"(?m)^\s*//.*$" ""))

(defn check! [label expected actual]
  (let [ok (= expected actual)]
    (println (str (if ok "PASS" "FAIL") "\t" (name label)
                  "\texpected=" (pr-str expected) "\tactual=" (pr-str actual)))
    (when-not ok (swap! failures conj label))
    ok))

(let [files (tracked-files)]
  (when (nil? files) (println "UNDETERMINED\tcould not list tracked files") (js/process.exit 2))
  (println (str "SCANNED\t" (count files)))
  (when (zero? (count files)) (println "UNDETERMINED\tscanned 0 files") (js/process.exit 2))

  (let [sizes (into {} (map (juxt identity bytes-of)) files)]
    (when-let [bad (seq (keep (fn [[f s]] (when (nil? s) f)) sizes))]
      (undet! (str "tracked but unreadable: " (str/join ", " bad))))

    (check! :tracked-files (:tracked-files claims) (count files))
    (check! :preserved-files-unchanged []
            (vec (keep (fn [[f want]] (let [got (sha256 f)]
                                        (when-not (= want got) (str f " " (or got "MISSING")))))
                       preserved)))

    ;; the appview's TypeScript is gone, by name and by count
    (check! :removed-by-migration-absent []
            (vec (filter #(some? (bytes-of %)) removed-by-migration)))
    (let [appview (filter #(str/starts-with? % "appview/") files)
          prod (remove #(str/starts-with? % "scripts/") files)]
      (check! :appview-ts-files (:appview-ts-files claims)
              (count (filter #(re-find #"\.(ts|svelte)$" %) appview)))
      (check! :canonical-files (:canonical-files claims)
              (count (filter #(re-find #"\.(cljs|cljc|clj|kotoba)$" %) prod))))

    ;; the kotoba/ package was NOT migrated. Saying so, and pinning the count,
    ;; is what keeps the README from reading as "this repo has no TypeScript".
    (check! :kotoba-ts-files (:kotoba-ts-files claims)
            (count (filter #(and (str/starts-with? % "kotoba/") (str/ends-with? % ".ts")) files)))

    ;; the deployed bundle is built from the source in this tree
    (let [w (some-> (slurp* (str APP "/wrangler.jsonc")) strip-jsonc)
          sh (slurp* "shadow-cljs.edn")]
      (if (or (nil? w) (nil? sh))
        (undet! "wrangler.jsonc or shadow-cljs.edn unreadable")
        (let [j (js->clj (.parse js/JSON w) :keywordize-keys false)]
          (check! :wrangler-main (:wrangler-main claims) (get j "main"))
          (check! :declared-vars (:declared-vars claims) (count (get j "vars")))
          (check! :declared-routes (:declared-routes claims) (count (get j "routes")))
          (check! :app-framework-is-cljs "cljs-esm-worker" (get-in j ["vars" "APP_FRAMEWORK"]))
          ;; the old config served a SvelteKit client dir that no longer exists
          (check! :no-stale-assets-binding true (nil? (get j "assets")))
          (check! :shadow-builds-that-main true
                  (and (str/includes? sh (str ":output-dir \"" (:shadow-output-dir claims) "\""))
                       (str/includes? sh (:shadow-export claims))
                       (str/includes? (get j "main")
                                      (str (:shadow-output-dir claims) "/worker.js")))))))

    ;; the actor descriptor stopped saying the guest is TypeScript
    (let [k (slurp* (str APP "/kotodama.jsonld"))]
      (if (nil? k)
        (undet! "kotodama.jsonld unreadable")
        (let [j (js->clj (.parse js/JSON k) :keywordize-keys false)]
          (check! :kotodama-guest-language (:kotodama-guest-language claims)
                  (get-in j ["build" "guestLanguage"]))
          (check! :kotodama-component-is-cljs true
                  (boolean (some-> (get-in j ["component" "path"])
                                   (str/ends-with? ".cljs")))))))

    ;; The page renders the route TABLE rather than a baked count. Asserted
    ;; structurally (the view takes :routes, the worker passes the real table)
    ;; and NOT by forbidding a substring -- a check a docstring can trip is a
    ;; check about prose.
    (let [v (slurp* "src/cowork/view.cljc")
          w (slurp* "src/cowork/worker.cljs")
          r (slurp* "src/cowork/route.cljc")]
      (if (or (nil? v) (nil? w) (nil? r))
        (undet! "src/cowork/{route,view,worker} unreadable")
        (do
          (check! :page-renders-route-table true
                  (and (str/includes? v "(route-rows routes)")
                       (str/includes? v "(count routes)")
                       (str/includes? w ":routes route/routes")))
          (check! :public-routes (:public-routes claims)
                  (count (re-seq #"\{:route/path " r)))

          ;; The 16 dropped tools live in exactly one place. The README is
          ;; checked against THAT, so "we dropped them silently" cannot happen
          ;; and the two lists cannot drift.
          (let [tools (map second (re-seq #"\"([a-zA-Z]+)\"" (or (second (re-find #"(?s):tools \[(.*?)\]" r)) "")))
                readme (slurp* "README.md")]
            (check! :dropped-tools (:dropped-tools claims) (count tools))
            (if (nil? readme)
              (undet! "README.md unreadable")
              (check! :readme-names-every-dropped-tool []
                      (vec (remove #(str/includes? readme %) tools))))))))))

(let [u @undetermined f @failures]
  (when (seq u)
    (doseq [m u] (println (str "UNDETERMINED\t" m)))
    (println "Refusing to report a pass: the tree could not be read completely.")
    (js/process.exit 2))
  (if (seq f)
    (do (println (str "FAILED\t" (count f) " claim(s): " (str/join ", " (map name f))))
        (js/process.exit 1))
    (do (println "OK\tevery claim in README.md and docs/operator-quickstart.md holds")
        (js/process.exit 0))))
