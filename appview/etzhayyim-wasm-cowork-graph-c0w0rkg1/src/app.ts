import {
  asAgentTool,
  createKyselyDb,
  createWorkerExport,
  withCapabilityTags,
  type HostSDK,
  nowISO,
  genID,
  nsid,
} from "@etzhayyim/kotodama-host-sdk";
// CHARTER-VIOLATION §substrate (centralized DB forbidden): migrate to AT MST + IPFS + Base L2 anchor

// ────────────────────────────────────────────────────────────────────────────
// etzhayyim-project-cowork-graph — Cowork Graph Connector (c0w0rkg1)
//
// MCP ブリッジ: Claude Cowork が Microsoft Graph API (Mail/Teams/Files/
// Calendar/Users) と RisingWave graph に接続するための capability worker。
//
// セキュリティ境界:
//   - Graph app-only token: KEK envelope encrypt → GRAPH_D1 (SS_GRAPH_TOKEN_KEK)
//   - Graph delegated (Teams 送信): 本 Worker 外で device code flow を実行
//   - RisingWave write: rwQuery() が DDL/DML を正規表現で全拒否 (read-only)
//   - メール送信: draft_only (etzhayyim_agent ルール準拠、実送信しない)
//   - MCP tool アクセス: PDS mcp-adapter の ToolGrant (CAN_USE) でゲート
//
// Secret 管理: macOS Keychain (etzhayyim.m365/CLIENT_SECRET) → CF Secrets Store
//   SS_GRAPH_CLIENT_SECRET : Graph API client_credentials secret
//   SS_GRAPH_TOKEN_KEK     : AES-256 KEK (KEK pool = gmail と共有)
//
// Write-Only Derived: handler は AT Repo 書き込みのみ。social/tool/通知は
//   kotodama.jsonld の derive rule で PDS commit pipeline が自動導出。
// ────────────────────────────────────────────────────────────────────────────

const ACTOR_DID = "did:web:cowork-graph.etzhayyim.com";
const NSID_NS   = "com.etzhayyim.apps.coworkGraph";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── 型定義 ───────────────────────────────────────────────────────────────────

interface SecretBinding { get?(): Promise<string>; text?(): Promise<string> }
interface D1Stmt {
  bind(...v: unknown[]): D1Stmt;
  run(): Promise<{ success: boolean }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}
interface D1Db { prepare(q: string): D1Stmt }

interface Env {
  HYPERDRIVE?: { connectionString: string };
  GRAPH_D1?: D1Db;
  SS_GRAPH_CLIENT_SECRET?: string | SecretBinding;
  SS_GRAPH_TOKEN_KEK?: string | SecretBinding;
  GRAPH_TENANT_ID?: string;
  GRAPH_CLIENT_ID?: string;
  GRAPH_SCOPE?: string;
  PDS_SERVICE?: Fetcher;
  KAGAMI_RPC?: { fetch(req: Request): Promise<Response> };
}

interface GraphTokenRow {
  token_enc: string;
  wrapped_key: string;
  iv: string;
  expires_at: number;
}

// ── シングルトン ─────────────────────────────────────────────────────────────

type RwDb = ReturnType<typeof createKyselyDb>;

let dbHandle: RwDb | null = null;
let tokenTableReady: Promise<void> | null = null;

// ── Secret 解決 ──────────────────────────────────────────────────────────────

async function resolveSecret(v: unknown): Promise<string> {
  if (!v) return "";
  if (typeof v === "string") return v;
  const s = v as SecretBinding;
  if (typeof s.get === "function") return (await s.get()) ?? "";
  if (typeof s.text === "function") return (await s.text()) ?? "";
  return String(v);
}

// ── KEK envelope 暗号化 (ADR-0010 Stage 1、gmail worker と同パターン) ─────────

function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

async function importKek(kekB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    b64uDecode(kekB64),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function kekEncrypt(
  kekB64: string,
  plaintext: string,
): Promise<{ ciphertext: string; wrappedKey: string; iv: string }> {
  const kek = await importKek(kekB64);
  const dataKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dataKeyCrypto = await crypto.subtle.importKey(
    "raw",
    dataKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    dataKeyCrypto,
    new TextEncoder().encode(plaintext),
  );
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, dataKey);
  return {
    ciphertext: b64uEncode(ct),
    wrappedKey: b64uEncode(wrapped),
    iv: b64uEncode(iv),
  };
}

async function kekDecrypt(
  kekB64: string,
  ciphertext: string,
  wrappedKey: string,
  ivB64: string,
): Promise<string> {
  const kek = await importKek(kekB64);
  const iv = b64uDecode(ivB64);
  const dataKeyBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    kek,
    b64uDecode(wrappedKey),
  );
  const dataKeyCrypto = await crypto.subtle.importKey(
    "raw",
    dataKeyBuf,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    dataKeyCrypto,
    b64uDecode(ciphertext),
  );
  return new TextDecoder().decode(pt);
}

// ── D1 トークンストア ─────────────────────────────────────────────────────────

async function ensureTokenTable(env: Env): Promise<void> {
  if (!env.GRAPH_D1) throw new Error("GRAPH_D1 binding missing");
  if (!tokenTableReady) {
    tokenTableReady = env.GRAPH_D1.prepare(`
      CREATE TABLE IF NOT EXISTS graph_app_tokens (
        id          INTEGER PRIMARY KEY,
        token_enc   TEXT NOT NULL,
        wrapped_key TEXT NOT NULL,
        iv          TEXT NOT NULL,
        expires_at  INTEGER NOT NULL
      )
    `).run().then(() => undefined);
  }
  await tokenTableReady;
}

// ── Graph API app-only トークン取得 ──────────────────────────────────────────

async function getAppOnlyToken(env: Env): Promise<string> {
  await ensureTokenTable(env);
  const kek        = await resolveSecret(env.SS_GRAPH_TOKEN_KEK);
  const tenantId   = env.GRAPH_TENANT_ID ?? "";
  const clientId   = env.GRAPH_CLIENT_ID ?? "";
  const clientSec  = await resolveSecret(env.SS_GRAPH_CLIENT_SECRET);
  const scope      = env.GRAPH_SCOPE ?? "https://graph.microsoft.com/.default";

  // キャッシュ確認 (5 分余裕を持って期限判定)
  const cached = await env.GRAPH_D1!
    .prepare("SELECT token_enc, wrapped_key, iv, expires_at FROM graph_app_tokens WHERE id=1")
    .first<GraphTokenRow>();

  if (cached && cached.expires_at > Date.now() + 5 * 60 * 1000) {
    return kekDecrypt(kek, cached.token_enc, cached.wrapped_key, cached.iv);
  }

  // 新規取得
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSec,
        scope,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph token fetch failed: ${res.status} ${err}`);
  }
  const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
  const enc = await kekEncrypt(kek, access_token);
  const expiresAt = Date.now() + expires_in * 1000;

  await env.GRAPH_D1!
    .prepare("INSERT OR REPLACE INTO graph_app_tokens(id,token_enc,wrapped_key,iv,expires_at) VALUES(1,?,?,?,?)")
    .bind(enc.ciphertext, enc.wrappedKey, enc.iv, expiresAt)
    .run();

  return access_token;
}

// ── Graph API ヘルパー ────────────────────────────────────────────────────────

async function graphGet<T>(env: Env, path: string): Promise<T> {
  const token = await getAppOnlyToken(env);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "ConsistencyLevel": "eventual" },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Graph GET ${path} → ${res.status}: ${err}`);
  }
  return res.json<T>();
}

async function graphPost<T>(env: Env, path: string, body: unknown): Promise<T> {
  const token = await getAppOnlyToken(env);
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Graph POST ${path} → ${res.status}: ${err}`);
  }
  return res.json<T>();
}

// ── RisingWave read-only クエリ ───────────────────────────────────────────────

const WRITE_SQL_RE = /^\s*(insert|update|delete|drop|create|alter|truncate|grant|revoke)/i;
const ALLOWED_TABLE_PREFIXES = ["graphar.", "vertex_", "edge_", "mv_", "dim_", "view_"];

async function rwQuery<T>(db: RwDb, sql: string, params: unknown[] = []): Promise<T[]> {
  if (WRITE_SQL_RE.test(sql)) {
    throw new Error("read-only: write SQL is forbidden from MCP tools");
  }
  const lsql = sql.toLowerCase();
  const allowed = ALLOWED_TABLE_PREFIXES.some((p) => lsql.includes(p));
  if (!allowed) {
    throw new Error(`table not in allowlist — use vertex_*, edge_*, mv_*, dim_*, view_* tables`);
  }
  const result = await (db as any).executeQuery({ sql, parameters: params });
  return (result.rows ?? []) as T[];
}

// ── KotodamaApp ──────────────────────────────────────────────────────────────

export default createWorkerExport((sdk: HostSDK) => {
  const env = sdk.env as unknown as Env;

  // DB は HYPERDRIVE が存在する場合のみ初期化 (ローカル dev は省略可)
  if (env.HYPERDRIVE && !dbHandle) {
    dbHandle = createKyselyDb(env.HYPERDRIVE);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Microsoft Graph: Mail tools
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.mailList`),
    async (_ctx, params: {
      userId: string;
      top?: number;
      filter?: string;
      orderby?: string;
    }) => {
      const { userId, top = 20, filter, orderby } = params;
      const qs = new URLSearchParams({
        $top: String(Math.min(top, 50)),
        $select: "id,subject,from,receivedDateTime,isRead,hasAttachments,importance",
      });
      if (filter)  qs.set("$filter", filter);
      if (orderby) qs.set("$orderby", orderby);
      return graphGet(env, `/users/${encodeURIComponent(userId)}/messages?${qs}`);
    },
    asAgentTool("指定ユーザーのメール一覧を取得する (最大 50 件)"),
    withCapabilityTags("msgraph", "mail", "read"),
  );

  sdk.app.query(
    nsid(`${NSID_NS}.mailGet`),
    async (_ctx, params: { userId: string; messageId: string }) => {
      const { userId, messageId } = params;
      return graphGet(
        env,
        `/users/${encodeURIComponent(userId)}/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,toRecipients,ccRecipients,body,receivedDateTime,isRead,hasAttachments`,
      );
    },
    asAgentTool("特定メールの本文を取得する"),
    withCapabilityTags("msgraph", "mail", "read"),
  );

  // メール送信は draft_only (etzhayyim_agent ルール準拠)
  sdk.app.command(
    nsid(`${NSID_NS}.mailDraft`),
    async (_ctx, params: {
      userId: string;
      to: string[];
      cc?: string[];
      subject: string;
      body: string;
      importance?: "low" | "normal" | "high";
    }) => {
      const { userId, to, cc = [], subject, body, importance = "normal" } = params;

      const draft = await graphPost<{ id: string; webLink: string }>(
        env,
        `/users/${encodeURIComponent(userId)}/messages`,
        {
          subject,
          importance,
          body: { contentType: "Text", content: body },
          toRecipients: to.map((a) => ({ emailAddress: { address: a } })),
          ccRecipients: cc.map((a) => ({ emailAddress: { address: a } })),
        },
      );

      // Hyperdrive direct write (ADR-0036 — domain collection)
      const mailDraftRkey = genID("mailDraft");
      await (dbHandle ?? createKyselyDb(env.HYPERDRIVE!))
        .insertInto("vertex_cowork_graph_mail_draft" as any)
        .values({
          vertex_id: `at://${ACTOR_DID}/com.etzhayyim.apps.coworkGraph.mailDraft/${mailDraftRkey}`,
          sensitivity_ord: 2,
          owner_did: ACTOR_DID,
          actor_id: "c0w0rkg1",
          draft_id: draft.id,
          user_id: userId,
          subject,
          to_addresses: JSON.stringify(to),
          cc_addresses: JSON.stringify(cc),
          importance,
          web_link: draft.webLink,
          created_at: nowISO(),
        })
        .execute();

      return {
        draftId: draft.id,
        webLink: draft.webLink,
        note: "draft_only — 送信には Outlook/別ツールでの承認が必要です",
      };
    },
    asAgentTool("メール下書きを作成する (draft_only — 自動送信しない)"),
    withCapabilityTags("msgraph", "mail", "draft"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  Microsoft Graph: Teams tools
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.teamsChannelList`),
    async (_ctx, params: { teamId: string }) => {
      return graphGet(
        env,
        `/teams/${encodeURIComponent(params.teamId)}/channels?$select=id,displayName,description,membershipType,isFavoriteByDefault`,
      );
    },
    asAgentTool("Teams チームのチャンネル一覧を取得する"),
    withCapabilityTags("msgraph", "teams", "read"),
  );

  sdk.app.query(
    nsid(`${NSID_NS}.teamsMessageList`),
    async (_ctx, params: {
      teamId: string;
      channelId: string;
      top?: number;
    }) => {
      const qs = new URLSearchParams({
        $top: String(Math.min(params.top ?? 20, 50)),
      });
      return graphGet(
        env,
        `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages?${qs}`,
      );
    },
    asAgentTool("Teams チャンネルのメッセージ一覧を取得する"),
    withCapabilityTags("msgraph", "teams", "read"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  Microsoft Graph: Files (OneDrive/SharePoint) tools
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.filesList`),
    async (_ctx, params: {
      userId?: string;
      driveId?: string;
      itemId?: string;
      top?: number;
    }) => {
      const { userId, driveId, itemId, top = 30 } = params;
      const qs = new URLSearchParams({
        $top: String(Math.min(top, 100)),
        $select: "id,name,size,lastModifiedDateTime,file,folder,webUrl,createdBy",
      });
      let path: string;
      if (driveId) {
        path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId ?? "root")}/children`;
      } else if (userId) {
        path = `/users/${encodeURIComponent(userId)}/drive/root/children`;
      } else {
        path = "/me/drive/root/children";
      }
      return graphGet(env, `${path}?${qs}`);
    },
    asAgentTool("OneDrive/SharePoint のファイル一覧を取得する"),
    withCapabilityTags("msgraph", "files", "read"),
  );

  sdk.app.query(
    nsid(`${NSID_NS}.filesGet`),
    async (_ctx, params: {
      driveId: string;
      itemId: string;
    }) => {
      return graphGet(
        env,
        `/drives/${encodeURIComponent(params.driveId)}/items/${encodeURIComponent(params.itemId)}?$select=id,name,size,file,folder,webUrl,downloadUrl,lastModifiedDateTime`,
      );
    },
    asAgentTool("OneDrive/SharePoint の特定ファイル情報を取得する"),
    withCapabilityTags("msgraph", "files", "read"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  Microsoft Graph: Calendar tools
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.calendarList`),
    async (_ctx, params: {
      userId: string;
      startDateTime: string;
      endDateTime: string;
      top?: number;
    }) => {
      const { userId, startDateTime, endDateTime, top = 50 } = params;
      const qs = new URLSearchParams({
        startDateTime,
        endDateTime,
        $top: String(Math.min(top, 100)),
        $select: "id,subject,start,end,location,attendees,isOnlineMeeting,onlineMeetingUrl,organizer,importance",
        $orderby: "start/dateTime asc",
      });
      return graphGet(env, `/users/${encodeURIComponent(userId)}/calendarView?${qs}`);
    },
    asAgentTool("指定期間のカレンダーイベントを取得する"),
    withCapabilityTags("msgraph", "calendar", "read"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  Microsoft Graph: Users tools
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.userGet`),
    async (_ctx, params: { userId: string }) => {
      return graphGet(
        env,
        `/users/${encodeURIComponent(params.userId)}?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,mobilePhone,preferredLanguage`,
      );
    },
    asAgentTool("Microsoft 365 ユーザーのプロフィールを取得する"),
    withCapabilityTags("msgraph", "users", "read"),
  );

  sdk.app.query(
    nsid(`${NSID_NS}.userList`),
    async (_ctx, params: { top?: number; filter?: string; search?: string }) => {
      const { top = 20, filter, search } = params;
      const qs = new URLSearchParams({
        $top: String(Math.min(top, 50)),
        $select: "id,displayName,mail,userPrincipalName,jobTitle,department",
      });
      if (filter) qs.set("$filter", filter);
      if (search) qs.set("$search", `"${search}"`);
      return graphGet(env, `/users?${qs}`);
    },
    asAgentTool("Microsoft 365 ユーザー一覧を検索・取得する"),
    withCapabilityTags("msgraph", "users", "read"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  RisingWave graph tools (read-only)
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.graphActorGet`),
    async (_ctx, params: { did: string }) => {
      if (!dbHandle) throw new Error("HYPERDRIVE binding not available");
      const rows = await rwQuery<Record<string, unknown>>(
        dbHandle,
        "SELECT * FROM vertex_app WHERE did = $1 LIMIT 1",
        [params.did],
      );
      return { actor: rows[0] ?? null };
    },
// CHARTER-VIOLATION §substrate (centralized DB forbidden): migrate to AT MST + IPFS + Base L2 anchor
    asAgentTool("DID で Actor の graph データを取得する"),
    withCapabilityTags("risingwave", "graph", "actor"),
  );

  sdk.app.query(
    nsid(`${NSID_NS}.graphQuery`),
    async (_ctx, params: {
      sql: string;
      params?: (string | number | boolean | null)[];
      limit?: number;
    }) => {
      if (!dbHandle) throw new Error("HYPERDRIVE binding not available");
      // LIMIT インジェクション防止: ユーザー SQL に LIMIT がなければ付加
      const limitedSql = /\blimit\b/i.test(params.sql)
        ? params.sql
        : `${params.sql.trimEnd().replace(/;$/, "")} LIMIT ${Math.min(params.limit ?? 100, 500)}`;
      const rows = await rwQuery<Record<string, unknown>>(
        dbHandle,
        limitedSql,
        params.params ?? [],
      );
      return { rows, count: rows.length };
// CHARTER-VIOLATION §substrate (centralized DB forbidden): migrate to AT MST + IPFS + Base L2 anchor
    },
    asAgentTool("RisingWave graph に対して read-only SQL を実行する (vertex_*/edge_*/mv_*/dim_*/view_* テーブルのみ)"),
    withCapabilityTags("risingwave", "graph", "query"),
  );

  sdk.app.query(
    nsid(`${NSID_NS}.graphMvQuery`),
    async (_ctx, params: {
      mv: string;
      filter?: string;
      orderby?: string;
      limit?: number;
    }) => {
      if (!dbHandle) throw new Error("HYPERDRIVE binding not available");
      const { mv, filter, orderby, limit = 100 } = params;
      // mv 名のサニタイズ: 英数字/アンダースコアのみ
      if (!/^[a-z0-9_]+$/i.test(mv)) throw new Error(`invalid mv name: ${mv}`);
      const whereClause  = filter  ? `WHERE ${filter}`   : "";
      const orderClause  = orderby ? `ORDER BY ${orderby}` : "";
      const limitClause  = `LIMIT ${Math.min(limit, 500)}`;
      const sql = `SELECT * FROM ${mv} ${whereClause} ${orderClause} ${limitClause}`.trim();
      const rows = await rwQuery<Record<string, unknown>>(dbHandle, sql, []);
// CHARTER-VIOLATION §substrate (centralized DB forbidden): migrate to AT MST + IPFS + Base L2 anchor
      return { mv, rows, count: rows.length };
    },
    asAgentTool("RisingWave マテリアライズドビューをクエリする"),
    withCapabilityTags("risingwave", "graph", "mv"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  Teams: メッセージ送信 (sendTeamsMessage)
  //  app-only token で Graph API POST /teams/{teamId}/channels/{channelId}/messages
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.command(
    nsid(`${NSID_NS}.sendTeamsMessage`),
    async (_ctx, params: {
      teamId: string;
      channelId: string;
      subject?: string;
      body: string;
      contentType?: "html" | "text";
    }) => {
      const { teamId, channelId, subject, body, contentType = "html" } = params;
      const payload: Record<string, unknown> = {
        body: { contentType, content: body },
      };
      if (subject) payload.subject = subject;
      const result = await graphPost<{ id: string; webUrl: string }>(
        env,
        `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        payload,
      );

      // Hyperdrive direct write (ADR-0036 — domain collection, fire-and-forget)
      const syncJobRkey1 = genID("syncJob");
      (dbHandle ?? createKyselyDb(env.HYPERDRIVE!))
        .insertInto("vertex_cowork_graph_sync_job" as any)
        .values({
          vertex_id: `at://${ACTOR_DID}/com.etzhayyim.apps.coworkGraph.syncJob/${syncJobRkey1}`,
          sensitivity_ord: 2,
          owner_did: ACTOR_DID,
          actor_id: "c0w0rkg1",
          job_type: "teams_message_sent",
          status: "done",
          actor_did: ACTOR_DID,
          message_id: result.id,
          team_id: teamId,
          channel_id: channelId,
          done_at: nowISO(),
        })
        .execute()
        .catch((e: unknown) => console.error("[cowork-graph] syncJob record failed:", e));

      return { messageId: result.id, webUrl: result.webUrl, status: "sent" };
    },
    asAgentTool("Teams チャンネルにメッセージを投稿する (HTML/text)"),
    withCapabilityTags("msgraph", "teams", "send"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  vertex_form_task 照会: listMyFormTasks
  //  kaisya の vertex_form_task から pending タスクを読む (RisingWave read-only)
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.query(
    nsid(`${NSID_NS}.listMyFormTasks`),
    async (_ctx, params: {
      assigneeDid?: string;
      projectRef?: string;
      status?: string;
      limit?: number;
    }) => {
      if (!dbHandle) throw new Error("HYPERDRIVE binding not available");
      const { assigneeDid, projectRef, status = "pending", limit = 50 } = params;

      const conditions: string[] = [
        `status = '${status.replace(/'/g, "''")}'`,
        `task_type LIKE 'bpmn%'`,
      ];
      if (assigneeDid) conditions.push(`owner_did = '${assigneeDid.replace(/'/g, "''")}'`);
      if (projectRef)  conditions.push(`related_project = '${projectRef.replace(/'/g, "''")}'`);

      const sql = `
        SELECT vertex_id, task_code, title, task_type, assignee_role, owner_did,
               related_project, priority, deadline, status, created_at
        FROM vertex_human_task
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ${Math.min(limit, 200)}
      `;
// CHARTER-VIOLATION §substrate (centralized DB forbidden): migrate to AT MST + IPFS + Base L2 anchor
      const rows = await rwQuery<Record<string, unknown>>(dbHandle, sql, []);
      return { tasks: rows, count: rows.length };
    },
    asAgentTool("自分 (assignee_did) に割り当てられた BPMN フォームタスクを取得する"),
    withCapabilityTags("risingwave", "graph", "form-task"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  BPMN オンボーディング案内送信: sendBpmnGuidance
  //  GJ/CE/General に全メンバー向け BPMN 業務フロー案内を投稿する
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.command(
    nsid(`${NSID_NS}.sendBpmnGuidance`),
    async (_ctx, params: {
      teamId: string;
      channelId: string;
      processInstanceId?: string;
      projectName?: string;
    }) => {
      const { teamId, channelId, processInstanceId = genID(), projectName = "新規案件" } = params;

      const KAISYA_URL = "https://kaisya.etzhayyim.com";
      const COWORK_URL = "https://cowork.etzhayyim.com";

      const memberGuide: Array<{ handle: string; role: string; tasks: string; formPath: string; step: string }> = [
        {
          handle: "j.kawasaki",
          role: "CEO",
          step: "A → L",
          tasks: "戦略方針確認 (Step A) → 最終承認 (Step L)",
          formPath: "/forms/project-intake → /forms/final-approval",
        },
        {
          handle: "a.nakamura",
          role: "COO",
          step: "B → D → K",
          tasks: "案件受付 (Step B) → DMN案件ルーティング (Step D) → 納品確認 (Step K)",
          formPath: "/forms/project-intake → /forms/delivery-confirm",
        },
        {
          handle: "k.bakshi",
          role: "CLO",
          step: "C → J",
          tasks: "契約締結 (Step C) → 法務最終確認 (Step J)",
          formPath: "/forms/contract-review",
        },
        {
          handle: "n.takahashi",
          role: "Cybersecurity事業部責任者",
          step: "E",
          tasks: "Cybersecurity評価 (Step E) — 並列実行",
          formPath: "/forms/security-assessment",
        },
        {
          handle: "t.chikada",
          role: "CS部",
          step: "H",
          tasks: "技術要件定義 (Step H) — 並列実行",
          formPath: "/forms/security-assessment",
        },
        {
          handle: "t.ichihara",
          role: "Branding事業部責任者",
          step: "F",
          tasks: "ブランド戦略策定 (Step F) — 並列実行",
          formPath: "/forms/creative-brief",
        },
        {
          handle: "k.takahashi",
          role: "クリエイティブディレクター",
          step: "G",
          tasks: "クリエイティブディレクション (Step G) — F完了後",
          formPath: "/forms/creative-brief",
        },
        {
          handle: "f.tanaka / y.nishino",
          role: "エンジニア",
          step: "I",
          tasks: "開発実装 (Step I) — H完了後",
          formPath: "/forms/delivery-confirm",
        },
      ];

      const memberRows = memberGuide
        .map(
          (m) =>
            `<tr>
              <td><b>${m.handle}</b></td>
              <td>${m.role}</td>
              <td>Step ${m.step}</td>
              <td>${m.tasks}</td>
              <td><a href="${KAISYA_URL}${m.formPath}">${m.formPath.split("/").pop()}</a></td>
            </tr>`,
        )
        .join("\n");

      const html = `
<h2>🤖 etzhayyim 業務フロー — BPMN 開始案内</h2>
<p><b>案件:</b> ${projectName} &nbsp;|&nbsp; <b>プロセスID:</b> <code>${processInstanceId}</code></p>
<p>
  契約メンバーの皆さんへ。以下の BPMN 業務フローが開始されました。<br>
  <b>担当フォームを開いて送信するだけで、次のタスクが自動的に割り当てられます。</b><br>
  Claude Cowork (<a href="${COWORK_URL}">${COWORK_URL}</a>) でチャットしながらフォームを進めることもできます。
</p>

<h3>📋 逆トポロジーソート — 担当タスク一覧</h3>
<table border="1" cellpadding="6" cellspacing="0">
  <thead>
    <tr>
      <th>担当者</th><th>役職</th><th>ステップ</th><th>タスク内容</th><th>フォーム</th>
    </tr>
  </thead>
  <tbody>
${memberRows}
  </tbody>
</table>

<h3>🔄 フロー順序 (逆トポロジーソート)</h3>
<pre>
[START]
  → A: CEO 戦略方針 (j.kawasaki) ← project-intake
  → B: COO 案件受付 (a.nakamura) ← project-intake
  → C: CLO 契約締結 (k.bakshi)   ← contract-review
  → D: DMN 案件ルーティング [自動判定]
     ↓ 並列実行 ↓
     E: Cyber評価 (n.takahashi)   ← security-assessment
     F: ブランド戦略 (t.ichihara) ← creative-brief
     H: 技術要件 (t.chikada)      ← security-assessment
        → G: Creative (k.takahashi) ← creative-brief
        → I: 開発 (f.tanaka/y.nishino) ← delivery-confirm
     ↓ JOIN ↓
  → J: CLO 法務最終確認 (k.bakshi) ← contract-review
  → K: COO 納品確認 (a.nakamura)   ← delivery-confirm
  → L: CEO 最終承認 (j.kawasaki)   ← final-approval
[完了 → Teams 通知]
</pre>

<h3>🤖 Claude Cowork の使い方</h3>
<ol>
  <li><a href="${COWORK_URL}">${COWORK_URL}</a> にアクセス</li>
  <li>「自分のタスクを確認して」と話しかける</li>
  <li>Cowork が <code>listMyFormTasks</code> でタスクを取得し、フォームURLを案内</li>
  <li>フォームを開いて入力 → 送信 → 次のタスクが自動でアサイン</li>
  <li>不明点は Cowork チャットで「Step Eの評価をどう書けば？」等と質問</li>
</ol>

<h3>📌 法務案件 (LingLing 等) は別フロー</h3>
<p>
  法務案件は <a href="${KAISYA_URL}/legal">/legal</a> → <code>legal-case.form.json</code> を使用。<br>
  CLO k.bakshi が <code>com.etzhayyim.apps.kaisya.updateCaseStatus</code> で進捗を更新。<br>
  <b>ZeLo 7問対応:</b> Teams <code>GJ/CE/Legal/2504-LingLing</code> チャンネルで進捗共有。
</p>

<hr>
<p><i>このメッセージは kaisya-etzhayyim-bot (総合 artificial organism) が自動送信しました。<br>
プロセスID: <code>${processInstanceId}</code> — kaisya.etzhayyim.com で進捗確認できます。</i></p>
      `.trim();

      const result = await graphPost<{ id: string; webUrl: string }>(
        env,
        `/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          subject: `🤖 etzhayyim BPMN 業務フロー開始: ${projectName}`,
          body: { contentType: "html", content: html },
        },
      );

      // Hyperdrive direct write (ADR-0036 — domain collection, fire-and-forget)
      const syncJobRkey2 = genID("syncJob");
      (dbHandle ?? createKyselyDb(env.HYPERDRIVE!))
        .insertInto("vertex_cowork_graph_sync_job" as any)
        .values({
          vertex_id: `at://${ACTOR_DID}/com.etzhayyim.apps.coworkGraph.syncJob/${syncJobRkey2}`,
          sensitivity_ord: 2,
          owner_did: ACTOR_DID,
          actor_id: "c0w0rkg1",
          job_type: "bpmn_guidance_sent",
          status: "done",
          actor_did: ACTOR_DID,
          process_instance_id: processInstanceId,
          project_name: projectName,
          message_id: result.id,
          done_at: nowISO(),
        })
        .execute()
        .catch((e: unknown) => console.error("[cowork-graph] syncJob record failed:", e));

      return {
        messageId: result.id,
        webUrl: result.webUrl,
        processInstanceId,
        status: "guidance_sent",
        note: "BPMN 案内を GJ/CE/General に投稿しました",
      };
    },
    asAgentTool("etzhayyim BPMN 業務フロー案内を Teams GJ/CE/General に投稿する (kaisya-etzhayyim-bot)"),
    withCapabilityTags("msgraph", "teams", "bpmn", "guidance"),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  onCommit: coworkGraph collections への react
  // ══════════════════════════════════════════════════════════════════════════

  sdk.app.onCommit?.(async (commit) => {
    // 現在は react 不要 (将来: mailDraft → 承認通知フロー)
    void commit;
  });
});
