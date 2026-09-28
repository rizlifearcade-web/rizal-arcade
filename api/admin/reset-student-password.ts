import { handleApiError, json, normalizeStudentId, requireAdmin, temporaryPassword } from "../_lib/supabaseAdmin.js";

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin(request);
    const body = await request.json() as { profileId?: unknown; studentId?: unknown };
    const profileId = typeof body.profileId === "string" ? body.profileId.trim() : "";
    const studentId = typeof body.studentId === "string" ? normalizeStudentId(body.studentId) : "";
    if (!profileId && !studentId) return json({ error: "Choose a student or enter a Student ID." }, 400);

    let profileQuery = supabase
      .from("rizal_arcade_profiles")
      .select("id,student_id,display_name,active,section_id")
      .eq("role", "student");
    profileQuery = profileId ? profileQuery.eq("id", profileId) : profileQuery.eq("student_id", studentId);
    const { data: profile, error } = await profileQuery.maybeSingle();
    if (error) throw new Error(`The student account lookup failed: ${error.message}`);
    if (!profile) return json({ error: "No student account matches that Student ID." }, 404);

    const { data: section, error: sectionError } = await supabase
      .from("rizal_arcade_sections")
      .select("section_code")
      .eq("id", profile.section_id)
      .maybeSingle();
    if (sectionError) throw new Error(`The student's section could not be loaded: ${sectionError.message}`);

    const password = temporaryPassword();
    const { error: authError } = await supabase.auth.admin.updateUserById(profile.id, { password });
    if (authError) throw new Error(authError.message);
    const { error: profileError } = await supabase.from("rizal_arcade_profiles").update({ must_change_password: true, updated_at: new Date().toISOString() }).eq("id", profile.id);
    if (profileError) throw new Error(profileError.message);
    return json({
      credential: {
        studentId: profile.student_id,
        displayName: profile.display_name,
        sectionCode: section?.section_code ?? "",
        temporaryPassword: password,
      },
      message: `The old password has been replaced. Give this temporary password only to the student.${profile.active === false ? " The account remains inactive until you reactivate it." : ""}`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export default { fetch: POST };
