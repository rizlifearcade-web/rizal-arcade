import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { SupabaseClient } from "@supabase/supabase-js";

type DatabaseError = { message: string } | null;
type PageResult<T> = { data: T[] | null; error: DatabaseError };

export type SemesterSection = {
  id: string;
  section_code: string;
  school_year: string;
  term: string;
  subject_code: string;
  subject_name: string;
  instructor_name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type SemesterStudent = {
  id: string;
  student_id: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  display_name: string;
  roster_email: string | null;
  course_code: string;
  section_id: string;
  must_change_password: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type SemesterScore = {
  student_id: string;
  section_id: string;
  player_name: string;
  game_id: string;
  score: number;
  achieved_at: string;
};

export type SemesterBadge = {
  student_id: string;
  game_id: string;
  awarded_at: string;
};

export type SemesterSnapshot = {
  schemaVersion: 1;
  semester: { schoolYear: string; term: string };
  sections: SemesterSection[];
  students: SemesterStudent[];
  scores: SemesterScore[];
  badges: SemesterBadge[];
};

export type SnapshotCounts = {
  sections: number;
  students: number;
  scores: number;
  badges: number;
};

export type ArchiveClaims = {
  version: 1;
  schoolYear: string;
  term: string;
  snapshotSha256: string;
  generatedAt: string;
  expiresAt: string;
  counts: SnapshotCounts;
};

const PAGE_SIZE = 1000;
const BADGE_ID_CHUNK = 100;

async function readAll<T>(loadPage: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function compareText(left: string, right: string) {
  return left.localeCompare(right, "en", { numeric: true, sensitivity: "base" });
}

export async function loadSemesterSnapshot(supabase: SupabaseClient, schoolYear: string, term: string): Promise<SemesterSnapshot> {
  const sections = await readAll<SemesterSection>((from, to) => supabase
    .from("rizal_arcade_sections")
    .select("id,section_code,school_year,term,subject_code,subject_name,instructor_name,active,created_at,updated_at")
    .eq("school_year", schoolYear)
    .eq("term", term)
    .range(from, to) as unknown as PromiseLike<PageResult<SemesterSection>>);
  sections.sort((left, right) => compareText(left.section_code, right.section_code) || compareText(left.id, right.id));

  if (!sections.length) {
    return { schemaVersion: 1, semester: { schoolYear, term }, sections: [], students: [], scores: [], badges: [] };
  }

  const sectionIds = sections.map((section) => section.id);
  const students = await readAll<SemesterStudent>((from, to) => supabase
    .from("rizal_arcade_profiles")
    .select("id,student_id,first_name,middle_name,last_name,display_name,roster_email,course_code,section_id,must_change_password,active,created_at,updated_at")
    .eq("role", "student")
    .in("section_id", sectionIds)
    .range(from, to) as unknown as PromiseLike<PageResult<SemesterStudent>>);
  students.sort((left, right) => compareText(left.student_id, right.student_id) || compareText(left.id, right.id));

  const scores = await readAll<SemesterScore>((from, to) => supabase
    .from("rizal_arcade_scores")
    .select("student_id,section_id,player_name,game_id,score,achieved_at")
    .in("section_id", sectionIds)
    .range(from, to) as unknown as PromiseLike<PageResult<SemesterScore>>);
  scores.sort((left, right) => compareText(left.section_id, right.section_id) || compareText(left.student_id, right.student_id) || compareText(left.game_id, right.game_id));

  const badges: SemesterBadge[] = [];
  const studentIds = students.map((student) => student.id);
  for (let index = 0; index < studentIds.length; index += BADGE_ID_CHUNK) {
    const ids = studentIds.slice(index, index + BADGE_ID_CHUNK);
    badges.push(...await readAll<SemesterBadge>((from, to) => supabase
      .from("rizal_arcade_badges")
      .select("student_id,game_id,awarded_at")
      .in("student_id", ids)
      .range(from, to) as unknown as PromiseLike<PageResult<SemesterBadge>>));
  }
  badges.sort((left, right) => compareText(left.student_id, right.student_id) || compareText(left.game_id, right.game_id));

  return { schemaVersion: 1, semester: { schoolYear, term }, sections, students, scores, badges };
}

export function snapshotCounts(snapshot: SemesterSnapshot): SnapshotCounts {
  return {
    sections: snapshot.sections.length,
    students: snapshot.students.length,
    scores: snapshot.scores.length,
    badges: snapshot.badges.length,
  };
}

export function snapshotDigest(snapshot: SemesterSnapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function confirmationPhrase(schoolYear: string, term: string) {
  return `RESET ${schoolYear} ${term}`.toUpperCase();
}

export function semesterSlug(schoolYear: string, term: string) {
  return `${schoolYear}-${term}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "semester";
}

function xml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelColumn(index: number) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

type WorkbookSheet = { name: string; rows: Array<Array<string | number | boolean | null>> };

function worksheetXml(sheet: WorkbookSheet) {
  const columnCount = Math.max(1, ...sheet.rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, column) => Math.min(48, Math.max(12, ...sheet.rows.slice(0, 250).map((row) => String(row[column] ?? "").length + 2))));
  const columns = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
  const rows = sheet.rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const reference = `${excelColumn(columnIndex)}${rowIndex + 1}`;
      const style = rowIndex === 0 ? ' s="1"' : "";
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${reference}"${style}><v>${value}</v></c>`;
      return `<c r="${reference}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const end = `${excelColumn(columnCount - 1)}${Math.max(1, sheet.rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${end}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${end}"/></worksheet>`;
}

function makeWorkbook(snapshot: SemesterSnapshot, generatedAt: string, digest: string) {
  const counts = snapshotCounts(snapshot);
  const sheets: WorkbookSheet[] = [
    {
      name: "Manifest",
      rows: [
        ["Field", "Value"],
        ["Application", "Rizal Arcade"],
        ["School year", snapshot.semester.schoolYear],
        ["Term", snapshot.semester.term],
        ["Generated at (UTC)", generatedAt],
        ["Snapshot SHA-256", digest],
        ["Sections", counts.sections],
        ["Students", counts.students],
        ["Scores", counts.scores],
        ["Badges", counts.badges],
      ],
    },
    {
      name: "Sections",
      rows: [
        ["Section UUID", "Section", "School Year", "Term", "Subject Code", "Subject Name", "Instructor", "Active", "Created At", "Updated At"],
        ...snapshot.sections.map((item) => [item.id, item.section_code, item.school_year, item.term, item.subject_code, item.subject_name, item.instructor_name, item.active, item.created_at, item.updated_at]),
      ],
    },
    {
      name: "Students",
      rows: [
        ["Profile UUID", "Student ID", "First Name", "Middle Name", "Last Name", "Display Name", "Roster Email", "Course", "Section UUID", "Must Change Password", "Active", "Created At", "Updated At"],
        ...snapshot.students.map((item) => [item.id, item.student_id, item.first_name, item.middle_name, item.last_name, item.display_name, item.roster_email, item.course_code, item.section_id, item.must_change_password, item.active, item.created_at, item.updated_at]),
      ],
    },
    {
      name: "Scores",
      rows: [
        ["Student UUID", "Section UUID", "Player Name", "Game", "Best Score", "Achieved At"],
        ...snapshot.scores.map((item) => [item.student_id, item.section_id, item.player_name, item.game_id, item.score, item.achieved_at]),
      ],
    },
    {
      name: "Badges",
      rows: [
        ["Student UUID", "Game", "Awarded At"],
        ...snapshot.badges.map((item) => [item.student_id, item.game_id, item.awarded_at]),
      ],
    },
  ];

  const sheetOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbookRelations = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheetOverrides}</Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Rizal Arcade semester archive</dc:title><dc:creator>Rizal Arcade</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${xml(generatedAt)}</dcterms:created></cp:coreProperties>`),
    "docProps/app.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Rizal Arcade</Application></Properties>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelations}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF061923"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
  };
  sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(worksheetXml(sheet)); });
  return zipSync(files, { level: 6 });
}

export function buildSemesterArchive(snapshot: SemesterSnapshot, generatedAt: string, generatedBy: string) {
  const digest = snapshotDigest(snapshot);
  const counts = snapshotCounts(snapshot);
  const slug = semesterSlug(snapshot.semester.schoolYear, snapshot.semester.term);
  const manifest = {
    application: "Rizal Arcade",
    archiveFormatVersion: 1,
    purpose: "Verified semester data archive created before optional student-data deletion.",
    generatedAt,
    generatedBy,
    semester: snapshot.semester,
    counts,
    snapshotSha256: digest,
    contents: [`rizal-arcade-${slug}-data.xlsx`, "backup.json", "manifest.json"],
    privacyNotice: "This archive contains student information. Store it securely and limit access to authorized school personnel.",
  };
  const archive = zipSync({
    [`rizal-arcade-${slug}-data.xlsx`]: makeWorkbook(snapshot, generatedAt, digest),
    "backup.json": strToU8(JSON.stringify(snapshot, null, 2)),
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  }, { level: 6 });
  return { archive, digest, counts, manifest, fileName: `rizal-arcade-${slug}-archive.zip` };
}

function signingSecret() {
  const value = process.env.SEMESTER_ARCHIVE_SIGNING_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!value) throw new Error("The semester archive signing secret is unavailable.");
  return createHash("sha256").update(`rizal-arcade-semester-archive:${value}`).digest();
}

export function signArchiveClaims(claims: ArchiveClaims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyArchiveClaims(token: string): ArchiveClaims {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("The archive receipt is invalid. Download a fresh archive.");
  const expected = createHmac("sha256", signingSecret()).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, "base64url"); }
  catch { throw new Error("The archive receipt is invalid. Download a fresh archive."); }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("The archive receipt is invalid. Download a fresh archive.");
  let claims: ArchiveClaims;
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ArchiveClaims; }
  catch { throw new Error("The archive receipt is unreadable. Download a fresh archive."); }
  if (claims.version !== 1 || !claims.schoolYear || !claims.term || !claims.snapshotSha256 || Date.parse(claims.expiresAt) <= Date.now()) {
    throw new Error("The archive receipt has expired. Download a fresh archive before resetting.");
  }
  return claims;
}
