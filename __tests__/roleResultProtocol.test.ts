import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";

import {
  ROLE_RESULT_SCHEMA_ID,
  PI_ROLES_RESULT_TYPE,
  createRoleResultEnvelope,
  parseRoleResultEnvelope,
} from "@silentmoebuta/pi-roles-protocol/role-result";
import {
  PI_ROLES_RESULT_TYPE as GOAL_RESULT_TYPE,
  parseRoleResultEnvelopeV1,
} from "../extensions/role-result-v1";

const require = createRequire(import.meta.url);

describe("shared pi-roles role-result protocol", () => {
  it("uses the published schema and canonical parser rather than a local contract copy", () => {
    const schemaPath = require.resolve("@silentmoebuta/pi-roles-protocol/schemas/role-result-v1.schema.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    assert.equal(schema.$id, ROLE_RESULT_SCHEMA_ID);
    assert.equal(GOAL_RESULT_TYPE, PI_ROLES_RESULT_TYPE);

    const envelope = createRoleResultEnvelope({
      agentId: "protocol-test-agent",
      role: "goal-reviewer",
      status: "completed",
      payload: { decision: "accept", summary: "Shared parser" },
      turnCount: 1,
      recordedAt: 10,
    });
    assert.deepEqual(parseRoleResultEnvelopeV1(envelope), parseRoleResultEnvelope(envelope));
  });
});
