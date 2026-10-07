import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../api/auth/resolve-login.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadEndpoint(rows = [], error = null, calls = []) {
  const query = {
    select(...args) { calls.push(["select", ...args]); return query; },
    eq(...args) { calls.push(["eq", ...args]); return query; },
    ilike(...args) { calls.push(["ilike", ...args]); return query; },
    limit(...args) { calls.push(["limit", ...args]); return Promise.resolve({ data: rows, error }); },
  };
  const helpers = {
    getAdminClient: () => ({
      from(name) {
        assert.equal(name, "rizal_arcade_profiles");
        return query;
      },
    }),
    handleApiError: async (reason) => Response.json({ error: reason instanceof Error ? reason.message : "failed" }, { status: 500 }),
    json: (body, status = 200) => Response.json(body, { status }),
    normalizeStudentId: (value) => value.trim().toUpperCase().replace(/\s+/g, ""),
    studentAuthEmail: (studentId) => `${studentId.trim().toLowerCase()}@students.rizal-arcade.invalid`,
  };
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    if (name === "../_lib/supabaseAdmin.js") return helpers;
    throw new Error(`Unexpected import: ${name}`);
  }, compiledModule, compiledModule.exports);
  return compiledModule.exports;
}

test("resolves an official roster email to the existing student Auth identity", async () => {
  const calls = [];
  const endpoint = loadEndpoint([{ student_id: "2026-001" }], null, calls);
  const response = await endpoint.POST(new Request("https://example.test/api/auth/resolve-login", {
    method: "POST",
    body: JSON.stringify({ identifier: " ADA@EXAMPLE.EDU " }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { loginEmail: "2026-001@students.rizal-arcade.invalid" });
  assert.ok(calls.some(([method, column, value]) => method === "ilike" && column === "roster_email" && value === "ada@example.edu"));
  assert.ok(calls.some(([method, column, value]) => method === "eq" && column === "active" && value === true));
});

test("keeps administrator and unknown emails unchanged", async () => {
  const endpoint = loadEndpoint([]);
  const response = await endpoint.POST(new Request("https://example.test/api/auth/resolve-login", {
    method: "POST",
    body: JSON.stringify({ identifier: "ADMIN@EXAMPLE.EDU" }),
  }));
  assert.deepEqual(await response.json(), { loginEmail: "admin@example.edu" });
});

test("keeps Student ID login compatible without querying the profile table", async () => {
  const endpoint = loadEndpoint();
  const response = await endpoint.POST(new Request("https://example.test/api/auth/resolve-login", {
    method: "POST",
    body: JSON.stringify({ identifier: " 2026 - 001 " }),
  }));
  assert.deepEqual(await response.json(), { loginEmail: "2026-001@students.rizal-arcade.invalid" });
});

test("the browser resolves aliases before sending the password directly to Supabase", () => {
  const auth = readFileSync(new URL("../app/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /fetch\("\/api\/auth\/resolve-login"/);
  assert.match(auth, /body:\s*JSON\.stringify\(\{ identifier \}\)/);
  assert.match(auth, /cleanIdentifier\.includes\("@"\)/);
  assert.match(auth, /signInWithPassword\(\{ email, password \}\)/);
  assert.match(auth, /if \(!profile\.active\)/);
  assert.doesNotMatch(source, /password/);
});

test("the database migration prevents ambiguous case-insensitive roster emails", () => {
  const migration = readFileSync(new URL("../supabase/add_student_email_login.sql", import.meta.url), "utf8");
  assert.match(migration, /create unique index/i);
  assert.match(migration, /lower\(btrim\(roster_email\)\)/i);
  assert.match(migration, /where role = 'student'/i);
});
