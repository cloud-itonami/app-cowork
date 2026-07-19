/**
 * cowork kotoba — kotoba product-front for the Etzhayyim Cowork M365 collaboration
 * graph. Maximal migration of the Microsoft 365 collaboration data layer
 * (directory / mail / Teams / calendar / files / BPMN tasks) off etzhayyim onto the
 * etzhayyim substrate.
 *
 * Per ADR-2606011400 (Consensys product-front / infra-back) + ADR-2605172400
 * (3-axis Liability/Custody/Settlement) + ADR-2605181100 (kotoba E2E
 * encrypted-record envelope). Founder directive 2026-06-03: front everything
 * that can move; PII / private content migrate when E2E-safe.
 *
 * SPLIT:
 *   PLAINTEXT (public AT records, sdk.write/read) — org-structure catalog with
 *   no per-person PII: Teams channel directory (id / displayName / description /
 *   membershipType, FK anchor = teamId). Frontable open org metadata.
 *
 *   E2E (kotoba, com.etzhayyim.encrypted.record, sdk.encryptedWrite/Read,
 *   read-cap = owner DID + explicit recipients) — every per-person / private-
 *   content / message-metadata domain:
 *     directoryMember  M365 user PII (displayName / mail / jobTitle / dept).
 *     mailMessage      mailbox message metadata + body (subject / from / body).
 *     teamsMessage     Teams channel message content (FK → channelId).
 *     calendarEvent    per-person calendar timeline (subject / attendees / loc).
 *     fileEntry        OneDrive/SharePoint private file catalog (name / size /
 *                      webUrl) — corporate file names are confidential, so the
 *                      catalog is sealed E2E (downloadUrl is NEVER fronted).
 *     formTask         BPMN human-task assignment (assigneeDid / projectRef).
 *
 *   STAYS etzhayyim (consumed via consent-capability, NOT a collection) — the
 *   irreducible regulated EXECUTION:
 *     * M365 Graph API ingest + OAuth / credential / secret custody (raw token
 *       custody is regulated; never fronted).
 *     * Outbound send ACTIONS — sendTeamsMessage POST + mail send execution —
 *       these enforcement actions need the custodied M365 credential.
 *     * Claude Cowork LLM inference execution (GPU/LLM compute).
 *   NO fiat settlement / merchant-of-record rail exists in cowork (no payment
 *   path), so there is no settlement CALL to retain here.
 *
 * AT-Lexicon: no float. fileEntry.size is integer bytes; all counts integers.
 */

// ─── Collections / inner-types ──────────────────────────────────────
// appCamel = "cowork" (new front; NOT the legacy coworkGraph XRPC namespace).

// Plaintext public collection.
export const CHANNEL_COLLECTION = "com.etzhayyim.apps.cowork.teamsChannel";

// E2E inner-type NSIDs (= collection NSID of the body shape sealed inside the
// kotoba envelope).
export const MEMBER_INNER_TYPE = "com.etzhayyim.apps.cowork.directoryMember";
export const MAIL_INNER_TYPE = "com.etzhayyim.apps.cowork.mailMessage";
export const TEAMS_MSG_INNER_TYPE = "com.etzhayyim.apps.cowork.teamsMessage";
export const CALENDAR_INNER_TYPE = "com.etzhayyim.apps.cowork.calendarEvent";
export const FILE_INNER_TYPE = "com.etzhayyim.apps.cowork.fileEntry";
export const TASK_INNER_TYPE = "com.etzhayyim.apps.cowork.formTask";

export const COWORK_DID_PREFIX = "did:web:cowork.etzhayyim.com:" as const;

// ─── Teams channel (PLAINTEXT, org-structure catalog) ───────────────

export interface TeamsChannelRecord {
  did: string;
  teamId: string;
  channelId: string;
  displayName: string;
  description?: string;
  membershipType?: string;
  createdAt: string;
}
export interface TeamsChannelView extends TeamsChannelRecord {
  channelUri: string;
}
export interface RegisterChannelInput {
  teamId: string;
  channelId: string;
  displayName: string;
  description?: string;
  membershipType?: string;
}
export interface RegisterChannelOutput {
  status: "registered" | "alreadyExists" | "rejected";
  channelUri?: string;
  did?: string;
  channelId?: string;
  error?: string;
}
export interface GetChannelInput {
  channelId: string;
}
export interface GetChannelOutput {
  channel?: TeamsChannelView;
  error?: string;
}
export interface ListChannelsInput {
  teamId?: string;
  limit?: number;
  cursor?: string;
}
export interface ListChannelsOutput {
  items: TeamsChannelView[];
  cursor?: string;
  total: number;
}

// ─── Directory member (E2E, PII) ────────────────────────────────────

export interface DirectoryMemberBody {
  userId: string;
  displayName: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  preferredLanguage?: string;
}
export interface DirectoryMemberView extends DirectoryMemberBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordMemberInput {
  userId: string;
  displayName: string;
  mail?: string;
  userPrincipalName?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  preferredLanguage?: string;
  recipients?: string[];
}
export interface RecordMemberOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  userId?: string;
  error?: string;
}
export interface ListMembersInput {
  department?: string;
  limit?: number;
}
export interface ListMembersOutput {
  items: DirectoryMemberView[];
  total: number;
}
export interface GetMemberInput {
  userId: string;
}
export interface GetMemberOutput {
  member?: DirectoryMemberView;
  error?: string;
}

// ─── Mail message (E2E, private content) ────────────────────────────

export interface MailMessageBody {
  messageId: string;
  userId: string;
  subject?: string;
  from?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
}
export interface MailMessageView extends MailMessageBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordMailInput {
  messageId: string;
  userId: string;
  subject?: string;
  from?: string;
  toRecipients?: string[];
  ccRecipients?: string[];
  bodyPreview?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  recipients?: string[];
}
export interface RecordMailOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  messageId?: string;
  error?: string;
}
export interface ListMailInput {
  userId?: string;
  limit?: number;
}
export interface ListMailOutput {
  items: MailMessageView[];
  total: number;
}

// ─── Teams message (E2E, message content, FK → channelId) ───────────

export interface TeamsMessageBody {
  teamsMessageId: string;
  channelId: string;
  authorDid?: string;
  bodyContent?: string;
  contentType?: string;
  postedAt?: string;
}
export interface TeamsMessageView extends TeamsMessageBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordTeamsMessageInput {
  teamsMessageId: string;
  channelId: string;
  authorDid?: string;
  bodyContent?: string;
  contentType?: string;
  postedAt?: string;
  recipients?: string[];
}
export interface RecordTeamsMessageOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  teamsMessageId?: string;
  error?: string;
}
export interface ListTeamsMessagesInput {
  channelId?: string;
  limit?: number;
}
export interface ListTeamsMessagesOutput {
  items: TeamsMessageView[];
  total: number;
}

// ─── Calendar event (E2E, per-person timeline) ──────────────────────

export interface CalendarEventBody {
  eventId: string;
  userId: string;
  subject?: string;
  location?: string;
  attendees?: string[];
  startDateTime?: string;
  endDateTime?: string;
  isAllDay?: boolean;
}
export interface CalendarEventView extends CalendarEventBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordEventInput {
  eventId: string;
  userId: string;
  subject?: string;
  location?: string;
  attendees?: string[];
  startDateTime?: string;
  endDateTime?: string;
  isAllDay?: boolean;
  recipients?: string[];
}
export interface RecordEventOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  eventId?: string;
  error?: string;
}
export interface ListEventsInput {
  userId?: string;
  limit?: number;
}
export interface ListEventsOutput {
  items: CalendarEventView[];
  total: number;
}

// ─── File entry (E2E, private file catalog; downloadUrl NEVER fronted) ─

export interface FileEntryBody {
  itemId: string;
  driveId: string;
  name: string;
  /** integer bytes. */
  size?: number;
  webUrl?: string;
  isFolder?: boolean;
  lastModifiedDateTime?: string;
}
export interface FileEntryView extends FileEntryBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordFileInput {
  itemId: string;
  driveId: string;
  name: string;
  size?: number;
  webUrl?: string;
  isFolder?: boolean;
  lastModifiedDateTime?: string;
  recipients?: string[];
}
export interface RecordFileOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  itemId?: string;
  error?: string;
}
export interface ListFilesInput {
  driveId?: string;
  limit?: number;
}
export interface ListFilesOutput {
  items: FileEntryView[];
  total: number;
}

// ─── Form task (E2E, BPMN human-task assignment) ────────────────────

export interface FormTaskBody {
  taskId: string;
  assigneeDid: string;
  projectRef?: string;
  status: string;
  title?: string;
  dueDateTime?: string;
}
export interface FormTaskView extends FormTaskBody {
  uri: string;
  sender: string;
  createdAt: string;
}
export interface RecordTaskInput {
  taskId: string;
  assigneeDid: string;
  projectRef?: string;
  status?: string;
  title?: string;
  dueDateTime?: string;
  recipients?: string[];
}
export interface RecordTaskOutput {
  status: "recorded" | "rejected";
  uri?: string;
  keyId?: string;
  taskId?: string;
  error?: string;
}
export interface ListTasksInput {
  assigneeDid?: string;
  status?: string;
  limit?: number;
}
export interface ListTasksOutput {
  items: FormTaskView[];
  total: number;
}

// ─── Coverage rollup ────────────────────────────────────────────────

export interface CoverageInput {
  maxScan?: number;
}
export interface CoverageOutput {
  teamsChannelCount?: number;
  directoryMemberCount?: number;
  mailMessageCount?: number;
  teamsMessageCount?: number;
  calendarEventCount?: number;
  fileEntryCount?: number;
  formTaskCount?: number;
  channelsByTeam?: Record<string, number>;
  truncated?: boolean;
  error?: string;
}

// ─── Validation + helpers ───────────────────────────────────────────

export function isUint(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}
export function channelDidFor(id: string): string {
  return `${COWORK_DID_PREFIX}chan:${id.toLowerCase()}`;
}
export function rkeyOf(prefix: string, id: string): string {
  return `${prefix}-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
