import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import readXlsxFile from "read-excel-file/node";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../api/_lib/semesterArchive.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const compiledModule = { exports: {} };
new Function("require", "module", "exports", compiled)(require, compiledModule, compiledModule.exports);
const archive = compiledModule.exports;

const snapshot = {
  schemaVersion: 1,
  semester: { schoolYear: "2026-2027", term: "First Semester" },
  sections: [{
    id: "section-1", section_code: "BSIT-1A", school_year: "2026-2027", term: "First Semester",
    subject_code: "RIZLIFE", subject_name: "Life and Works of Rizal", instructor_name: "Prof. Rivera",
    active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
  }],
  students: [{
    id: "student-1", student_id: "2026-001", first_name: "Ada", middle_name: "", last_name: "Santos",
    display_name: "Ada S.", roster_email: "ada@example.edu", course_code: "BSIT", section_id: "section-1",
    must_change_password: false, active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z",
  }],
  scores: [{ student_id: "student-1", section_id: "section-1", player_name: "Ada S.", game_id: "values", score: 900, achieved_at: "2026-09-01T00:00:00.000Z" }],
  badges: [{ student_id: "student-1", game_id: "values", awarded_at: "2026-09-01T00:00:00.000Z" }],
};

test("builds a restorable ZIP with a readable workbook and checksum manifest", async () => {
  const generatedAt = "2026-09-14T01:00:00.000Z";
  const result = archive.buildSemesterArchive(snapshot, generatedAt, "teacher@example.edu");
  assert.match(result.fileName, /^rizal-arcade-2026-2027-first-semester-archive\.zip$/);
  assert.equal(result.digest, archive.snapshotDigest(snapshot));
  assert.deepEqual(result.counts, { sections: 1, students: 1, scores: 1, badges: 1 });

  const files = unzipSync(result.archive);
  assert.ok(files["backup.json"]);
  assert.ok(files["manifest.json"]);
  assert.ok(files["rizal-arcade-2026-2027-first-semester-data.xlsx"]);
  assert.deepEqual(JSON.parse(strFromU8(files["backup.json"])), snapshot);
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(manifest.snapshotSha256, result.digest);
  assert.equal(manifest.generatedBy, "teacher@example.edu");
  assert.equal(manifest.counts.students, 1);

  const workbook = unzipSync(files["rizal-arcade-2026-2027-first-semester-data.xlsx"]);
  assert.ok(workbook["[Content_Types].xml"]);
  assert.ok(workbook["xl/workbook.xml"]);
  assert.ok(workbook["xl/worksheets/sheet3.xml"]);
  assert.match(strFromU8(workbook["xl/workbook.xml"]), /name="Students"/);
  assert.match(strFromU8(workbook["xl/worksheets/sheet3.xml"]), /Ada S\./);
  const parsedWorkbook = await readXlsxFile(Buffer.from(files["rizal-arcade-2026-2027-first-semester-data.xlsx"]), { getSheets: true });
  const studentRows = parsedWorkbook.find((sheet) => sheet.sheet === "Students")?.data;
  assert.equal(studentRows?.[0][1], "Student ID");
  assert.equal(studentRows?.[1][5], "Ada S.");
});

test("signed download receipts bind a reset to one fresh semester snapshot", () => {
  const previousSecret = process.env.SEMESTER_ARCHIVE_SIGNING_SECRET;
  process.env.SEMESTER_ARCHIVE_SIGNING_SECRET = "test-only-secret-that-is-long-and-random";
  try {
    const claims = {
      version: 1,
      schoolYear: snapshot.semester.schoolYear,
      term: snapshot.semester.term,
      snapshotSha256: archive.snapshotDigest(snapshot),
      generatedAt: "2026-09-14T01:00:00.000Z",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      counts: archive.snapshotCounts(snapshot),
    };
    const token = archive.signArchiveClaims(claims);
    assert.deepEqual(archive.verifyArchiveClaims(token), claims);
    const [payload, signature] = token.split(".");
    const tampered = `${payload[0] === "a" ? "b" : "a"}${payload.slice(1)}.${signature}`;
    assert.throws(() => archive.verifyArchiveClaims(tampered), /invalid/i);
    assert.equal(archive.confirmationPhrase("2026-2027", "First Semester"), "RESET 2026-2027 FIRST SEMESTER");
  } finally {
    if (previousSecret === undefined) delete process.env.SEMESTER_ARCHIVE_SIGNING_SECRET;
    else process.env.SEMESTER_ARCHIVE_SIGNING_SECRET = previousSecret;
  }
});

test("the closeout migration deletes only semester students and records an audit", () => {
  const sql = readFileSync(new URL("../supabase/add_semester_closeout.sql", import.meta.url), "utf8");
  assert.match(sql, /delete from auth\.users where id = any\(v_student_ids\)/i);
  assert.match(sql, /delete from public\.rizal_arcade_sections where id = any\(v_section_ids\)/i);
  assert.match(sql, /insert into public\.rizal_arcade_semester_closeouts/i);
  assert.match(sql, /grant execute on function public\.close_rizal_arcade_semester[\s\S]+to service_role/i);
  assert.doesNotMatch(sql, /delete from auth\.users\s*;/i);
});
