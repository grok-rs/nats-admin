import { test } from "node:test";
import assert from "node:assert/strict";
import { concreteSubject, subjectMatches, subjectsOverlap } from "../src/shared/subjects";
import { aggregateShape, validateKvKey } from "../src/shared/shape";

test("subject matching", () => {
  assert.ok(subjectMatches("orders.>", "orders.eu.created"));
  assert.ok(!subjectMatches("orders.>", "orders"));
  assert.ok(subjectMatches("orders.*.created", "orders.eu.created"));
  assert.ok(!subjectMatches("orders.*", "orders.eu.created"));
  assert.ok(subjectMatches("a.b", "a.b"));
  assert.ok(!subjectMatches("a.b", "a.c"));
});

test("subject overlap (consumer filter vs stream subjects, deliver loops)", () => {
  assert.ok(subjectsOverlap("orders.>", "orders.eu.>"));
  assert.ok(subjectsOverlap("orders.*.created", "orders.eu.*"));
  assert.ok(subjectsOverlap("orders.>", "orders.us"));
  assert.ok(!subjectsOverlap("orders.>", "orders"));
  assert.ok(!subjectsOverlap("orders.>", "billing.>"));
  assert.ok(!subjectsOverlap("a.*", "a.b.c"));
  assert.ok(subjectsOverlap(">", "anything.at.all"));
  assert.ok(subjectsOverlap("*.x", "y.*"));
  assert.equal(concreteSubject("orders.*.created"), "orders.x.created");
  assert.equal(concreteSubject("orders.>"), "orders.test");
});

test("aggregate JSON shape across documents", () => {
  const shape = aggregateShape([
    { user: "alice", loginAt: "2026-01-01", roles: ["admin"], meta: { ip: "1.2.3.4" } },
    { user: "bob", loginAt: "2026-01-02", roles: [] },
    { user: "carol", loginAt: null, roles: ["dev", "ops"], meta: { ip: "5.6.7.8", agent: "cli" } },
  ]);
  assert.equal(shape.documents, 3);
  const byPath = new Map(shape.rows.map((r) => [r.path, r]));
  assert.equal(byPath.get("user")!.present, 3);
  assert.deepEqual(byPath.get("loginAt")!.types, { string: 2, null: 1 });
  assert.equal(byPath.get("meta")!.present, 2);
  assert.equal(byPath.get("meta.agent")!.present, 1);
  assert.deepEqual(byPath.get("roles[]")!.types, { string: 3 });
  // depth-first ordering: children follow their parent
  const paths = shape.rows.map((r) => r.path);
  assert.ok(paths.indexOf("meta.ip") === paths.indexOf("meta") + 1);
  assert.ok(paths.indexOf("meta.agent") > paths.indexOf("meta.ip"));
  assert.ok(paths.indexOf("meta.agent") < paths.indexOf("meta") + 3);
});

test("kv key validation", () => {
  assert.equal(validateKvKey("app.db.host"), undefined);
  assert.equal(validateKvKey("a/b=c_d-e"), undefined);
  assert.ok(validateKvKey(""));
  assert.ok(validateKvKey("has space"));
  assert.ok(validateKvKey(".lead"));
  assert.ok(validateKvKey("trail."));
  assert.ok(validateKvKey("a..b"));
  assert.ok(validateKvKey("wild.*"));
});
