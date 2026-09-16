import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../api/admin/students.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function query({ data = null, error = null, count = null } = {}, calls = []) {
  const result = { data, error, count };
  const chain = {
    select(...args) { calls.push(["select", ...args]); return chain; },
    eq(...args) { calls.push(["eq", ...args]); return chain; },
    neq(...args) { calls.push(["neq", ...args]); return chain; },
    in(...args) { calls.push(["in", ...args]); return chain; },
    update(value) { calls.push(["update", value]); return chain; },
    delete() { calls.push(["delete"]); return chain; },
    insert(value) { calls.push(["insert", value]); return Promise.resolve(result); },
    single() { return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return chain;
}

function loadEndpoint(supabase) {
  const compiledModule = { exports: {} };
  const helpers = {
    requireAdmin: async () => ({ supabase, user: { id: "admin-1" } }),
    handleApiError: async (error) => error instanceof Response ? error : Response.json({ error: error instanceof Error ? error.message : "failed" }, { status: 500 }),
    json: (body, status = 200) => Response.json(body, { status }),
    normalizeStudentId: (value) => value.trim().toUpperCase().replace(/\s+/g, ""),
    studentAuthEmail: (studentId) => `${studentId.toLowerCase()}@students.rizal-arcade.invalid`,
    temporaryPassword: () => "RaTest!234567",
    findAuthUserByEmail: async () => null,
  };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name === "../_lib/supabaseAdmin.js") return helpers;
    throw new Error(`Unexpected import: ${name}`);
  }, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

function studentBody(overrides = {}) {
  return {
    studentId: "2026-001",
    firstName: "Ada",
    middleName: "M",
    lastName: "Santos",
    courseCode: "BSIT",
    rosterEmail: "ada@example.edu",
    sectionId: "section-1",
    ...overrides,
  };
}

test("manual enrollment creates a real Auth user and returns its password only once", async () => {
  const profileCalls = [];
  const authCalls = [];
  const supabase = {
    from(name) {
      if (name === "rizal_arcade_sections") return query({ data: { id: "section-1", section_code: "BSIT-1A", school_year: "2026-2027", term: "First", active: true } });
      if (name === "rizal_arcade_profiles") return query({}, profileCalls);
      throw new Error(`Unexpected table: ${name}`);
    },
    auth: { admin: {
      async createUser(attributes) { authCalls.push(["create", attributes]); return { data: { user: { id: "student-uuid" } }, error: null }; },
      async deleteUser(id) { authCalls.push(["delete", id]); return { error: null }; },
    } },
  };
  const endpoint = loadEndpoint(supabase);
  const response = await endpoint.POST(new Request("https://example.test/api/admin/students", { method: "POST", body: JSON.stringify(studentBody()) }));
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.credential.temporaryPassword, "RaTest!234567");
  assert.equal(authCalls[0][1].email, "2026-001@students.rizal-arcade.invalid");
  assert.equal(authCalls[0][1].password, "RaTest!234567");
  const inserted = profileCalls.find(([operation]) => operation === "insert")[1];
  assert.equal(inserted.id, "student-uuid");
  assert.equal(inserted.role, "student");
  assert.equal(inserted.must_change_password, true);
});

test("editing a Student ID updates login metadata and leaderboard identity without changing the password", async () => {
  const current = { id: "student-uuid", student_id: "2026-001", first_name: "Ada", middle_name: "M", last_name: "Santos", display_name: "Ada S.", roster_email: "ada@example.edu", course_code: "BSIT", section_id: "section-1", active: true };
  const profileUpdateCalls = [];
  const scoreCalls = [];
  const authCalls = [];
  let profileQuery = 0;
  const supabase = {
    from(name) {
      if (name === "rizal_arcade_sections") return query({ data: { id: "section-2", section_code: "BSIT-1B", school_year: "2026-2027", term: "First", active: true } });
      if (name === "rizal_arcade_profiles") {
        profileQuery += 1;
        if (profileQuery === 1) return query({ data: current });
        if (profileQuery === 2) return query({ data: null });
        return query({}, profileUpdateCalls);
      }
      if (name === "rizal_arcade_scores") return query({}, scoreCalls);
      throw new Error(`Unexpected table: ${name}`);
    },
    auth: { admin: { async updateUserById(id, attributes) { authCalls.push([id, attributes]); return { error: null }; } } },
  };
  const endpoint = loadEndpoint(supabase);
  const response = await endpoint.PATCH(new Request("https://example.test/api/admin/students", { method: "PATCH", body: JSON.stringify({ id: "student-uuid", ...studentBody({ studentId: "2026-099", firstName: "Adaline", sectionId: "section-2" }) }) }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.match(body.message, /password did not change/i);
  assert.equal(authCalls[0][0], "student-uuid");
  assert.equal(authCalls[0][1].email, "2026-099@students.rizal-arcade.invalid");
  assert.equal("password" in authCalls[0][1], false);
  assert.deepEqual(scoreCalls.find(([operation]) => operation === "update")[1], { section_id: "section-2", player_name: "Adaline S." });
  assert.equal(profileUpdateCalls.find(([operation]) => operation === "update")[1].student_id, "2026-099");
});

test("deactivation blocks access without deleting the student or touching Auth", async () => {
  const current = { id: "student-uuid", student_id: "2026-001", display_name: "Ada S.", active: true };
  const updateCalls = [];
  let profileQuery = 0;
  const supabase = {
    from(name) {
      assert.equal(name, "rizal_arcade_profiles");
      profileQuery += 1;
      return profileQuery === 1 ? query({ data: current }) : query({}, updateCalls);
    },
    auth: { admin: { async updateUserById() { assert.fail("Auth should not change during deactivation"); } } },
  };
  const endpoint = loadEndpoint(supabase);
  const response = await endpoint.PATCH(new Request("https://example.test/api/admin/students", { method: "PATCH", body: JSON.stringify({ id: "student-uuid", action: "set-active", active: false }) }));
  assert.equal(response.status, 200);
  assert.equal(updateCalls.find(([operation]) => operation === "update")[1].active, false);
});

test("permanent deletion requires the exact Student ID and deletes through Auth for cascading cleanup", async () => {
  const profile = { id: "student-uuid", student_id: "2026-001", display_name: "Ada S." };
  const deleted = [];
  const supabase = {
    from(name) {
      if (name === "rizal_arcade_profiles") return query({ data: profile });
      if (name === "rizal_arcade_scores") return query({ count: 3 });
      if (name === "rizal_arcade_badges") return query({ count: 2 });
      throw new Error(`Unexpected table: ${name}`);
    },
    auth: { admin: { async deleteUser(id) { deleted.push(id); return { error: null }; } } },
  };
  const endpoint = loadEndpoint(supabase);
  const rejected = await endpoint.DELETE(new Request("https://example.test/api/admin/students", { method: "DELETE", body: JSON.stringify({ id: "student-uuid", confirmation: "wrong" }) }));
  assert.equal(rejected.status, 400);
  assert.deepEqual(deleted, []);

  const accepted = await endpoint.DELETE(new Request("https://example.test/api/admin/students", { method: "DELETE", body: JSON.stringify({ id: "student-uuid", confirmation: "2026-001" }) }));
  const body = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.deepEqual(deleted, ["student-uuid"]);
  assert.deepEqual(body.deleted, { id: "student-uuid", studentId: "2026-001", displayName: "Ada S.", scores: 3, badges: 2 });
});

test("the roster UI exposes add, edit, access control, and typed permanent deletion", () => {
  const ui = readFileSync(new URL("../app/AdminPortal.tsx", import.meta.url), "utf8");
  const passwordResetApi = readFileSync(new URL("../api/admin/reset-student-password.ts", import.meta.url), "utf8");
  assert.match(ui, /Add one student/);
  assert.match(ui, /Create student account/);
  assert.match(ui, /Deactivate/);
  assert.match(ui, /Reactivate/);
  assert.match(ui, /Permanently delete student/);
  assert.match(ui, /confirmation:\s*deleteConfirmation/);
  assert.match(ui, /"DELETE"/);
  assert.doesNotMatch(passwordResetApi, /must_change_password:\s*true,\s*active:\s*true/);
});
