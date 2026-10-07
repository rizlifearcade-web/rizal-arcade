-- Roster email addresses are login aliases and must identify one student only.
-- Blank roster emails remain allowed so Student-ID-only accounts keep working.
create unique index if not exists rizal_arcade_profiles_student_roster_email_unique
  on public.rizal_arcade_profiles (lower(btrim(roster_email)))
  where role = 'student' and roster_email is not null and btrim(roster_email) <> '';
