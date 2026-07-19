/**
 * cowork kotoba — registry.
 *
 * Plaintext path (teamsChannel): sdk.write / sdk.read — public org-structure
 * catalog, FK anchor = teamId.
 * E2E path (directoryMember / mailMessage / teamsMessage / calendarEvent /
 * fileEntry / formTask): sdk.encryptedWrite / sdk.encryptedRead — PII / private
 * content sealed in the kotoba envelope (ADR-2605181100), read-cap = owner DID
 * + explicit recipients. The substrate never sees member PII, mail/Teams
 * content, calendar attendees, file names, or task assignments in plaintext.
 *
 * STAYS etzhayyim (consent-capability): M365 Graph OAuth/credential custody +
 * outbound send execution (sendTeamsMessage / mail send) + Claude Cowork LLM
 * inference. No fiat rail in cowork.
 */

import type { Etzhayyim } from "@etzhayyim/sdk";
import {
  CALENDAR_INNER_TYPE,
  CHANNEL_COLLECTION,
  FILE_INNER_TYPE,
  MAIL_INNER_TYPE,
  MEMBER_INNER_TYPE,
  TASK_INNER_TYPE,
  TEAMS_MSG_INNER_TYPE,
  channelDidFor,
  isUint,
  rkeyOf,
  type CalendarEventBody,
  type CalendarEventView,
  type CoverageInput,
  type CoverageOutput,
  type DirectoryMemberBody,
  type DirectoryMemberView,
  type FileEntryBody,
  type FileEntryView,
  type FormTaskBody,
  type FormTaskView,
  type GetChannelInput,
  type GetChannelOutput,
  type GetMemberInput,
  type GetMemberOutput,
  type ListChannelsInput,
  type ListChannelsOutput,
  type ListEventsInput,
  type ListEventsOutput,
  type ListFilesInput,
  type ListFilesOutput,
  type ListMailInput,
  type ListMailOutput,
  type ListMembersInput,
  type ListMembersOutput,
  type ListTasksInput,
  type ListTasksOutput,
  type ListTeamsMessagesInput,
  type ListTeamsMessagesOutput,
  type MailMessageBody,
  type MailMessageView,
  type RecordEventInput,
  type RecordEventOutput,
  type RecordFileInput,
  type RecordFileOutput,
  type RecordMailInput,
  type RecordMailOutput,
  type RecordMemberInput,
  type RecordMemberOutput,
  type RecordTaskInput,
  type RecordTaskOutput,
  type RecordTeamsMessageInput,
  type RecordTeamsMessageOutput,
  type RegisterChannelInput,
  type RegisterChannelOutput,
  type TeamsChannelRecord,
  type TeamsChannelView,
  type TeamsMessageBody,
  type TeamsMessageView,
} from "./types.js";

const PAGE_LIMIT = 100;
const DEFAULT_MAX_SCAN = 10_000;

// ─── Teams channel (PLAINTEXT, org-structure catalog) ───────────────

export async function registerChannel(e: Etzhayyim, input: RegisterChannelInput): Promise<RegisterChannelOutput> {
  if (!input.teamId || !input.channelId || !input.displayName) return { status: "rejected", error: "missingRequiredFields" };
  const rkey = rkeyOf("chan", input.channelId);
  const existing = await e.read<TeamsChannelRecord>({ collection: CHANNEL_COLLECTION, rkey }).catch(() => ({ records: [] }));
  if (existing.records[0]?.value) {
    return { status: "alreadyExists", channelUri: existing.records[0].uri, did: existing.records[0].value.did, channelId: input.channelId };
  }
  const now = new Date().toISOString();
  const did = channelDidFor(input.channelId);
  const record: TeamsChannelRecord = {
    did,
    teamId: input.teamId,
    channelId: input.channelId,
    displayName: input.displayName,
    description: input.description,
    membershipType: input.membershipType,
    createdAt: now,
  };
  const receipt = await e.write({ collection: CHANNEL_COLLECTION, record: record as unknown as Record<string, unknown>, rkey });
  return { status: "registered", channelUri: receipt.uri, did, channelId: input.channelId };
}

export async function getChannel(e: Etzhayyim, input: GetChannelInput): Promise<GetChannelOutput> {
  if (!input.channelId) return { error: "invalidChannelId" };
  const rkey = rkeyOf("chan", input.channelId);
  const resp = await e.read<TeamsChannelRecord>({ collection: CHANNEL_COLLECTION, rkey }).catch(() => ({ records: [] }));
  const r = resp.records[0];
  if (!r?.value) return { error: "notFound" };
  return { channel: { ...r.value, channelUri: r.uri } };
}

export async function listChannels(e: Etzhayyim, input: ListChannelsInput = {}): Promise<ListChannelsOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const resp = await e.read<TeamsChannelRecord>({ collection: CHANNEL_COLLECTION, cursor: input.cursor, limit });
  const items: TeamsChannelView[] = resp.records
    .filter((r) => !input.teamId || r.value.teamId === input.teamId)
    .map((r) => ({ ...r.value, channelUri: r.uri }));
  return { items, cursor: resp.cursor, total: items.length };
}

/** Plaintext FK helper (exists via read; mock has no exists()). */
async function channelExists(e: Etzhayyim, channelId: string): Promise<boolean> {
  const rkey = rkeyOf("chan", channelId);
  const resp = await e
    .read<TeamsChannelRecord>({ collection: CHANNEL_COLLECTION, rkey })
    .catch(() => ({ records: [] as Array<{ uri: string; value: TeamsChannelRecord }> }));
  return Boolean(resp.records[0]?.value);
}

// ─── Generic E2E scan helper ────────────────────────────────────────

async function scanE2E<B>(e: Etzhayyim, innerType: string, maxScan: number): Promise<Array<B & { uri: string; sender: string; createdAt: string }>> {
  const out: Array<B & { uri: string; sender: string; createdAt: string }> = [];
  let cursor: string | undefined;
  while (out.length < maxScan) {
    const page = await e.encryptedRead<B>({ innerType, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      out.push({ ...(r.value as B), uri: r.uri, sender: r.sender, createdAt: r.createdAt });
    }
    if (!page.cursor || page.records.length === 0) break;
    cursor = page.cursor;
  }
  return out;
}

// ─── Directory member (E2E, PII) ────────────────────────────────────

export async function recordMember(e: Etzhayyim, input: RecordMemberInput): Promise<RecordMemberOutput> {
  if (!input.userId || !input.displayName) return { status: "rejected", error: "missingRequiredFields" };
  const body: DirectoryMemberBody = {
    userId: input.userId,
    displayName: input.displayName,
    mail: input.mail,
    userPrincipalName: input.userPrincipalName,
    jobTitle: input.jobTitle,
    department: input.department,
    officeLocation: input.officeLocation,
    preferredLanguage: input.preferredLanguage,
  };
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: MEMBER_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: rkeyOf("member", input.userId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, userId: input.userId };
}

export async function listMembers(e: Etzhayyim, input: ListMembersInput = {}): Promise<ListMembersOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanE2E<DirectoryMemberBody>(e, MEMBER_INNER_TYPE, DEFAULT_MAX_SCAN);
  const filtered = all.filter((m) => !input.department || m.department === input.department) as DirectoryMemberView[];
  return { items: filtered.slice(0, limit), total: filtered.length };
}

export async function getMember(e: Etzhayyim, input: GetMemberInput): Promise<GetMemberOutput> {
  if (!input.userId) return { error: "invalidUserId" };
  const all = await scanE2E<DirectoryMemberBody>(e, MEMBER_INNER_TYPE, DEFAULT_MAX_SCAN);
  const found = all.find((m) => m.userId === input.userId) as DirectoryMemberView | undefined;
  if (!found) return { error: "notFound" };
  return { member: found };
}

// ─── Mail message (E2E, private content) ────────────────────────────

export async function recordMail(e: Etzhayyim, input: RecordMailInput): Promise<RecordMailOutput> {
  if (!input.messageId || !input.userId) return { status: "rejected", error: "missingRequiredFields" };
  const body: MailMessageBody = {
    messageId: input.messageId,
    userId: input.userId,
    subject: input.subject,
    from: input.from,
    toRecipients: input.toRecipients,
    ccRecipients: input.ccRecipients,
    bodyPreview: input.bodyPreview,
    receivedDateTime: input.receivedDateTime,
    isRead: input.isRead,
    hasAttachments: input.hasAttachments,
  };
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: MAIL_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: rkeyOf("mail", input.messageId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, messageId: input.messageId };
}

export async function listMail(e: Etzhayyim, input: ListMailInput = {}): Promise<ListMailOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanE2E<MailMessageBody>(e, MAIL_INNER_TYPE, DEFAULT_MAX_SCAN);
  const filtered = all.filter((m) => !input.userId || m.userId === input.userId) as MailMessageView[];
  return { items: filtered.slice(0, limit), total: filtered.length };
}

// ─── Teams message (E2E, message content, FK → channelId) ───────────

export async function recordTeamsMessage(e: Etzhayyim, input: RecordTeamsMessageInput): Promise<RecordTeamsMessageOutput> {
  if (!input.teamsMessageId || !input.channelId) return { status: "rejected", error: "missingRequiredFields" };
  if (!(await channelExists(e, input.channelId))) return { status: "rejected", error: "channelNotFound" };
  const body: TeamsMessageBody = {
    teamsMessageId: input.teamsMessageId,
    channelId: input.channelId,
    authorDid: input.authorDid,
    bodyContent: input.bodyContent,
    contentType: input.contentType,
    postedAt: input.postedAt,
  };
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: TEAMS_MSG_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: rkeyOf("tmsg", input.teamsMessageId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, teamsMessageId: input.teamsMessageId };
}

export async function listTeamsMessages(e: Etzhayyim, input: ListTeamsMessagesInput = {}): Promise<ListTeamsMessagesOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanE2E<TeamsMessageBody>(e, TEAMS_MSG_INNER_TYPE, DEFAULT_MAX_SCAN);
  const filtered = all.filter((m) => !input.channelId || m.channelId === input.channelId) as TeamsMessageView[];
  return { items: filtered.slice(0, limit), total: filtered.length };
}

// ─── Calendar event (E2E, per-person timeline) ──────────────────────

export async function recordEvent(e: Etzhayyim, input: RecordEventInput): Promise<RecordEventOutput> {
  if (!input.eventId || !input.userId) return { status: "rejected", error: "missingRequiredFields" };
  const body: CalendarEventBody = {
    eventId: input.eventId,
    userId: input.userId,
    subject: input.subject,
    location: input.location,
    attendees: input.attendees,
    startDateTime: input.startDateTime,
    endDateTime: input.endDateTime,
    isAllDay: input.isAllDay,
  };
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: CALENDAR_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: rkeyOf("event", input.eventId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, eventId: input.eventId };
}

export async function listEvents(e: Etzhayyim, input: ListEventsInput = {}): Promise<ListEventsOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanE2E<CalendarEventBody>(e, CALENDAR_INNER_TYPE, DEFAULT_MAX_SCAN);
  const filtered = all.filter((ev) => !input.userId || ev.userId === input.userId) as CalendarEventView[];
  return { items: filtered.slice(0, limit), total: filtered.length };
}

// ─── File entry (E2E, private file catalog) ─────────────────────────

export async function recordFile(e: Etzhayyim, input: RecordFileInput): Promise<RecordFileOutput> {
  if (!input.itemId || !input.driveId || !input.name) return { status: "rejected", error: "missingRequiredFields" };
  if (input.size !== undefined && !isUint(input.size)) return { status: "rejected", error: "invalidSize" };
  const body: FileEntryBody = {
    itemId: input.itemId,
    driveId: input.driveId,
    name: input.name,
    size: input.size,
    webUrl: input.webUrl,
    isFolder: input.isFolder,
    lastModifiedDateTime: input.lastModifiedDateTime,
  };
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: FILE_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: rkeyOf("file", input.itemId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, itemId: input.itemId };
}

export async function listFiles(e: Etzhayyim, input: ListFilesInput = {}): Promise<ListFilesOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanE2E<FileEntryBody>(e, FILE_INNER_TYPE, DEFAULT_MAX_SCAN);
  const filtered = all.filter((f) => !input.driveId || f.driveId === input.driveId) as FileEntryView[];
  return { items: filtered.slice(0, limit), total: filtered.length };
}

// ─── Form task (E2E, BPMN human-task assignment) ────────────────────

export async function recordTask(e: Etzhayyim, input: RecordTaskInput): Promise<RecordTaskOutput> {
  if (!input.taskId || !input.assigneeDid) return { status: "rejected", error: "missingRequiredFields" };
  const body: FormTaskBody = {
    taskId: input.taskId,
    assigneeDid: input.assigneeDid,
    projectRef: input.projectRef,
    status: input.status ?? "pending",
    title: input.title,
    dueDateTime: input.dueDateTime,
  };
  const receipt = await e.encryptedWrite<Record<string, unknown>>({
    innerType: TASK_INNER_TYPE,
    record: body as unknown as Record<string, unknown>,
    recipients: input.recipients ?? [],
    rkey: rkeyOf("task", input.taskId),
  });
  return { status: "recorded", uri: receipt.uri, keyId: receipt.keyId, taskId: input.taskId };
}

export async function listTasks(e: Etzhayyim, input: ListTasksInput = {}): Promise<ListTasksOutput> {
  const limit = Math.min(input.limit ?? 50, 200);
  const all = await scanE2E<FormTaskBody>(e, TASK_INNER_TYPE, DEFAULT_MAX_SCAN);
  const filtered = all.filter(
    (t) => (!input.assigneeDid || t.assigneeDid === input.assigneeDid) && (!input.status || t.status === input.status),
  ) as FormTaskView[];
  return { items: filtered.slice(0, limit), total: filtered.length };
}

// ─── Coverage rollup (plaintext + E2E countAll across ALL collections) ─

export async function coverage(e: Etzhayyim, input: CoverageInput = {}): Promise<CoverageOutput> {
  const maxScan = Math.min(input.maxScan ?? DEFAULT_MAX_SCAN, DEFAULT_MAX_SCAN);
  const channelsByTeam: Record<string, number> = {};
  let teamsChannelCount = 0;
  let cursor: string | undefined;
  while (teamsChannelCount < maxScan) {
    const page = await e.read<TeamsChannelRecord>({ collection: CHANNEL_COLLECTION, cursor, limit: PAGE_LIMIT });
    for (const r of page.records) {
      channelsByTeam[r.value.teamId] = (channelsByTeam[r.value.teamId] ?? 0) + 1;
      teamsChannelCount += 1;
    }
    if (!page.cursor || page.records.length < PAGE_LIMIT) break;
    cursor = page.cursor;
  }
  const directoryMemberCount = (await scanE2E<DirectoryMemberBody>(e, MEMBER_INNER_TYPE, maxScan)).length;
  const mailMessageCount = (await scanE2E<MailMessageBody>(e, MAIL_INNER_TYPE, maxScan)).length;
  const teamsMessageCount = (await scanE2E<TeamsMessageBody>(e, TEAMS_MSG_INNER_TYPE, maxScan)).length;
  const calendarEventCount = (await scanE2E<CalendarEventBody>(e, CALENDAR_INNER_TYPE, maxScan)).length;
  const fileEntryCount = (await scanE2E<FileEntryBody>(e, FILE_INNER_TYPE, maxScan)).length;
  const formTaskCount = (await scanE2E<FormTaskBody>(e, TASK_INNER_TYPE, maxScan)).length;
  const truncated =
    teamsChannelCount >= maxScan ||
    directoryMemberCount >= maxScan ||
    mailMessageCount >= maxScan ||
    teamsMessageCount >= maxScan ||
    calendarEventCount >= maxScan ||
    fileEntryCount >= maxScan ||
    formTaskCount >= maxScan;
  return {
    teamsChannelCount,
    directoryMemberCount,
    mailMessageCount,
    teamsMessageCount,
    calendarEventCount,
    fileEntryCount,
    formTaskCount,
    channelsByTeam,
    truncated,
  };
}
