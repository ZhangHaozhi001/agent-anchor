import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditLog, GENESIS_HASH, canonicalJson } from "../src/index.js";

const fixedClock = (startIso = "2026-11-18T00:00:00.000Z", stepMs = 1000) => {
  let t = Date.parse(startIso);
  return () => new Date((t += stepMs));
};

function sampleLog(): AuditLog {
  const log = new AuditLog({
    agentId: "agent:test-01",
    ownerRef: "concordium-id:test-owner",
    clock: fixedClock(),
  });
  log.append({ actionType: "payment.sent", payload: { amount: "1.00", asset: "USDC" } });
  log.append({ actionType: "task.completed", payload: { task: "demo" } });
  log.append({ actionType: "payment.received", payload: { amount: "2.00", asset: "USDC" } });
  return log;
}

test("append assigns sequential seq numbers and links each record to the previous hash", () => {
  const log = sampleLog();
  const records = log.list();
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.seq),
    [0, 1, 2],
  );
  assert.equal(records[0].prevHash, GENESIS_HASH);
  assert.equal(records[1].prevHash, records[0].hash);
  assert.equal(records[2].prevHash, records[1].hash);
  for (const rec of records) {
    assert.match(rec.hash, /^[0-9a-f]{64}$/);
  }
});

test("hash is independent of payload key order (canonical JSON)", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 1 }));
  const mk = (payload: Record<string, string>) =>
    new AuditLog({ agentId: "a", ownerRef: "o", clock: fixedClock() }).append({
      actionType: "x",
      payload,
    }).hash;
  assert.equal(mk({ p: "1", q: "2" }), mk({ q: "2", p: "1" }));
});

test("different payloads produce different hashes", () => {
  const log = new AuditLog({ agentId: "a", ownerRef: "o", clock: fixedClock() });
  const h1 = log.append({ actionType: "x", payload: { v: "1" } }).hash;
  const other = new AuditLog({ agentId: "a", ownerRef: "o", clock: fixedClock() });
  const h2 = other.append({ actionType: "x", payload: { v: "2" } }).hash;
  assert.notEqual(h1, h2);
});

test("an untouched chain verifies OK", () => {
  const log = sampleLog();
  const result = log.verify();
  assert.equal(result.ok, true);
  assert.equal(result.checked, 3);
  assert.equal(result.firstBadSeq, null);
});

test("tampering with a record's payload is detected at that record", () => {
  const data = sampleLog().toJSON();
  data.records[1].payload = { task: "forged" };
  const result = AuditLog.verifyRecords(data.records);
  assert.equal(result.ok, false);
  assert.equal(result.firstBadSeq, 1);
  assert.match(result.reason ?? "", /hash mismatch/);
});

test("rewriting a record's stored hash is detected", () => {
  const data = sampleLog().toJSON();
  data.records[0].hash = "f".repeat(64);
  const result = AuditLog.verifyRecords(data.records);
  assert.equal(result.ok, false);
  assert.equal(result.firstBadSeq, 0);
});

test("reordering records breaks sequence/linkage checks", () => {
  const data = sampleLog().toJSON();
  [data.records[1], data.records[2]] = [data.records[2], data.records[1]];
  const result = AuditLog.verifyRecords(data.records);
  assert.equal(result.ok, false);
  assert.equal(result.firstBadSeq, 1);
});

test("swapping in a record from another owner breaks the identity check", () => {
  const data = sampleLog().toJSON();
  const foreign = new AuditLog({ agentId: "agent:test-01", ownerRef: "concordium-id:someone-else" });
  foreign.append({ actionType: "payment.sent", payload: {} });
  // Same seq/prevHash position but a different ownerRef: recompute a self-consistent
  // hash is impossible without the chain, so simulate by splicing the foreign record
  // into position 0's slot of an otherwise empty verification.
  const result = AuditLog.verifyRecords([foreign.list()[0], ...data.records.slice(1)]);
  assert.equal(result.ok, false);
});

test("mutating a returned record or list snapshot does not corrupt the log", () => {
  const log = sampleLog();
  const snapshot = log.list();
  snapshot[0].payload = { amount: "999" };
  const head = log.head();
  assert.ok(head);
  head.payload = { forged: true };
  assert.equal(log.verify().ok, true);
});

test("JSON round trip preserves the chain and its root hash", () => {
  const log = sampleLog();
  const restored = AuditLog.fromJSON(JSON.parse(JSON.stringify(log.toJSON())));
  assert.equal(restored.verify().ok, true);
  assert.equal(restored.rootHash(), log.rootHash());
  assert.equal(restored.length, 3);
});

test("empty log: genesis root hash, zero-count anchor payload, verifies OK", () => {
  const log = new AuditLog({ agentId: "a", ownerRef: "o" });
  assert.equal(log.rootHash(), GENESIS_HASH);
  assert.equal(log.head(), null);
  assert.equal(log.verify().ok, true);
  const payload = log.anchorPayload();
  assert.equal(payload.recordCount, 0);
  assert.equal(payload.rootHash, GENESIS_HASH);
  assert.equal(payload.toSeq, -1);
  assert.equal(payload.periodStart, null);
  assert.equal(payload.periodEnd, null);
});

test("anchor payload covers the full chain range and period", () => {
  const log = sampleLog();
  const payload = log.anchorPayload();
  assert.equal(payload.recordCount, 3);
  assert.equal(payload.fromSeq, 0);
  assert.equal(payload.toSeq, 2);
  assert.equal(payload.rootHash, log.rootHash());
  assert.equal(payload.periodStart, log.list()[0].timestamp);
  assert.equal(payload.periodEnd, log.list()[2].timestamp);
});

test("actor defaults to 'agent' and can be overridden", () => {
  const log = new AuditLog({ agentId: "a", ownerRef: "o", clock: fixedClock() });
  assert.equal(log.append({ actionType: "x", payload: {} }).actor, "agent");
  assert.equal(log.append({ actionType: "y", payload: {}, actor: "owner" }).actor, "owner");
});
