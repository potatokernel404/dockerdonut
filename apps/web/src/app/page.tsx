"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

type User = { id: string; username: string; role: "admin" | "student" };
type Section = {
  id: string;
  subject: string;
  name: string;
  test_count: number;
};
type Test = {
  id: string;
  section_id: string;
  title: string;
  duration_minutes: number | null;
  subject: string;
  section_name: string;
  question_count: number;
};
type Question = {
  id: string;
  type: "single" | "multiple" | "written";
  prompt: string;
  options: string[];
  points: number;
};
type TestAttempt = {
  attemptId: string;
  startedAt: string;
  test: {
    id: string;
    title: string;
    durationMinutes: number | null;
    questions: Question[];
  };
};
type AttemptResult = {
  status: "graded" | "expired";
  score: number;
  maxScore: number;
  writtenQuestionsNeedReview: boolean;
};
type Analytics = {
  summary: { attempts: number; averagePercentage: number | null };
  attempts: Array<{
    id: string;
    status: string;
    started_at: string;
    submitted_at: string | null;
    score: number | null;
    max_score: number | null;
    test_title: string;
    subject: string;
    section_name: string;
  }>;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const questionExample = JSON.stringify(
  [
    {
      type: "single",
      prompt: "What is 2 + 2?",
      options: ["3", "4", "5"],
      correctAnswers: ["4"],
      points: 1
    },
    {
      type: "multiple",
      prompt: "Select the prime numbers.",
      options: ["2", "4", "5"],
      correctAnswers: ["2", "5"],
      points: 2
    },
    {
      type: "written",
      prompt: "Explain your approach.",
      points: 3
    }
  ],
  null,
  2
);

async function apiRequest<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  let response: Response;
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  try {
    response = await fetch(`${apiUrl}${path}`, {
      ...options,
      credentials: "include",
      headers
    });
  } catch {
    throw new Error("Could not reach the API. Check that the backend is running.");
  }

  const body: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : "The request could not be completed.";
    throw new Error(message);
  }
  return body as T;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sections, setSections] = useState<Section[]>([]);
  const [tests, setTests] = useState<Test[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [activeAttempt, setActiveAttempt] = useState<TestAttempt | null>(null);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const submitLock = useRef(false);

  const [subject, setSubject] = useState("");
  const [sectionName, setSectionName] = useState("");
  const [selectedSection, setSelectedSection] = useState("");
  const [testTitle, setTestTitle] = useState("");
  const [duration, setDuration] = useState("");
  const [questionsJson, setQuestionsJson] = useState(questionExample);
  const [questionFile, setQuestionFile] = useState<File | null>(null);

  const loadDashboard = useCallback(async () => {
    const [sectionData, testData, analyticsData] = await Promise.all([
      apiRequest<{ sections: Section[] }>("/api/sections"),
      apiRequest<{ tests: Test[] }>("/api/tests"),
      apiRequest<Analytics>("/api/analytics/me")
    ]);
    setSections(sectionData.sections);
    setTests(testData.tests);
    setAnalytics(analyticsData);
    setSelectedSection((current) => current || sectionData.sections[0]?.id || "");
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<{ user: User }>("/api/auth/me")
      .then(async ({ user: currentUser }) => {
        if (!active) return;
        setUser(currentUser);
        const [sectionData, testData, analyticsData] = await Promise.all([
          apiRequest<{ sections: Section[] }>("/api/sections"),
          apiRequest<{ tests: Test[] }>("/api/tests"),
          apiRequest<Analytics>("/api/analytics/me")
        ]);
        if (!active) return;
        setSections(sectionData.sections);
        setTests(testData.tests);
        setAnalytics(analyticsData);
        setSelectedSection(sectionData.sections[0]?.id ?? "");
      })
      .catch((sessionError: unknown) => {
        if (!active) return;
        setUser(null);
        if (
          sessionError instanceof Error &&
          !sessionError.message.includes("Please sign in") &&
          !sessionError.message.includes("session has expired")
        ) {
          setError(sessionError.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Something went wrong."
      );
    } finally {
      setBusy(false);
    }
  };

  const onAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction(async () => {
      const { user: signedInUser } = await apiRequest<{ user: User }>(
        `/api/auth/${authMode === "register" ? "register" : "login"}`,
        {
          method: "POST",
          body: JSON.stringify({ username, password })
        }
      );
      setUser(signedInUser);
      setPassword("");
      await loadDashboard();
    });
  };

  const logout = () =>
    runAction(async () => {
      await apiRequest<void>("/api/auth/logout", { method: "POST" });
      setUser(null);
      setSections([]);
      setTests([]);
      setAnalytics(null);
      setActiveAttempt(null);
      setResult(null);
    });

  const createSection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction(async () => {
      const { section } = await apiRequest<{ section: Section }>(
        "/api/admin/sections",
        {
          method: "POST",
          body: JSON.stringify({ subject, name: sectionName })
        }
      );
      setSubject("");
      setSectionName("");
      await loadDashboard();
      setSelectedSection(section.id);
      setNotice("Section created.");
    });
  };

  const createTest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runAction(async () => {
      if (!selectedSection) throw new Error("Create or select a section first.");
      const durationMinutes = duration.trim() ? Number(duration) : null;
      if (questionFile) {
        const contents = await questionFile.text();
        await apiRequest("/api/admin/tests/import", {
          method: "POST",
          body: JSON.stringify({
            sectionId: selectedSection,
            title: testTitle,
            durationMinutes,
            filename: questionFile.name,
            contents
          })
        });
      } else {
        let questions: unknown;
        try {
          questions = JSON.parse(questionsJson);
        } catch {
          throw new Error("Questions are not valid JSON. Correct the JSON or upload a file.");
        }
        await apiRequest("/api/admin/tests", {
          method: "POST",
          body: JSON.stringify({
            sectionId: selectedSection,
            title: testTitle,
            durationMinutes,
            questions
          })
        });
      }
      setTestTitle("");
      setDuration("");
      setQuestionFile(null);
      await loadDashboard();
      setNotice("Mock test created.");
    });
  };

  const submitAttempt = useCallback(
    async (submittedAnswers: Record<string, string | string[]>) => {
      if (!activeAttempt || submitLock.current) return;
      submitLock.current = true;
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const attemptResult = await apiRequest<AttemptResult>(
          `/api/attempts/${activeAttempt.attemptId}/submit`,
          {
            method: "POST",
            body: JSON.stringify({ answers: submittedAnswers })
          }
        );
        setResult(attemptResult);
        setActiveAttempt(null);
        await loadDashboard();
      } catch (submitError) {
        submitLock.current = false;
        setError(
          submitError instanceof Error ? submitError.message : "Could not submit the test."
        );
      } finally {
        setBusy(false);
      }
    },
    [activeAttempt, loadDashboard]
  );

  useEffect(() => {
    if (!activeAttempt?.test.durationMinutes) {
      setRemainingSeconds(null);
      return;
    }

    const deadline =
      new Date(activeAttempt.startedAt).getTime() +
      activeAttempt.test.durationMinutes * 60_000;
    const updateTime = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining === 0) void submitAttempt(answers);
    };
    updateTime();
    const timerId = window.setInterval(updateTime, 1000);
    return () => window.clearInterval(timerId);
  }, [activeAttempt, answers, submitAttempt]);

  const startTest = (testId: string) =>
    runAction(async () => {
      const attempt = await apiRequest<TestAttempt>(`/api/tests/${testId}/start`, {
        method: "POST"
      });
      submitLock.current = false;
      setAnswers({});
      setResult(null);
      setActiveAttempt(attempt);
    });

  const setAnswer = (questionId: string, value: string | string[]) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
  };

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/">Donut<span>Tests</span></a>
        {user ? (
          <div className="account">
            <span>{user.username}{user.role === "admin" ? " · Admin" : ""}</span>
            <button className="button button-quiet" onClick={logout} disabled={busy}>
              Sign out
            </button>
          </div>
        ) : null}
      </header>

      {error ? <div className="message message-error" role="alert">{error}</div> : null}
      {notice ? <div className="message message-success" role="status">{notice}</div> : null}

      {!user ? (
        <section className="auth-layout">
          <div className="intro">
            <p className="eyebrow">YOUR PRACTICE SPACE</p>
            <h1>Prepare with purpose.</h1>
            <p>Take mock tests, track your attempts, and see how your practice adds up.</p>
          </div>
          <form className="panel auth-panel" onSubmit={onAuthSubmit}>
            <div className="tab-row">
              <button
                type="button"
                className={authMode === "login" ? "tab active" : "tab"}
                onClick={() => setAuthMode("login")}
              >
                Sign in
              </button>
              <button
                type="button"
                className={authMode === "register" ? "tab active" : "tab"}
                onClick={() => setAuthMode("register")}
              >
                Create account
              </button>
            </div>
            <h2>{authMode === "login" ? "Welcome back" : "Make your account"}</h2>
            <label>
              Username
              <input
                autoComplete="username"
                minLength={authMode === "register" ? 3 : undefined}
                maxLength={32}
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                minLength={8}
                maxLength={128}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p className="muted small">
              No email verification. Passwords are securely hashed and never stored as plain text.
            </p>
            <button className="button button-primary full-width" disabled={busy}>
              {busy ? "Please wait…" : authMode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        </section>
      ) : activeAttempt ? (
        <section className="content">
          <div className="section-heading">
            <div>
              <p className="eyebrow">MOCK TEST</p>
              <h1>{activeAttempt.test.title}</h1>
            </div>
            {remainingSeconds !== null ? (
              <div className="timer" aria-live="polite">
                {Math.floor(remainingSeconds / 60)}:{String(remainingSeconds % 60).padStart(2, "0")}
              </div>
            ) : <span className="pill">Untimed</span>}
          </div>
          {activeAttempt.test.questions.map((question, index) => {
            const currentAnswer = answers[question.id];
            const selected = Array.isArray(currentAnswer)
              ? currentAnswer
              : currentAnswer
                ? [currentAnswer]
                : [];
            return (
              <article className="panel question-card" key={question.id}>
                <div className="question-heading">
                  <span className="eyebrow">QUESTION {index + 1} · {question.points} PT</span>
                  {question.type === "multiple" ? <span className="muted small">Select all that apply</span> : null}
                </div>
                <h2>{question.prompt}</h2>
                {question.type === "written" ? (
                  <textarea
                    rows={5}
                    maxLength={5000}
                    placeholder="Write your answer…"
                    value={typeof currentAnswer === "string" ? currentAnswer : ""}
                    onChange={(event) => setAnswer(question.id, event.target.value)}
                  />
                ) : (
                  <div className="options">
                    {question.options.map((option) => (
                      <label className="option" key={option}>
                        <input
                          type={question.type === "single" ? "radio" : "checkbox"}
                          name={question.id}
                          checked={selected.includes(option)}
                          onChange={(event) => {
                            if (question.type === "single") {
                              setAnswer(question.id, option);
                            } else {
                              setAnswer(
                                question.id,
                                event.target.checked
                                  ? [...selected, option]
                                  : selected.filter((item) => item !== option)
                              );
                            }
                          }}
                        />
                        <span>{option}</span>
                      </label>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
          <button
            className="button button-primary"
            disabled={busy}
            onClick={() => void submitAttempt(answers)}
          >
            {busy ? "Submitting…" : "Submit mock test"}
          </button>
        </section>
      ) : (
        <section className="content">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{user.role === "admin" ? "ADMIN WORKSPACE" : "YOUR DASHBOARD"}</p>
              <h1>{user.role === "admin" ? "Manage mock tests" : "Choose your next test"}</h1>
            </div>
          </div>

          {result ? (
            <div className={result.status === "expired" ? "result-card expired" : "result-card"}>
              <div>
                <p className="eyebrow">{result.status === "expired" ? "TIME EXPIRED" : "TEST SUBMITTED"}</p>
                <strong>{result.status === "expired" ? "Attempt recorded as expired" : `${result.score} / ${result.maxScore} points`}</strong>
                <p className="muted">
                  {result.writtenQuestionsNeedReview
                    ? "Written responses are saved; only choice questions count toward the automatic score."
                    : result.maxScore === 0
                      ? "This test has no automatically scored questions."
                      : "Your score is included in your practice analytics."}
                </p>
              </div>
              <button className="button button-quiet" onClick={() => setResult(null)}>Dismiss</button>
            </div>
          ) : null}

          <div className="stats-grid">
            <div className="panel stat"><span>Completed attempts</span><strong>{analytics?.summary.attempts ?? 0}</strong></div>
            <div className="panel stat"><span>Overall score</span><strong>
              {analytics?.summary.averagePercentage === null || analytics?.summary.averagePercentage === undefined
                ? "—"
                : `${analytics.summary.averagePercentage}%`}
            </strong></div>
            <div className="panel stat"><span>Available tests</span><strong>{tests.length}</strong></div>
          </div>

          {user.role === "admin" ? (
            <div className="admin-grid">
              <form className="panel form-panel" onSubmit={createSection}>
                <p className="eyebrow">ORGANIZE</p>
                <h2>Create a section</h2>
                <label>Subject<input required maxLength={100} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="e.g. Mathematics" /></label>
                <label>Section name<input required maxLength={100} value={sectionName} onChange={(event) => setSectionName(event.target.value)} placeholder="e.g. Algebra practice" /></label>
                <button className="button button-secondary" disabled={busy}>Create section</button>
              </form>

              <form className="panel form-panel" onSubmit={createTest}>
                <p className="eyebrow">ADD CONTENT</p>
                <h2>Create a mock test</h2>
                <label>Section
                  <select required value={selectedSection} onChange={(event) => setSelectedSection(event.target.value)}>
                    <option value="">Select a section</option>
                    {sections.map((section) => <option key={section.id} value={section.id}>{section.subject} · {section.name}</option>)}
                  </select>
                </label>
                <label>Test title<input required maxLength={150} value={testTitle} onChange={(event) => setTestTitle(event.target.value)} placeholder="e.g. Algebra mock 1" /></label>
                <label>Time limit in minutes <span className="muted">(leave blank for untimed)</span>
                  <input type="number" min={1} max={600} value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="Untimed" />
                </label>
                <label>Upload JSON or CSV
                  <input
                    accept=".json,.csv,application/json,text/csv"
                    type="file"
                    onChange={(event) => setQuestionFile(event.target.files?.[0] ?? null)}
                  />
                </label>
                <label>Or enter questions as JSON<textarea rows={10} value={questionsJson} onChange={(event) => setQuestionsJson(event.target.value)} /></label>
                <p className="muted small">
                  JSON fields: type, prompt, options, correctAnswers, points. Types: single, multiple, written.
                  For CSV, use type,prompt,options,correctAnswers,points; separate option values with |.
                  Written questions are saved but are not automatically scored.
                </p>
                <button className="button button-primary" disabled={busy || sections.length === 0}>
                  {busy ? "Saving…" : "Create mock test"}
                </button>
              </form>
            </div>
          ) : null}

          <div className="section-heading compact">
            <div><p className="eyebrow">PRACTICE</p><h2>Mock tests</h2></div>
          </div>
          {tests.length ? (
            <div className="test-grid">
              {tests.map((test) => (
                <article className="panel test-card" key={test.id}>
                  <div>
                    <span className="pill">{test.subject} · {test.section_name}</span>
                    <h2>{test.title}</h2>
                    <p className="muted">{test.question_count} questions · {test.duration_minutes ? `${test.duration_minutes} min` : "Untimed"}</p>
                  </div>
                  <button className="button button-secondary" disabled={busy} onClick={() => void startTest(test.id)}>
                    Start test
                  </button>
                </article>
              ))}
            </div>
          ) : <div className="empty panel">No mock tests yet. Check back after an admin adds a test.</div>}

          <div className="section-heading compact">
            <div><p className="eyebrow">PROGRESS</p><h2>Past attempts</h2></div>
          </div>
          {analytics?.attempts.length ? (
            <div className="panel history">
              {analytics.attempts.map((attempt) => (
                <div className="history-row" key={attempt.id}>
                  <div><strong>{attempt.test_title}</strong><span className="muted">{attempt.subject} · {formatDate(attempt.started_at)}</span></div>
                  <span className={attempt.status === "expired" ? "pill pill-warn" : "pill"}>
                    {attempt.status === "in_progress" ? "In progress" : attempt.status === "expired" ? "Expired" : `${attempt.score ?? 0} / ${attempt.max_score ?? 0}`}
                  </span>
                </div>
              ))}
            </div>
          ) : <div className="empty panel">Your completed test attempts will appear here.</div>}
        </section>
      )}
    </main>
  );
}
