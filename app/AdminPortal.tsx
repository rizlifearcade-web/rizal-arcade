import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getAccessToken, getSupabaseClient, type ArcadeProfile } from "./auth";
import { loadLeaderboard, type LeaderboardEntry, type LeaderboardGame } from "./leaderboard";
import { parseRosterFile, studentDisplayName, type ParsedRoster } from "./roster";

type Credential = { studentId: string; displayName: string; sectionCode: string; temporaryPassword: string };
type ImportError = { studentId: string; error: string };
type AdminSection = { id: string; section_code: string; school_year: string; term: string };
type SectionStudent = {
  id: string;
  student_id: string;
  display_name: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  course_code: string;
  roster_email: string | null;
  section_id: string;
  must_change_password: boolean;
  active: boolean;
};
type StudentDraft = {
  mode: "create" | "edit";
  id?: string;
  studentId: string;
  firstName: string;
  middleName: string;
  lastName: string;
  courseCode: string;
  rosterEmail: string;
  sectionId: string;
};
type Tab = "roster" | "students" | "leaderboards" | "passwords" | "semester";
type SemesterScope = { key: string; schoolYear: string; term: string; sections: number };
type ArchiveReceipt = {
  scopeKey: string;
  token: string;
  expiresAt: string;
  fileName: string;
  counts: { sections: number; students: number; scores: number; badges: number };
};

const games: Array<{ id: LeaderboardGame; label: string }> = [
  { id: "values", label: "River Quest" },
  { id: "novels", label: "Noli Case Files" },
  { id: "codebreaker", label: "Codebreaker" },
  { id: "scholar", label: "Scholar’s Journey" },
  { id: "hearts", label: "Hearts & Horizons" },
  { id: "museum", label: "Masterpiece Museum" },
  { id: "global", label: "Global Sojourn" },
  { id: "dapitan", label: "Dapitan to Bagumbayan" },
  { id: "revolution", label: "El Fili: Revolution Files" },
  { id: "crossword", label: "Crossword Chronicle" },
];

const adminTabs: Array<{ id: Tab; label: string }> = [
  { id: "roster", label: "Roster import" },
  { id: "students", label: "Section rosters" },
  { id: "leaderboards", label: "Leaderboards" },
  { id: "passwords", label: "Password reset" },
  { id: "semester", label: "Semester closeout" },
];

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadCredentials(credentials: Credential[], sectionCode: string) {
  const rows = [["Student ID", "Display Name", "Section", "Temporary Password"], ...credentials.map((item) => [item.studentId, item.displayName, item.sectionCode, item.temporaryPassword])];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rizal-arcade-credentials-${sectionCode.replace(/[^a-z0-9-]+/gi, "-")}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function adminRequest(path: string, body: unknown, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new Error(`The server returned an unreadable response (${response.status}). Please try again after the latest deployment finishes.`);
  }
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "The admin request failed.");
  return result;
}

function semesterScopeKey(schoolYear: string, term: string) {
  return JSON.stringify([schoolYear, term]);
}

function semesterConfirmation(schoolYear: string, term: string) {
  return `RESET ${schoolYear} ${term}`.toUpperCase();
}

function semesterScopes(sections: AdminSection[]): SemesterScope[] {
  const scopes = new Map<string, SemesterScope>();
  for (const section of sections) {
    const key = semesterScopeKey(section.school_year, section.term);
    const existing = scopes.get(key);
    if (existing) existing.sections += 1;
    else scopes.set(key, { key, schoolYear: section.school_year, term: section.term, sections: 1 });
  }
  return [...scopes.values()].sort((left, right) => right.schoolYear.localeCompare(left.schoolYear, "en", { numeric: true }) || right.term.localeCompare(left.term, "en", { numeric: true }));
}

async function responseError(response: Response) {
  const fallback = `The server could not complete the request (${response.status}).`;
  try {
    const result = await response.json() as { error?: unknown };
    return typeof result.error === "string" ? result.error : fallback;
  } catch { return fallback; }
}

function AdminLeaderboard({ sections }: { sections: AdminSection[] }) {
  const [sectionId, setSectionId] = useState("");
  const [game, setGame] = useState<LeaderboardGame>("values");
  const [result, setResult] = useState<{ key: string; entries: LeaderboardEntry[] }>({ key: "", entries: [] });
  const requestKey = sectionId ? `${sectionId}:${game}` : "";
  const entries = result.key === requestKey ? result.entries : [];
  const loading = Boolean(requestKey && result.key !== requestKey);

  useEffect(() => {
    if (!sectionId) return;
    let active = true;
    const key = `${sectionId}:${game}`;
    loadLeaderboard(game, sectionId).then((board) => { if (active) setResult({ key, entries: board.entries }); });
    return () => { active = false; };
  }, [game, sectionId]);

  return (
    <section className="admin-block">
      <div className="admin-block-heading"><div><p className="eyebrow">Section-only rankings</p><h2>Leaderboards</h2></div></div>
      <div className="admin-filters">
        <label>Section<select value={sectionId} onChange={(event) => setSectionId(event.target.value)}><option value="">Choose a section</option>{sections.map((section) => <option key={section.id} value={section.id}>{section.section_code} · {section.school_year} {section.term}</option>)}</select></label>
        <label>Game<select value={game} onChange={(event) => setGame(event.target.value as LeaderboardGame)}>{games.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      </div>
      <ol className="admin-leaderboard">
        {!sectionId ? <li className="admin-empty">Choose a section to view its board.</li> : loading ? <li className="admin-empty">Loading scores…</li> : entries.length === 0 ? <li className="admin-empty">No scores have been recorded for this game.</li> : entries.map((entry, index) => <li key={`${entry.player_name}-${entry.achieved_at}`}><span>{String(index + 1).padStart(2, "0")}</span><strong>{entry.player_name}</strong><b>{entry.score}</b></li>)}
      </ol>
    </section>
  );
}

function AdminSectionRoster({ sections }: { sections: AdminSection[] }) {
  const [sectionId, setSectionId] = useState("");
  const [students, setStudents] = useState<SectionStudent[]>([]);
  const [loadKey, setLoadKey] = useState("");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [revealed, setRevealed] = useState<Credential | null>(null);
  const [draft, setDraft] = useState<StudentDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SectionStudent | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const mutationInFlight = useRef(false);
  const requestKey = sectionId ? `${sectionId}:${revision}` : "";
  const loading = Boolean(requestKey && loadKey !== requestKey);
  const normalizedSearch = search.trim().toLowerCase();
  const visibleStudents = normalizedSearch ? students.filter((student) => [student.student_id, student.display_name, student.course_code, student.roster_email ?? ""].some((value) => value.toLowerCase().includes(normalizedSearch))) : students;

  useEffect(() => {
    if (!sectionId) return;
    let active = true;
    const key = `${sectionId}:${revision}`;
    getSupabaseClient()
      .from("rizal_arcade_profiles")
      .select("id,student_id,display_name,first_name,middle_name,last_name,course_code,roster_email,section_id,must_change_password,active")
      .eq("section_id", sectionId)
      .eq("role", "student")
      .order("last_name")
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setMessage(`The roster could not be loaded: ${error.message}`);
        else setStudents((data ?? []) as SectionStudent[]);
        setLoadKey(key);
      });
    return () => { active = false; };
  }, [revision, sectionId]);

  function beginCreate() {
    const targetSection = sectionId || sections[0]?.id || "";
    if (!targetSection) { setMessage("Import or create a section before adding a student."); return; }
    setDraft({ mode: "create", studentId: "", firstName: "", middleName: "", lastName: "", courseCode: "", rosterEmail: "", sectionId: targetSection });
    setDeleteTarget(null); setRevealed(null); setMessage("");
  }

  function beginEdit(student: SectionStudent) {
    setDraft({ mode: "edit", id: student.id, studentId: student.student_id, firstName: student.first_name, middleName: student.middle_name, lastName: student.last_name, courseCode: student.course_code, rosterEmail: student.roster_email ?? "", sectionId: student.section_id });
    setDeleteTarget(null); setRevealed(null); setMessage("");
  }

  function updateDraft(field: keyof StudentDraft, value: string) {
    setDraft((current) => current ? { ...current, [field]: value } : current);
  }

  async function saveStudent(event: FormEvent) {
    event.preventDefault();
    if (!draft || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusyId(draft.id ?? "new"); setMessage(""); setRevealed(null);
    try {
      const result = await adminRequest("/api/admin/students", draft, draft.mode === "create" ? "POST" : "PATCH");
      if (result.credential) setRevealed(result.credential as Credential);
      setMessage(typeof result.message === "string" ? result.message : "The student was saved.");
      setSectionId(draft.sectionId); setDraft(null); setRevision((current) => current + 1);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The student could not be saved."); }
    finally { mutationInFlight.current = false; setBusyId(""); }
  }

  async function resetOne(student: SectionStudent) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusyId(student.id); setMessage(""); setRevealed(null);
    try {
      const result = await adminRequest("/api/admin/reset-student-password", { studentId: student.student_id });
      setRevealed(result.credential as Credential);
      setStudents((current) => current.map((item) => (item.id === student.id ? { ...item, must_change_password: true } : item)));
    } catch (error) { setMessage(error instanceof Error ? error.message : "The password could not be reset."); }
    finally { mutationInFlight.current = false; setBusyId(""); }
  }

  async function toggleActive(student: SectionStudent) {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusyId(student.id); setMessage(""); setRevealed(null);
    try {
      const result = await adminRequest("/api/admin/students", { id: student.id, action: "set-active", active: !student.active }, "PATCH");
      setStudents((current) => current.map((item) => item.id === student.id ? { ...item, active: !student.active } : item));
      setMessage(typeof result.message === "string" ? result.message : "The student status was updated.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The student status could not be updated."); }
    finally { mutationInFlight.current = false; setBusyId(""); }
  }

  async function deleteStudent() {
    if (!deleteTarget || mutationInFlight.current) return;
    mutationInFlight.current = true;
    setBusyId(deleteTarget.id); setMessage(""); setRevealed(null);
    try {
      const result = await adminRequest("/api/admin/students", { id: deleteTarget.id, confirmation: deleteConfirmation }, "DELETE");
      setStudents((current) => current.filter((student) => student.id !== deleteTarget.id));
      setMessage(typeof result.message === "string" ? result.message : "The student was permanently deleted.");
      setDeleteTarget(null); setDeleteConfirmation("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The student could not be deleted."); }
    finally { mutationInFlight.current = false; setBusyId(""); }
  }

  async function copyCredential() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(`Student ID: ${revealed.studentId}\nTemporary password: ${revealed.temporaryPassword}`);
      setMessage("The temporary credential was copied. Share it privately with the student.");
    } catch { setMessage("The credential could not be copied automatically. Use the download button instead."); }
  }

  return (
    <section className="admin-block">
      <div className="admin-block-heading"><div><p className="eyebrow">Every student on file</p><h2>Section rosters</h2><p>Add late enrollees, correct student records, control access, and remove confirmed mistakes without re-uploading a full workbook.</p></div><button type="button" className="button button-primary" onClick={beginCreate} disabled={!sections.length || Boolean(busyId)}>Add one student</button></div>
      <div className="admin-filters student-roster-filters">
        <label>Section<select value={sectionId} onChange={(event) => { setSectionId(event.target.value); setDraft(null); setDeleteTarget(null); setRevealed(null); }}><option value="">Choose a section</option>{sections.map((section) => <option key={section.id} value={section.id}>{section.section_code} · {section.school_year} {section.term}</option>)}</select></label>
        <label>Search students<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ID, name, course, or email" /></label>
      </div>
      {draft && <form className="student-editor" onSubmit={saveStudent}>
        <div className="student-editor-heading"><div><p className="eyebrow">{draft.mode === "create" ? "Manual enrollment" : "Correct student record"}</p><h3>{draft.mode === "create" ? "Add one student" : "Edit student"}</h3></div><button type="button" className="text-button" onClick={() => setDraft(null)}>Cancel</button></div>
        <div className="student-editor-grid">
          <label>Student ID<input required value={draft.studentId} onChange={(event) => updateDraft("studentId", event.target.value)} /></label>
          <label>First name<input required value={draft.firstName} onChange={(event) => updateDraft("firstName", event.target.value)} /></label>
          <label>Middle name<input value={draft.middleName} onChange={(event) => updateDraft("middleName", event.target.value)} /></label>
          <label>Last name<input required value={draft.lastName} onChange={(event) => updateDraft("lastName", event.target.value)} /></label>
          <label>Course code<input required value={draft.courseCode} onChange={(event) => updateDraft("courseCode", event.target.value)} /></label>
          <label>Roster email<input type="email" value={draft.rosterEmail} onChange={(event) => updateDraft("rosterEmail", event.target.value)} /></label>
          <label className="student-editor-section">Section<select required value={draft.sectionId} onChange={(event) => updateDraft("sectionId", event.target.value)}>{sections.map((section) => <option key={section.id} value={section.id}>{section.section_code} · {section.school_year} {section.term}</option>)}</select></label>
        </div>
        <p>{draft.mode === "create" ? "A temporary password will be generated and shown once after saving." : "Name and section corrections also update leaderboard records. The current password and progress remain intact."}</p>
        <button type="submit" className="button button-primary" disabled={Boolean(busyId)}>{busyId ? "Saving student…" : draft.mode === "create" ? "Create student account" : "Save student changes"}</button>
      </form>}
      {!sectionId ? <div className="admin-empty-state"><span>#</span><h3>Choose a section</h3><p>Its complete roster and student-management actions will appear here.</p></div> : loading ? <p className="admin-empty">Loading roster…</p> : students.length === 0 ? <div className="admin-empty-state compact"><span>0</span><h3>No students in this section</h3><p>Use “Add one student” for a late enrollee or import the official workbook.</p></div> : visibleStudents.length === 0 ? <p className="admin-empty">No students match “{search.trim()}”.</p> : (
        <div className="roster-table-wrap student-management-table">
          <table>
            <thead><tr><th>Student ID</th><th>Name</th><th>Course</th><th>Roster email</th><th>Status</th><th>Setup</th><th>Actions</th></tr></thead>
            <tbody>
              {visibleStudents.map((student) => <tr key={student.id} className={!student.active ? "is-inactive" : ""}>
                <td>{student.student_id}</td>
                <td>{student.display_name}</td>
                <td>{student.course_code}</td>
                <td>{student.roster_email ?? ""}</td>
                <td><span className={`student-status ${student.active ? "is-active" : ""}`}>{student.active ? "Active" : "Inactive"}</span></td>
                <td>{student.must_change_password ? "Pending first login" : "Completed"}</td>
                <td><div className="student-row-actions"><button type="button" disabled={Boolean(busyId)} onClick={() => beginEdit(student)}>Edit</button><button type="button" disabled={Boolean(busyId)} onClick={() => toggleActive(student)}>{student.active ? "Deactivate" : "Reactivate"}</button><button type="button" disabled={Boolean(busyId)} onClick={() => resetOne(student)}>{busyId === student.id ? "Working…" : "Reset password"}</button><button type="button" className="student-delete-trigger" disabled={Boolean(busyId)} onClick={() => { setDeleteTarget(student); setDeleteConfirmation(""); setDraft(null); setRevealed(null); }}>Delete…</button></div></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      )}
      {deleteTarget && <div className="student-delete-confirmation" role="alert">
        <div><p className="eyebrow">Permanent deletion</p><h3>Delete {deleteTarget.display_name}?</h3><p>This removes the login account, profile, scores, and badges. For withdrawals, cancel and use <strong>Deactivate</strong> instead.</p></div>
        <label>Type <code>{deleteTarget.student_id}</code> to confirm<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} autoComplete="off" /></label>
        <div><button type="button" className="button button-dark" onClick={() => { setDeleteTarget(null); setDeleteConfirmation(""); }} disabled={Boolean(busyId)}>Cancel</button><button type="button" className="button closeout-danger" onClick={deleteStudent} disabled={Boolean(busyId) || deleteConfirmation.trim().toUpperCase().replace(/\s+/g, "") !== deleteTarget.student_id.trim().toUpperCase().replace(/\s+/g, "")}>{busyId ? "Deleting…" : "Permanently delete student"}</button></div>
      </div>}
      {revealed && <div className="credential-result single-credential"><div><p className="eyebrow">Shown only this time</p><h3>{revealed.displayName}</h3><p>Give this credential only to the student.</p></div><div className="credential-actions"><button type="button" className="button button-dark" onClick={copyCredential}>Copy credential</button><button type="button" className="button button-dark" onClick={() => downloadCredentials([revealed], revealed.sectionCode)}>Download CSV</button></div><div className="reset-result"><span>Student ID</span><strong>{revealed.studentId}</strong><code>{revealed.temporaryPassword}</code></div></div>}
      {message && <p className="admin-message" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}

function SemesterCloseout({ sections, onClosed }: { sections: AdminSection[]; onClosed: (schoolYear: string, term: string) => void }) {
  const scopes = useMemo(() => semesterScopes(sections), [sections]);
  const [scopeKey, setScopeKey] = useState(scopes[0]?.key ?? "");
  const [receipt, setReceipt] = useState<ArchiveReceipt | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busyAction, setBusyAction] = useState<"download" | "close" | "">("");
  const [message, setMessage] = useState("");
  const scope = scopes.find((item) => item.key === scopeKey) ?? scopes[0];
  const expectedConfirmation = scope ? semesterConfirmation(scope.schoolYear, scope.term) : "";
  const archiveReady = Boolean(scope && receipt?.scopeKey === scope.key && acknowledged && confirmation.trim().toUpperCase() === expectedConfirmation);

  function chooseScope(nextKey: string) {
    setScopeKey(nextKey);
    setReceipt(null);
    setAcknowledged(false);
    setConfirmation("");
    setMessage("");
  }

  async function downloadArchive() {
    if (!scope || busyAction) return;
    setBusyAction("download"); setMessage("");
    try {
      const response = await fetch("/api/admin/semester-archive", {
        method: "POST",
        headers: { Authorization: `Bearer ${await getAccessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ schoolYear: scope.schoolYear, term: scope.term }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const token = response.headers.get("X-Archive-Token") ?? "";
      const expiresAt = response.headers.get("X-Archive-Expires-At") ?? "";
      if (!token || !expiresAt) throw new Error("The download did not include a verified archive receipt. Please try again.");
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] ?? "rizal-arcade-semester-archive.zip";
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      const counts = {
        sections: Number(response.headers.get("X-Archive-Sections") ?? 0),
        students: Number(response.headers.get("X-Archive-Students") ?? 0),
        scores: Number(response.headers.get("X-Archive-Scores") ?? 0),
        badges: Number(response.headers.get("X-Archive-Badges") ?? 0),
      };
      setReceipt({ scopeKey: scope.key, token, expiresAt, fileName, counts });
      setAcknowledged(false); setConfirmation("");
      setMessage("Archive downloaded. Open the ZIP and verify the Excel workbook before acknowledging the reset.");
    } catch (error) { setReceipt(null); setMessage(error instanceof Error ? error.message : "The archive could not be downloaded."); }
    finally { setBusyAction(""); }
  }

  async function closeSemester() {
    if (!scope || !receipt || !archiveReady || busyAction) return;
    if (!window.confirm(`Permanently delete ${receipt.counts.students} student account${receipt.counts.students === 1 ? "" : "s"} and all related game data for ${scope.schoolYear} ${scope.term}?`)) return;
    setBusyAction("close"); setMessage("");
    try {
      const result = await adminRequest("/api/admin/close-semester", {
        schoolYear: scope.schoolYear,
        term: scope.term,
        confirmation,
        archiveToken: receipt.token,
      });
      setMessage(typeof result.message === "string" ? result.message : "The semester was closed.");
      setReceipt(null); setAcknowledged(false); setConfirmation("");
      onClosed(scope.schoolYear, scope.term);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The semester could not be closed."); }
    finally { setBusyAction(""); }
  }

  return (
    <section className="admin-block semester-closeout">
      <div className="admin-block-heading"><div><p className="eyebrow">Verified data handoff</p><h2>Semester closeout</h2><p>Download a complete copy whenever you need it. Permanent reset stays locked until a fresh archive has been delivered and acknowledged.</p></div></div>
      {scope ? <>
        <div className="admin-filters semester-picker">
          <label>Semester<select value={scope.key} onChange={(event) => chooseScope(event.target.value)}>{scopes.map((item) => <option key={item.key} value={item.key}>{item.schoolYear} · {item.term} · {item.sections} section{item.sections === 1 ? "" : "s"}</option>)}</select></label>
        </div>
        <div className="closeout-grid">
          <article className="archive-card">
            <span className="closeout-step">Available anytime</span>
            <h3>Download current data</h3>
            <p>Create a new ZIP containing an Excel workbook, restoration JSON, checksum manifest, and counts for every section in this semester.</p>
            <button type="button" className="button button-dark" onClick={downloadArchive} disabled={Boolean(busyAction)}>{busyAction === "download" ? "Building verified archive…" : "Download verified archive"}</button>
            {receipt?.scopeKey === scope.key && <div className="archive-receipt" role="status">
              <strong>Download ready</strong><span>{receipt.fileName}</span>
              <dl><div><dt>Students</dt><dd>{receipt.counts.students}</dd></div><div><dt>Scores</dt><dd>{receipt.counts.scores}</dd></div><div><dt>Badges</dt><dd>{receipt.counts.badges}</dd></div></dl>
              <small>Reset receipt expires {new Date(receipt.expiresAt).toLocaleString()}.</small>
            </div>}
          </article>
          <article className="reset-card">
            <span className="closeout-step">Permanent action</span>
            <h3>Reset student data</h3>
            <p>Removes this semester’s student sign-ins, profiles, scores, badges, and empty section records. Administrator accounts, games, and other semesters are preserved.</p>
            {!receipt || receipt.scopeKey !== scope.key ? <p className="reset-locked">Download this semester’s archive to unlock reset.</p> : <div className="closeout-confirmation">
              <label className="archive-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I opened the downloaded ZIP, verified the Excel workbook, and stored the archive securely.</span></label>
              <label>Type <code>{expectedConfirmation}</code> to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            </div>}
            <button type="button" className="button closeout-danger" onClick={closeSemester} disabled={!archiveReady || Boolean(busyAction)}>{busyAction === "close" ? "Closing semester…" : "Close semester and delete student data"}</button>
          </article>
        </div>
      </> : <div className="admin-empty-state"><span>0</span><h3>No semester data yet</h3><p>Import at least one section before creating an archive or closing a semester.</p></div>}
      {message && <p className="admin-message" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}

export default function AdminPortal({ profile, onClose, onSignOut }: { profile: ArcadeProfile; onClose: () => void; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>("roster");
  const [roster, setRoster] = useState<ParsedRoster | null>(null);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [importErrors, setImportErrors] = useState<ImportError[]>([]);
  const [regeneratePendingPasswords, setRegeneratePendingPasswords] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetStudentId, setResetStudentId] = useState("");
  const [resetCredential, setResetCredential] = useState<Credential | null>(null);
  const [sections, setSections] = useState<AdminSection[]>([]);

  useEffect(() => {
    let active = true;
    getSupabaseClient().from("rizal_arcade_sections").select("id,section_code,school_year,term").order("school_year", { ascending: false }).order("section_code").then(({ data }) => {
      if (active) setSections((data ?? []) as AdminSection[]);
    });
    return () => { active = false; };
  }, [credentials.length]);

  async function chooseFile(file?: File) {
    if (!file) return;
    setBusy(true); setMessage(""); setCredentials([]); setImportErrors([]);
    try { setRoster(await parseRosterFile(file)); }
    catch (error) { setRoster(null); setMessage(error instanceof Error ? error.message : "The spreadsheet could not be read."); }
    finally { setBusy(false); }
  }

  async function importRoster() {
    if (!roster || busy) return;
    setBusy(true); setMessage(""); setImportErrors([]);
    try {
      const { fileName: _fileName, ...payload } = roster;
      void _fileName;
      const result = await adminRequest("/api/admin/import-roster", { ...payload, regeneratePendingPasswords });
      const nextCredentials = Array.isArray(result.credentials) ? result.credentials as Credential[] : [];
      const nextErrors = Array.isArray(result.errors) ? result.errors as ImportError[] : [];
      setCredentials(nextCredentials);
      setImportErrors(nextErrors);
      setMessage(typeof result.message === "string" ? result.message : "Roster imported.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The roster could not be imported.");
    } finally { setBusy(false); }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage(""); setResetCredential(null);
    try {
      const result = await adminRequest("/api/admin/reset-student-password", { studentId: resetStudentId });
      setResetCredential(result.credential as Credential);
      setMessage(typeof result.message === "string" ? result.message : "Password reset.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "The password could not be reset."); }
    finally { setBusy(false); }
  }

  return (
    <main className="admin-page">
      <header className="admin-header"><a className="brand" href="#top" onClick={(event) => { event.preventDefault(); onClose(); }}><span className="brand-mark">RA</span><span>Rizal Arcade</span><small>Admin</small></a><div><span>{profile.display_name}</span><button type="button" onClick={onClose}>View arcade</button><button type="button" onClick={onSignOut}>Sign out</button></div></header>
      <div className="admin-shell">
        <aside><p className="eyebrow">Classroom control</p><h1>Admin desk</h1><label className="admin-mobile-nav">Admin section<select value={tab} onChange={(event) => setTab(event.target.value as Tab)}>{adminTabs.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><nav aria-label="Admin sections">{adminTabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} type="button" onClick={() => setTab(item.id)}>{item.label}</button>)}</nav><div className="admin-scope"><strong>Current scope</strong><span>One administrator</span><span>{sections.length} imported section{sections.length === 1 ? "" : "s"}</span></div></aside>
        <div className="admin-workspace">
          {tab === "roster" && <section className="admin-block">
            <div className="admin-block-heading"><div><p className="eyebrow">Enrollment spreadsheet</p><h2>Import a section.</h2><p>One Excel file equals one leaderboard section. Course-code differences inside the roster do not split it.</p></div><label className="upload-button">Choose .xlsx<input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => chooseFile(event.target.files?.[0])} /></label></div>
            {roster ? <div className="roster-preview"><div className="roster-summary"><span><small>Section</small><strong>{roster.sectionCode}</strong></span><span><small>School year</small><strong>{roster.schoolYear}</strong></span><span><small>Term</small><strong>{roster.term}</strong></span><span><small>Students</small><strong>{roster.students.length}</strong></span></div><div className="roster-table-wrap"><table><thead><tr><th>Student ID</th><th>Leaderboard name</th><th>Course</th><th>Roster email</th></tr></thead><tbody>{roster.students.slice(0, 8).map((student) => <tr key={student.studentId}><td>{student.studentId}</td><td>{studentDisplayName(student)}</td><td>{student.courseCode}</td><td>{student.email}</td></tr>)}</tbody></table>{roster.students.length > 8 && <p>Plus {roster.students.length - 8} more students in this file.</p>}</div><label className="regen-toggle"><input type="checkbox" checked={regeneratePendingPasswords} onChange={(event) => setRegeneratePendingPasswords(event.target.checked)} /><span>Re-import this section: generate a fresh password for anyone who hasn’t logged in yet.<br />Only check this if credentials were lost or an earlier import was interrupted — every temporary password already given to a student is invalidated the moment you check this box and import again.</span></label><button className="button button-primary" type="button" onClick={importRoster} disabled={busy}>{busy ? "Importing accounts…" : `Create or update ${roster.students.length} accounts`}</button></div> : <div className="admin-empty-state"><span>XL</span><h3>Upload the official enrollment file</h3><p>The section, term, instructor, Student IDs, names, course codes, and emails will be read automatically.</p></div>}
            {importErrors.length > 0 && <div className="import-error-list"><p className="eyebrow">{importErrors.length} row{importErrors.length === 1 ? "" : "s"} failed</p><ul>{importErrors.map((item) => <li key={item.studentId}><strong>{item.studentId}</strong> {item.error}</li>)}</ul><p>Everyone else in the file above was still saved — fix these rows and re-import just this same file; already-saved students will be safely skipped.</p></div>}
            {credentials.length > 0 && <div className="credential-result"><div><p className="eyebrow">Shown only after creation</p><h3>{credentials.length} new credentials</h3><p>Download these now and distribute each row privately.</p></div><button type="button" className="button button-dark" onClick={() => downloadCredentials(credentials, roster?.sectionCode ?? "section")}>Download credential CSV</button><div className="credential-table"><table><thead><tr><th>Student ID</th><th>Name</th><th>Temporary password</th></tr></thead><tbody>{credentials.map((item) => <tr key={item.studentId}><td>{item.studentId}</td><td>{item.displayName}</td><td><code>{item.temporaryPassword}</code></td></tr>)}</tbody></table></div></div>}
          </section>}
          {tab === "students" && <AdminSectionRoster sections={sections} />}
          {tab === "leaderboards" && <AdminLeaderboard sections={sections} />}
          {tab === "passwords" && <section className="admin-block"><div className="admin-block-heading"><div><p className="eyebrow">Account recovery</p><h2>Reset one student.</h2><p>This invalidates the old password and requires another password change after sign-in.</p></div></div><form className="reset-form" onSubmit={resetPassword}><label>Student ID<input value={resetStudentId} onChange={(event) => setResetStudentId(event.target.value)} /></label><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Resetting…" : "Generate temporary password"}</button></form>{resetCredential && <div className="reset-result"><span>{resetCredential.displayName}</span><strong>{resetCredential.studentId}</strong><code>{resetCredential.temporaryPassword}</code></div>}</section>}
          {tab === "semester" && <SemesterCloseout sections={sections} onClosed={(schoolYear, term) => setSections((current) => current.filter((section) => section.school_year !== schoolYear || section.term !== term))} />}
          {message && <p className="admin-message" role="status">{message}</p>}
        </div>
      </div>
    </main>
  );
}
