# Operator quickstart — app-cowork

This repository looks like a wired Microsoft 365 integration and **deploys a generic
proxy**. That gap is the first thing to understand, because everything about the
repository's apparent capability lives in a file `wrangler.jsonc` does not deploy and
could not run if it did.

Steps marked ✅ were run on 2026-08-16. §5 says what was not walked.

---

## 1. ✅ What is declared, and where the code for it lives

`appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/wrangler.jsonc` declares six
capabilities:

```bash
python3 -c "import json,io;print(json.loads(json.load(io.open('appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/wrangler.jsonc'))['vars']['APP_CAPABILITIES']))"
#   ['msgraph-mail', 'msgraph-teams', 'msgraph-files', 'msgraph-calendar',
#    'msgraph-users', 'risingwave-graph-read']
```

Mail, Teams, files, calendar and directory users — a real tenant's data — plus a graph
read. The code that implements them is `src/app.ts`, and the code that gets deployed is
not:

```bash
grep '"main"' appview/*/wrangler.jsonc
#   "main": "svelte/.svelte-kit/cloudflare/_worker.js"

wc -l appview/*/src/app.ts appview/*/svelte/src/routes/xrpc/'[...path]'/+server.ts
#   882 src/app.ts                     <- NOT deployed
#    80 xrpc/[...path]/+server.ts      <- deployed

grep -c 'graph.microsoft\|msgraph' appview/*/src/app.ts                      # 14
grep -c 'graph.microsoft\|msgraph' appview/*/svelte/src/routes/xrpc/*/+server.ts   # 0
```

The 882-line facade holds `GRAPH_BASE = "https://graph.microsoft.com/v1.0"`, an OAuth
client-credentials exchange against `login.microsoftonline.com`, a D1 statement
interface, and a header documenting its secret handling:

> Secret 管理: macOS Keychain (etzhayyim.m365/CLIENT_SECRET) → CF Secrets Store
>   SS_GRAPH_CLIENT_SECRET : Graph API client_credentials secret
>   SS_GRAPH_TOKEN_KEK     : AES-256 KEK (KEK pool = gmail と共有)

The 80-line deployed handler has no Graph reference at all. It exports `POST` and
`OPTIONS`, forwards whatever NSID is in the path to `AGENTGATEWAY_MCP_ROUTER_URL` as a
JSON-RPC `tools/call`, and returns `result.structuredContent`. It is the same generic
BFF proxy the other migrated appviews deploy.

## 2. ✅ The facade is not merely undeployed — it is undeployable as configured

Every binding it reads is undeclared:

```bash
grep -oE 'env\.[A-Z_]{4,}|SS_GRAPH_[A-Z_]+' appview/*/src/app.ts | sort -u
#   env.GRAPH_CLIENT_ID  env.GRAPH_D…  env.GRAPH_SCOPE  env.GRAPH_TENANT_ID
#   env.HYPERDRIVE  env.SS_GRAPH_CLIENT_SECRET  env.SS_GRAPH_TOKEN_KEK

python3 -c "import json,io;print(sorted(json.load(io.open('appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/wrangler.jsonc'))))"
#   ['assets','compatibility_date','compatibility_flags','main','name','routes','rules','vars']
```

No `secrets_store_secrets`, no `d1_databases`, no `hyperdrive`, no `kv_namespaces`. The
`vars` block is sixteen `APP_*` metadata entries plus the MCP router URL and
`INTERFACES_REQUIRES`. So even if `main` pointed at `src/app.ts`, the client secret,
the KEK, the tenant id and the database would all be absent at runtime.

Read the other way round, this is reassuring: **no credential is reachable from the
deployed worker, and none is committed.** Verified — no 64-hex string, no `eyJ…` token,
and the one `client_secret` occurrence in the tree is the variable reference at
`src/app.ts:211`, not a value.

## 3. ✅ What was deployed on 7 May cannot be identified from here

```bash
python3 -c "import json,io;v=json.load(io.open('appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/wrangler.jsonc'))['vars'];print(v['APP_DEPLOY_AT'],v['APP_DEPLOY_SHA'])"
#   2026-05-07T02:00:37Z 06194f69d5d

git cat-file -t 06194f69d5d                                   # Not a valid object name
git -C <root>/orgs/etzhayyim/root cat-file -t 06194f69d5d      # Not a valid object name
```

The config records a deployment and the sha it came from, and that sha resolves neither
here nor in the monorepo this repository was extracted from. So the deployment is dated
but not reproducible: nothing in this workspace can say which code was running.

## 4. ✅ The landing page said it had no routes and no vars — fixed here

`appview/*/svelte/src/routes/+page.svelte` embeds a summary object and renders it. It
said `routeCount: 0, routes: [], vars: []`, with a `relativePath` pointing into the
monorepo — so the page printed `Routes 0` and, in full:

> No public route is declared next to this app surface.
> No public vars are declared in the nearest wrangler config.

Both name the wrangler config; both were false. It declares two routes — one of them
the address serving the page — and sixteen vars.

Verified by rendering, not by grepping the bundle:

```bash
cd appview/etzhayyim-wasm-cowork-graph-c0w0rkg1/svelte
npm install --no-audit --no-fund && npm run build
npx vite preview --port 4396 & curl -s http://localhost:4396/ > page.html
grep -c 'No public route is declared\|No public vars are declared' page.html
grep -oE 'Routes</span>.{0,45}' page.html
```

| in the rendered HTML | before | after |
|---|---|---|
| false sentences | 1 | **0** |
| names its own address | no | **yes** |
| the `Routes` figure | `<strong …>0</strong>` | `<strong …>2</strong>` |

A bundle grep could not have shown this: Svelte compiles both branches of an `{#if}`
into the component, so the false sentences remain in the build even when they cannot
render. Only the sixteen var **names** are listed — the page prints keys, never values,
and none of the secret names from §2 appears among them.

There is no generator for this object in this repository or in the root's `scripts/`,
so it is hand-maintained: change routes or vars in `wrangler.jsonc` and it will not
follow. `scripts/verify-appview-page-summary.cljs` in the superproject enumerates the
repositories still carrying the stale version.

## 5. ⚠ NOT WALKED: the kotoba test suite

`kotoba/` holds 10 tests in 152 lines against a 379-line registry — the most valuable
unrun check here. It does not install on this machine:

```bash
cd kotoba && npm install
#   npm error code EALLOWSCRIPTS
#   npm error --allow-scripts is not allowed in project-scoped installs.
```

Both dependencies are git URLs whose preparation runs a nested install that npm 11.16
refuses; an `allowScripts` field does not help, because the rejection happens inside
the nested install. Nothing here claims the suite passes. The appview's `svelte/`
installs and builds cleanly (§4) because it has no git dependencies.

## 6. ⚠ Governance: an unremediated seed with a two-line OWNERS

`MIGRATION-TODO.md` says `Status: 🔄 TRANSFORM — seed copied 2026-05-21, codemod
pending`, with seven boxes and none ticked. Its own closing paragraph qualifies them —
the classification came from the app's domain pattern, not from detected violations,
and manual review is still required — so they are a checklist, not seven confirmed
defects. What is certain is that the review has not happened.

`OWNERS` names `etzhayyim` as both approver and reviewer. For an app declaring mail,
calendar and directory scopes over a real tenant, one name in both roles is worth
knowing before a change is proposed here.

## 7. What the maturity instrument sees ✅

```
· orgs/cloud-itonami/app-cowork  own=0.049  axis-docs=0bp → +2500bp
    ⚠ README が .md ではないので docs の README 成分は 0（README.edn 等が 1 件）
    ⚠ taxonomy に :repo/kind の行が無い → :default の重みで採点されている
```

Both are about the instrument. `README.edn` declares `:canonical-metadata :edn`, so EDN
is deliberately canonical while the score reads `README.md`; and with no row in
`manifest/repo-taxonomy.edn` this `own` is computed against a guessed weight profile and
is not comparable to a repository whose kind is known (ADR-2608052000).

`axis-substrate` also reads 0, and that one is the instrument's fault rather than the
repository's: the 882-line facade and the 379-line registry sit under `appview/` and
`kotoba/`, and the counter looks only at a top-level `src/`.
