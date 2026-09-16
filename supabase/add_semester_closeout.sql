-- Additive semester archive audit and atomic student-data closeout.
-- Run once after the current Rizal Arcade schema and badge migration.
begin;

create table if not exists public.rizal_arcade_semester_closeouts (
  id uuid primary key default gen_random_uuid(),
  school_year text not null,
  term text not null,
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_generated_at timestamptz not null,
  closed_at timestamptz not null default now(),
  closed_by uuid not null references public.rizal_arcade_profiles(id),
  section_count integer not null check (section_count >= 0),
  student_count integer not null check (student_count >= 0),
  score_count integer not null check (score_count >= 0),
  badge_count integer not null check (badge_count >= 0)
);

alter table public.rizal_arcade_semester_closeouts enable row level security;
revoke all on public.rizal_arcade_semester_closeouts from public, anon, authenticated;
grant select on public.rizal_arcade_semester_closeouts to authenticated;

drop policy if exists "Admins read semester closeout audit" on public.rizal_arcade_semester_closeouts;
create policy "Admins read semester closeout audit"
  on public.rizal_arcade_semester_closeouts for select to authenticated
  using (public.is_rizal_arcade_admin());

create or replace function public.close_rizal_arcade_semester(
  p_school_year text,
  p_term text,
  p_archive_sha256 text,
  p_archive_generated_at timestamptz,
  p_closed_by uuid,
  p_expected_sections integer,
  p_expected_students integer,
  p_expected_scores integer,
  p_expected_badges integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_section_ids uuid[] := '{}'::uuid[];
  v_student_ids uuid[] := '{}'::uuid[];
  v_section_count integer := 0;
  v_student_count integer := 0;
  v_score_count integer := 0;
  v_badge_count integer := 0;
  v_closeout_id uuid;
begin
  if not exists (
    select 1 from public.rizal_arcade_profiles
    where id = p_closed_by and role = 'admin' and active
  ) then
    raise exception using errcode = '42501', message = 'An active administrator is required.';
  end if;

  if btrim(coalesce(p_school_year, '')) = '' or btrim(coalesce(p_term, '')) = '' then
    raise exception using errcode = '22023', message = 'School year and term are required.';
  end if;

  -- This transaction-wide lock prevents two closeouts of the same semester from racing.
  perform pg_advisory_xact_lock(hashtextextended(p_school_year || E'\n' || p_term, 0));

  select coalesce(array_agg(id order by id), '{}'::uuid[])
  into v_section_ids
  from public.rizal_arcade_sections
  where school_year = p_school_year and term = p_term;

  select coalesce(array_agg(p.id order by p.id), '{}'::uuid[])
  into v_student_ids
  from public.rizal_arcade_profiles p
  where p.role = 'student' and p.section_id = any(v_section_ids);

  v_section_count := cardinality(v_section_ids);
  v_student_count := cardinality(v_student_ids);
  select count(*)::integer into v_score_count
  from public.rizal_arcade_scores where section_id = any(v_section_ids);
  select count(*)::integer into v_badge_count
  from public.rizal_arcade_badges where student_id = any(v_student_ids);

  if v_section_count <> p_expected_sections
    or v_student_count <> p_expected_students
    or v_score_count <> p_expected_scores
    or v_badge_count <> p_expected_badges then
    raise exception using errcode = '40001', message = 'The semester data changed after the archive was generated.';
  end if;

  if v_section_count = 0 then
    raise exception using errcode = '22023', message = 'No matching semester sections remain.';
  end if;

  -- Deleting Auth users cascades through profiles, scores, and badges. The administrator
  -- and every other non-student account remain untouched.
  delete from auth.users where id = any(v_student_ids);
  delete from public.rizal_arcade_sections where id = any(v_section_ids);

  insert into public.rizal_arcade_semester_closeouts (
    school_year, term, archive_sha256, archive_generated_at, closed_by,
    section_count, student_count, score_count, badge_count
  ) values (
    p_school_year, p_term, p_archive_sha256, p_archive_generated_at, p_closed_by,
    v_section_count, v_student_count, v_score_count, v_badge_count
  ) returning id into v_closeout_id;

  return jsonb_build_object(
    'closeoutId', v_closeout_id,
    'schoolYear', p_school_year,
    'term', p_term,
    'sectionsRemoved', v_section_count,
    'studentsRemoved', v_student_count,
    'scoresRemoved', v_score_count,
    'badgesRemoved', v_badge_count
  );
end;
$$;

revoke all on function public.close_rizal_arcade_semester(text, text, text, timestamptz, uuid, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.close_rizal_arcade_semester(text, text, text, timestamptz, uuid, integer, integer, integer, integer) to service_role;

commit;
