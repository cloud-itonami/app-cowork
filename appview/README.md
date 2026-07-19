# etzhayyim-project-cowork App migration

このディレクトリは `legacy-runtime` 実装を残したまま、App 版を段階移行するための配置先です。

## 対象 App services

- `cowork-v1gy375u`

## App 実装方針

- 各 service は `projects/*/wasm/*-component` として順次実装。
- 既存 App runtime は互換運用のため維持。
- HTTP/cron/job エンドポイントから優先して移植。

## 実装済みコンポーネント

- `cowork-ui-72p8lz7d` (統合 Kotodama app)
  - UI fileserver と MCP API を 1 つの Kotodama app で提供
  - MCP 実装は `cowork-ui-72p8lz7d/components/cowork-mcp-component` に内包
  - API ルートは `/api/...` と `/{id}/api/...` を MCP コンポーネントへルーティング
