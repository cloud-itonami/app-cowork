/**
 * cowork kotoba — barrel. kotoba product-front for the Etzhayyim Cowork M365
 * collaboration graph: plaintext Teams-channel org catalog + kotoba-E2E PII /
 * private-content domains (directory / mail / Teams messages / calendar /
 * files / BPMN tasks, ADR-2605181100). M365 credential custody + outbound send
 * + LLM inference stay etzhayyim via consent-capability. No fiat rail in cowork.
 */
export * from "./types.js";
export {
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
} from "./registry.js";
