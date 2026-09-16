import { confirmationPhrase, loadSemesterSnapshot, snapshotCounts, snapshotDigest, verifyArchiveClaims } from "../_lib/semesterArchive.js";
import { handleApiError, json, requireAdmin } from "../_lib/supabaseAdmin.js";

function scopeValue(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireAdmin(request);
    const body = await request.json() as { schoolYear?: unknown; term?: unknown; confirmation?: unknown; archiveToken?: unknown };
    const schoolYear = scopeValue(body.schoolYear, 30);
    const term = scopeValue(body.term, 30);
    const confirmation = scopeValue(body.confirmation, 100).toUpperCase();
    const archiveToken = scopeValue(body.archiveToken, 4000);
    if (!schoolYear || !term) return json({ error: "Choose a school year and term to close." }, 400);
    if (confirmation !== confirmationPhrase(schoolYear, term)) return json({ error: "The confirmation phrase does not match." }, 400);
    if (!archiveToken) return json({ error: "Download a verified archive before resetting this semester." }, 409);

    let claims;
    try { claims = verifyArchiveClaims(archiveToken); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Download a fresh archive before resetting." }, 409); }
    if (claims.schoolYear !== schoolYear || claims.term !== term) return json({ error: "That archive belongs to a different semester. Download this semester again." }, 409);

    const currentSnapshot = await loadSemesterSnapshot(supabase, schoolYear, term);
    if (!currentSnapshot.sections.length) return json({ error: "This semester no longer has any sections to close." }, 409);
    const currentDigest = snapshotDigest(currentSnapshot);
    if (currentDigest !== claims.snapshotSha256) {
      return json({ error: "The semester data changed after the archive was downloaded. Download a fresh archive before resetting." }, 409);
    }
    const counts = snapshotCounts(currentSnapshot);
    const { data, error } = await supabase.rpc("close_rizal_arcade_semester", {
      p_school_year: schoolYear,
      p_term: term,
      p_archive_sha256: currentDigest,
      p_archive_generated_at: claims.generatedAt,
      p_closed_by: user.id,
      p_expected_sections: counts.sections,
      p_expected_students: counts.students,
      p_expected_scores: counts.scores,
      p_expected_badges: counts.badges,
    });
    if (error) {
      if (error.code === "PGRST202" || /close_rizal_arcade_semester/i.test(error.message) && /schema cache|does not exist/i.test(error.message)) {
        return json({ error: "Semester closeout is not enabled in Supabase yet. Apply the included closeout migration, then try again." }, 409);
      }
      if (/changed after the archive/i.test(error.message)) return json({ error: `${error.message} Download a fresh archive before resetting.` }, 409);
      throw new Error(error.message);
    }

    return json({
      result: data,
      message: `${schoolYear} ${term} was closed. ${counts.students} student account${counts.students === 1 ? "" : "s"} and their related scores and badges were removed.`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export default { fetch: POST };

export const config = { maxDuration: 60 };
