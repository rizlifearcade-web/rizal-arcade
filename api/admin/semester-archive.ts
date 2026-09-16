import { buildSemesterArchive, loadSemesterSnapshot, signArchiveClaims } from "../_lib/semesterArchive.js";
import { handleApiError, json, requireAdmin } from "../_lib/supabaseAdmin.js";

function scopeValue(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireAdmin(request);
    const body = await request.json() as { schoolYear?: unknown; term?: unknown };
    const schoolYear = scopeValue(body.schoolYear, 30);
    const term = scopeValue(body.term, 30);
    if (!schoolYear || !term) return json({ error: "Choose a school year and term to archive." }, 400);

    const snapshot = await loadSemesterSnapshot(supabase, schoolYear, term);
    if (!snapshot.sections.length) return json({ error: "No sections were found for that semester." }, 404);
    const generatedAt = new Date().toISOString();
    const result = buildSemesterArchive(snapshot, generatedAt, user.email ?? user.id);
    const claims = {
      version: 1 as const,
      schoolYear,
      term,
      snapshotSha256: result.digest,
      generatedAt,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      counts: result.counts,
    };
    const archiveToken = signArchiveClaims(claims);

    return new Response(Buffer.from(result.archive), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "Content-Type": "application/zip",
        "X-Archive-Token": archiveToken,
        "X-Archive-Expires-At": claims.expiresAt,
        "X-Archive-Sections": String(result.counts.sections),
        "X-Archive-Students": String(result.counts.students),
        "X-Archive-Scores": String(result.counts.scores),
        "X-Archive-Badges": String(result.counts.badges),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export default { fetch: POST };

export const config = { maxDuration: 60 };
