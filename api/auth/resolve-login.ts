import { getAdminClient, handleApiError, json, normalizeStudentId, studentAuthEmail } from "../_lib/supabaseAdmin.js";

const MAX_IDENTIFIER_LENGTH = 254;

function cleanIdentifier(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, MAX_IDENTIFIER_LENGTH) : "";
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { identifier?: unknown };
    const identifier = cleanIdentifier(body.identifier);
    if (!identifier) return json({ error: "Enter your Student ID or email." }, 400);

    if (!identifier.includes("@")) {
      return json({ loginEmail: studentAuthEmail(normalizeStudentId(identifier)) });
    }

    const email = identifier.toLowerCase();
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("rizal_arcade_profiles")
      .select("student_id")
      .eq("role", "student")
      .eq("active", true)
      .ilike("roster_email", email)
      .limit(2);
    if (error) throw new Error(`Student login lookup failed: ${error.message}`);

    // Unknown email addresses are returned unchanged so administrator accounts
    // continue to authenticate normally. Duplicate roster emails intentionally do
    // not resolve; the database migration prevents new duplicates.
    const students = data ?? [];
    const loginEmail = students.length === 1 && students[0]?.student_id
      ? studentAuthEmail(String(students[0].student_id))
      : email;
    return json({ loginEmail });
  } catch (error) {
    return handleApiError(error);
  }
}

export default { fetch: POST };
