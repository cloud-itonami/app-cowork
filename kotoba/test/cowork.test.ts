import { describe, it, expect, beforeEach } from "vitest";
import { MockEtzhayyim } from "@etzhayyim/sdk-mock";
import {
  registerChannel,
  getChannel,
  listChannels,
  recordMember,
  listMembers,
  getMember,
  recordMail,
  listMail,
  recordTeamsMessage,
  listTeamsMessages,
  recordEvent,
  listEvents,
  recordFile,
  listFiles,
  recordTask,
  listTasks,
  coverage,
} from "../src/index.js";

const OWNER = "did:web:cowork.etzhayyim.com";

describe("cowork kotoba (M365 collaboration graph)", () => {
  let e: any;
  beforeEach(() => {
    e = new MockEtzhayyim({ did: OWNER });
  });

  describe("teamsChannel (PLAINTEXT org-structure catalog)", () => {
    it("registers, dedups, validates, gets, lists/filters", async () => {
      expect((await registerChannel(e, { teamId: "t1", channelId: "c1", displayName: "General" })).status).toBe("registered");
      expect((await registerChannel(e, { teamId: "t1", channelId: "c1", displayName: "General" })).status).toBe("alreadyExists");
      expect((await registerChannel(e, { teamId: "", channelId: "cX", displayName: "x" })).status).toBe("rejected");
      await registerChannel(e, { teamId: "t2", channelId: "c2", displayName: "Sales", membershipType: "standard" });
      const got = await getChannel(e, { channelId: "c1" });
      expect(got.channel?.displayName).toBe("General");
      expect((await listChannels(e)).total).toBe(2);
      expect((await listChannels(e, { teamId: "t1" })).total).toBe(1);
    });
  });

  describe("directoryMember (E2E PII)", () => {
    it("seals via encryptedWrite, round-trips, validates, gets/lists", async () => {
      const ok = await recordMember(e, { userId: "u1", displayName: "Jun Kawasaki", mail: "j@x.com", department: "Eng" });
      expect(ok.status).toBe("recorded");
      expect(ok.keyId).toBeTruthy();
      expect((await recordMember(e, { userId: "", displayName: "x" })).status).toBe("rejected");
      const got = await getMember(e, { userId: "u1" });
      expect(got.member?.mail).toBe("j@x.com");
      await recordMember(e, { userId: "u2", displayName: "Aoi", department: "Sales" });
      expect((await listMembers(e)).total).toBe(2);
      expect((await listMembers(e, { department: "Eng" })).total).toBe(1);
    });

    it("isolates by distinct PDS view: a fresh actor with no envelope sees nothing", async () => {
      await recordMember(e, { userId: "u1", displayName: "Jun" });
      // Distinct instance = distinct envelope store (separate PDS); no records.
      const outsider: any = new MockEtzhayyim({ did: "did:web:outsider.example" });
      expect((await listMembers(outsider)).total).toBe(0);
    });

    it("grants read-cap to an explicit recipient only (recipient-filter path)", async () => {
      const partner = "did:web:partner.example";
      const r = await recordMember(e, { userId: "u1", displayName: "Jun", recipients: [partner] });
      expect(r.status).toBe("recorded");
      // owner (auto-wrapped) can read
      expect((await listMembers(e)).total).toBe(1);
      // named recipient can decrypt on the SAME envelope store
      e.did = partner;
      expect((await listMembers(e)).total).toBe(1);
      // a stranger holds no read-cap and is filtered out
      e.did = "did:web:stranger.example";
      expect((await listMembers(e)).total).toBe(0);
    });
  });

  describe("mailMessage (E2E private content)", () => {
    it("seals + round-trips + filters by userId", async () => {
      expect((await recordMail(e, { messageId: "m1", userId: "u1", subject: "Hi", bodyPreview: "hello" })).status).toBe("recorded");
      expect((await recordMail(e, { messageId: "", userId: "u1" })).status).toBe("rejected");
      await recordMail(e, { messageId: "m2", userId: "u2", subject: "Yo" });
      expect((await listMail(e)).total).toBe(2);
      expect((await listMail(e, { userId: "u1" })).total).toBe(1);
    });
  });

  describe("teamsMessage (E2E content, FK → channelId)", () => {
    it("rejects when channel FK missing, records when channel exists", async () => {
      expect((await recordTeamsMessage(e, { teamsMessageId: "tm1", channelId: "c1", bodyContent: "hi" })).status).toBe("rejected");
      await registerChannel(e, { teamId: "t1", channelId: "c1", displayName: "General" });
      expect((await recordTeamsMessage(e, { teamsMessageId: "tm1", channelId: "c1", bodyContent: "hi" })).status).toBe("recorded");
      await recordTeamsMessage(e, { teamsMessageId: "tm2", channelId: "c1", bodyContent: "yo" });
      expect((await listTeamsMessages(e, { channelId: "c1" })).total).toBe(2);
    });
  });

  describe("calendarEvent (E2E per-person timeline)", () => {
    it("seals + round-trips + filters by userId", async () => {
      expect((await recordEvent(e, { eventId: "ev1", userId: "u1", subject: "Standup", attendees: ["a@x.com"] })).status).toBe("recorded");
      expect((await recordEvent(e, { eventId: "", userId: "u1" })).status).toBe("rejected");
      await recordEvent(e, { eventId: "ev2", userId: "u2", subject: "Review" });
      expect((await listEvents(e)).total).toBe(2);
      expect((await listEvents(e, { userId: "u1" })).total).toBe(1);
    });
  });

  describe("fileEntry (E2E private file catalog)", () => {
    it("seals + validates integer size + filters by driveId", async () => {
      expect((await recordFile(e, { itemId: "f1", driveId: "d1", name: "Q3-plan.xlsx", size: 4096 })).status).toBe("recorded");
      expect((await recordFile(e, { itemId: "fX", driveId: "d1", name: "x", size: -1 })).status).toBe("rejected");
      expect((await recordFile(e, { itemId: "", driveId: "d1", name: "x" })).status).toBe("rejected");
      await recordFile(e, { itemId: "f2", driveId: "d2", name: "notes.txt" });
      expect((await listFiles(e)).total).toBe(2);
      expect((await listFiles(e, { driveId: "d1" })).total).toBe(1);
    });
  });

  describe("formTask (E2E BPMN human-task assignment)", () => {
    it("seals + defaults status + filters by assignee/status", async () => {
      expect((await recordTask(e, { taskId: "k1", assigneeDid: "did:web:m:jun", title: "Approve" })).status).toBe("recorded");
      expect((await recordTask(e, { taskId: "", assigneeDid: "x" })).status).toBe("rejected");
      await recordTask(e, { taskId: "k2", assigneeDid: "did:web:m:aoi", status: "done" });
      expect((await listTasks(e)).total).toBe(2);
      expect((await listTasks(e, { assigneeDid: "did:web:m:jun" })).total).toBe(1);
      expect((await listTasks(e, { status: "pending" })).total).toBe(1);
    });
  });

  describe("coverage rollup (plaintext + every E2E collection)", () => {
    it("counts channels plus all six E2E domains", async () => {
      await registerChannel(e, { teamId: "t1", channelId: "c1", displayName: "General" });
      await registerChannel(e, { teamId: "t1", channelId: "c2", displayName: "Random" });
      await recordMember(e, { userId: "u1", displayName: "Jun" });
      await recordMail(e, { messageId: "m1", userId: "u1" });
      await recordTeamsMessage(e, { teamsMessageId: "tm1", channelId: "c1" });
      await recordEvent(e, { eventId: "ev1", userId: "u1" });
      await recordFile(e, { itemId: "f1", driveId: "d1", name: "a.txt" });
      await recordTask(e, { taskId: "k1", assigneeDid: "did:web:m:jun" });
      const cov = await coverage(e);
      expect(cov.teamsChannelCount).toBe(2);
      expect(cov.directoryMemberCount).toBe(1);
      expect(cov.mailMessageCount).toBe(1);
      expect(cov.teamsMessageCount).toBe(1);
      expect(cov.calendarEventCount).toBe(1);
      expect(cov.fileEntryCount).toBe(1);
      expect(cov.formTaskCount).toBe(1);
      expect(cov.channelsByTeam?.t1).toBe(2);
    });
  });
});
