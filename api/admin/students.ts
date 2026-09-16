import { findAuthUserByEmail, handleApiError, json, normalizeStudentId, requireAdmin, studentAuthEmail, temporaryPassword } from "../_lib/supabaseAdmin.js";

type StudentMutation = {
  studentId: string;
  firstName: string;
  middleName: string;
  lastName: string;
  courseCode: string;
  rosterEmail: string | null;
  sectionId: string;
  displayName: string;
};

type StudentProfile = {
  id: string;
  student_id: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  display_name: string;
  roster_email: string | null;
  course_code: string;
  section_id: string;
  active: boolean;
};

function clean(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function studentMutation(body: Record<string, unknown>): StudentMutation {
  const studentId = normalizeStudentId(clean(body.studentId, 50));
  const firstName = clean(body.firstName, 100);
  const middleName = clean(body.middleName, 100);
  const lastName = clean(body.lastName, 100);
  const courseCode = clean(body.courseCode, 50);
  const rosterEmail = clean(body.rosterEmail, 254).toLowerCase() || null;
  const sectionId = clean(body.sectionId, 80);
  if (!studentId || !firstName || !lastName || !courseCode || !sectionId) {
    throw new Response(JSON.stringify({ error: "Student ID, first name, last name, course, and section are required." }), { status: 400 });
  }
  if (rosterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rosterEmail)) {
    throw new Response(JSON.stringify({ error: "Enter a valid roster email or leave it blank." }), { status: 400 });
  }
  const initial = lastName.charAt(0).toUpperCase();
  return { studentId, firstName, middleName, lastName, courseCode, rosterEmail, sectionId, displayName: `${firstName}${initial ? ` ${initial}.` : ""}` };
}

async function requireSection(supabase: Awaited<ReturnType<typeof requireAdmin>>["supabase"], sectionId: string) {
  const { data, error } = await supabase
    .from("rizal_arcade_sections")
    .select("id,section_code,school_year,term,active")
    .eq("id", sectionId)
    .single();
  if (error || !data) throw new Response(JSON.stringify({ error: "The selected section no longer exists." }), { status: 404 });
  if (!data.active) throw new Response(JSON.stringify({ error: "The selected section is inactive." }), { status: 409 });
  return data as { id: string; section_code: string; school_year: string; term: string; active: boolean };
}

function profileValues(student: StudentMutation) {
  return {
    student_id: student.studentId,
    first_name: student.firstName,
    middle_name: student.middleName,
    last_name: student.lastName,
    display_name: student.displayName,
    roster_email: student.rosterEmail,
    course_code: student.courseCode,
    section_id: student.sectionId,
    updated_at: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin(request);
    const student = studentMutation(await request.json() as Record<string, unknown>);
    const section = await requireSection(supabase, student.sectionId);
    const { data: duplicate } = await supabase.from("rizal_arcade_profiles").select("id").eq("student_id", student.studentId).maybeSingle();
    if (duplicate) return json({ error: "That Student ID already exists. Open the existing record and edit it instead." }, 409);

    const password = temporaryPassword();
    const loginEmail = studentAuthEmail(student.studentId);
    const values = { ...profileValues(student), role: "student", active: true, must_change_password: true };
    const { data: created, error: createError } = await supabase.auth.admin.createUser({
      email: loginEmail,
      password,
      email_confirm: true,
      user_metadata: { student_id: student.studentId, display_name: student.displayName },
    });

    let profileId = created.user?.id ?? "";
    if (profileId) {
      const { error } = await supabase.from("rizal_arcade_profiles").insert({ id: profileId, ...values });
      if (error) {
        await supabase.auth.admin.deleteUser(profileId);
        if (error.code === "23505") return json({ error: "That Student ID was added by another request. Refresh the roster." }, 409);
        throw new Error(`The account was rolled back because its profile could not be saved: ${error.message}`);
      }
    } else {
      if (!createError) throw new Error("The student account could not be created.");
      const orphan = await findAuthUserByEmail(supabase, loginEmail);
      if (!orphan) throw new Error(createError.message);
      profileId = orphan.id;
      const { error } = await supabase.from("rizal_arcade_profiles").insert({ id: profileId, ...values });
      if (error) {
        if (error.code === "23505") return json({ error: "That Student ID already exists. Refresh the roster." }, 409);
        throw new Error(error.message);
      }
      const { error: passwordError } = await supabase.auth.admin.updateUserById(profileId, {
        password,
        email: loginEmail,
        email_confirm: true,
        user_metadata: { student_id: student.studentId, display_name: student.displayName },
      });
      if (passwordError) {
        await supabase.from("rizal_arcade_profiles").delete().eq("id", profileId);
        throw new Error(`The profile was rolled back because credentials could not be issued: ${passwordError.message}`);
      }
    }

    return json({
      student: { id: profileId, ...values, section },
      credential: { studentId: student.studentId, displayName: student.displayName, sectionCode: section.section_code, temporaryPassword: password },
      message: `${student.displayName} was added to ${section.section_code}. Download or copy the temporary credential now.`,
    }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase } = await requireAdmin(request);
    const body = await request.json() as Record<string, unknown>;
    const profileId = clean(body.id, 80);
    if (!profileId) return json({ error: "Choose a student record." }, 400);
    const { data: existing, error: existingError } = await supabase
      .from("rizal_arcade_profiles")
      .select("id,student_id,first_name,middle_name,last_name,display_name,roster_email,course_code,section_id,active")
      .eq("id", profileId)
      .eq("role", "student")
      .single();
    if (existingError || !existing) return json({ error: "The student record no longer exists." }, 404);
    const current = existing as StudentProfile;

    if (body.action === "set-active") {
      if (typeof body.active !== "boolean") return json({ error: "Choose whether the student should be active." }, 400);
      const { error } = await supabase.from("rizal_arcade_profiles").update({ active: body.active, updated_at: new Date().toISOString() }).eq("id", profileId).eq("role", "student");
      if (error) throw new Error(error.message);
      return json({ student: { ...current, active: body.active }, message: `${current.display_name} is now ${body.active ? "active and able to sign in" : "inactive and blocked from the arcade"}.` });
    }

    const student = studentMutation(body);
    const section = await requireSection(supabase, student.sectionId);
    const studentIdChanged = student.studentId !== current.student_id;
    if (studentIdChanged) {
      const { data: duplicate } = await supabase.from("rizal_arcade_profiles").select("id").eq("student_id", student.studentId).neq("id", profileId).maybeSingle();
      if (duplicate) return json({ error: "That Student ID belongs to another student." }, 409);
    }

    const oldLoginEmail = studentAuthEmail(current.student_id);
    const newLoginEmail = studentAuthEmail(student.studentId);
    const { error: authError } = await supabase.auth.admin.updateUserById(profileId, {
      ...(studentIdChanged ? { email: newLoginEmail, email_confirm: true } : {}),
      user_metadata: { student_id: student.studentId, display_name: student.displayName },
    });
    if (authError) throw new Error(`The login identity could not be updated: ${authError.message}`);

    const values = profileValues(student);
    const { error: profileError } = await supabase.from("rizal_arcade_profiles").update(values).eq("id", profileId).eq("role", "student");
    if (profileError) {
      await supabase.auth.admin.updateUserById(profileId, {
        ...(studentIdChanged ? { email: oldLoginEmail, email_confirm: true } : {}),
        user_metadata: { student_id: current.student_id, display_name: current.display_name },
      });
      if (profileError.code === "23505") return json({ error: "That Student ID belongs to another student. No changes were saved." }, 409);
      throw new Error(`The profile could not be updated and the login change was rolled back: ${profileError.message}`);
    }

    const { error: scoreError } = await supabase.from("rizal_arcade_scores").update({ section_id: student.sectionId, player_name: student.displayName }).eq("student_id", profileId);
    if (scoreError) {
      await supabase.from("rizal_arcade_profiles").update({
        student_id: current.student_id,
        first_name: current.first_name,
        middle_name: current.middle_name,
        last_name: current.last_name,
        display_name: current.display_name,
        roster_email: current.roster_email,
        course_code: current.course_code,
        section_id: current.section_id,
      }).eq("id", profileId);
      await supabase.auth.admin.updateUserById(profileId, {
        ...(studentIdChanged ? { email: oldLoginEmail, email_confirm: true } : {}),
        user_metadata: { student_id: current.student_id, display_name: current.display_name },
      });
      throw new Error(`The edit was rolled back because leaderboard records could not be updated: ${scoreError.message}`);
    }

    return json({
      student: { id: profileId, ...values, active: current.active, section },
      message: `${student.displayName} was updated.${studentIdChanged ? ` Their sign-in ID is now ${student.studentId}; their password did not change.` : " Their password and progress were preserved."}`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { supabase } = await requireAdmin(request);
    const body = await request.json() as Record<string, unknown>;
    const profileId = clean(body.id, 80);
    const confirmation = normalizeStudentId(clean(body.confirmation, 50));
    if (!profileId || !confirmation) return json({ error: "Choose a student and type their Student ID to confirm deletion." }, 400);
    const { data: profile, error } = await supabase
      .from("rizal_arcade_profiles")
      .select("id,student_id,display_name")
      .eq("id", profileId)
      .eq("role", "student")
      .single();
    if (error || !profile) return json({ error: "The student record no longer exists." }, 404);
    if (confirmation !== normalizeStudentId(profile.student_id)) return json({ error: "The confirmation Student ID does not match." }, 400);

    const [{ count: scoreCount }, { count: badgeCount }] = await Promise.all([
      supabase.from("rizal_arcade_scores").select("student_id", { count: "exact", head: true }).eq("student_id", profileId),
      supabase.from("rizal_arcade_badges").select("student_id", { count: "exact", head: true }).eq("student_id", profileId),
    ]);
    const { error: deleteError } = await supabase.auth.admin.deleteUser(profileId);
    if (deleteError) throw new Error(deleteError.message);
    return json({
      deleted: { id: profileId, studentId: profile.student_id, displayName: profile.display_name, scores: scoreCount ?? 0, badges: badgeCount ?? 0 },
      message: `${profile.display_name} was permanently deleted with ${scoreCount ?? 0} score record${scoreCount === 1 ? "" : "s"} and ${badgeCount ?? 0} badge${badgeCount === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

async function fetchRequest(request: Request) {
  if (request.method === "POST") return POST(request);
  if (request.method === "PATCH") return PATCH(request);
  if (request.method === "DELETE") return DELETE(request);
  return json({ error: "Method not allowed." }, 405);
}

export default { fetch: fetchRequest };

export const config = { maxDuration: 60 };
