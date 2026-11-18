import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLog, exportArticle12Json, exportArticle12Text } from "../src/index.js";

function sampleLog(): AuditLog {
  let t = Date.parse("2026-11-18T00:00:00.000Z");
  const log = new AuditLog({
    agentId: "agent:export-01",
    ownerRef: "concordium-id:export-owner",
    clock: () => new Date((t += 60_000)),
  });
  log.append({ actionType: "payment.sent", payload: { amount: "3.50", asset: "USDC" } });
  log.append({ actionType: "task.completed", payload: { task: "write-summary" } });
  return log;
}

test("JSON export carries the Article 12 shape and a verified integrity block", () => {
  const log = sampleLog();
  const out = exportArticle12Json(log, { generatedAt: "2026-11-18T01:00:00.000Z" });
  assert.equal(out.system.agentId, "agent:export-01");
  assert.equal(out.system.accountableOwnerRef, "concordium-id:export-owner");
  assert.match(out.standard, /Article 12/);
  assert.equal(out.integrity.recordCount, 2);
  assert.equal(out.integrity.rootHash, log.rootHash());
  assert.equal(out.integrity.chainVerified, true);
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0].event, "payment.sent");
  assert.equal(out.events[0].dateTime, log.list()[0].timestamp);
  assert.deepEqual(out.events[0].details, { amount: "3.50", asset: "USDC" });
  assert.equal(out.period.start, log.list()[0].timestamp);
  assert.equal(out.period.end, log.list()[1].timestamp);
});

test("JSON export of a tampered log reports chainVerified=false", () => {
  const data = sampleLog().toJSON();
  data.records[0].payload = { amount: "9999" };
  const tampered = AuditLog.fromJSON(data);
  const out = exportArticle12Json(tampered);
  assert.equal(out.integrity.chainVerified, false);
  assert.equal(out.integrity.verification.firstBadSeq, 0);
});

test("text export is a fileable record: header, one line per event, verification statement", () => {
  const log = sampleLog();
  const text = exportArticle12Text(log, { generatedAt: "2026-11-18T01:00:00.000Z" });
  assert.match(text, /EU AI Act Article 12/);
  assert.match(text, /agent:export-01/);
  assert.match(text, /Chain verification: OK/);
  const eventLines = text.split("\n").filter((l) => l.startsWith("#"));
  assert.equal(eventLines.length, 2);
  assert.match(eventLines[0], /payment\.sent/);
  assert.match(eventLines[1], /task\.completed/);
});

test("text export of a tampered log states FAILED with the reason", () => {
  const data = sampleLog().toJSON();
  data.records[1].actionType = "payment.sent";
  const text = exportArticle12Text(AuditLog.fromJSON(data));
  assert.match(text, /Chain verification: FAILED at seq 1/);
});

test("exports of an empty log are well-formed", () => {
  const log = new AuditLog({ agentId: "a", ownerRef: "o" });
  const out = exportArticle12Json(log);
  assert.equal(out.events.length, 0);
  assert.equal(out.integrity.chainVerified, true);
  assert.equal(out.period.start, null);
  assert.match(exportArticle12Text(log), /0 records/);
});
