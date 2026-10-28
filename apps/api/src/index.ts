import bcrypt from "bcryptjs";
import cors from "cors";
import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { parse as parseCsv } from "csv-parse/sync";
import { database, seedAdmin } from "./database.js";

type UserRole = "admin" | "student";
type QuestionType = "single" | "multiple" | "written";

interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

interface QuestionInput {
  type: QuestionType;
  prompt: string;
  options: string[];
  correctAnswers: string[];
  points: number;
}

interface StoredQuestion extends QuestionInput {
  id: string;
  position: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const app = express();
const port = Number(process.env.PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const authSecret = process.env.AUTH_SECRET;
const cookieName = "dockerdonut_session";
const cookieLifetime = 7 * 24 * 60 * 60 * 1000;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}
if (!authSecret || authSecret.length < 32) {
  throw new Error("Set AUTH_SECRET to a random secret of at least 32 characters.");
}

app.use(cors({ origin: webOrigin, credentials: true }));
app.use(express.json({ limit: "5mb" }));

app.use((request, response, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.get("origin");
    if (origin && origin !== webOrigin) {
      response.status(403).json({ error: "Request origin is not allowed." });
      return;
    }
  }
  next();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number
): string {
  if (typeof value !== "string") {
    throw new ApiError(400, `${field} is required.`);
  }
  const result = value.trim();
  if (result.length < minLength || result.length > maxLength) {
    throw new ApiError(400, `${field} must be ${minLength}-${maxLength} characters.`);
  }
  return result;
}

function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const cookie = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : undefined;
}

function setSessionCookie(response: Response, user: AuthUser): void {
  const token = jwt.sign({ sub: user.id }, authSecret!, { expiresIn: "7d" });
  response.cookie(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: cookieLifetime
  });
}

function requireUser(request: Request, response: Response, next: NextFunction): void {
  const token = readCookie(request, cookieName);
  if (!token) {
    response.status(401).json({ error: "Please sign in to continue." });
    return;
  }

  let userId: string;
  try {
    const payload = jwt.verify(token, authSecret!);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      throw new Error("Invalid session token.");
    }
    userId = payload.sub;
  } catch {
    response.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/" });
    response.status(401).json({ error: "Your session has expired. Please sign in again." });
    return;
  }

  const user = database
    .prepare("SELECT id, username, role FROM users WHERE id = ?")
    .get(userId) as AuthUser | undefined;

  if (!user) {
    response.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/" });
    response.status(401).json({ error: "Your account is no longer available." });
    return;
  }

  request.user = user;
  next();
}

function requireAdmin(request: Request, response: Response, next: NextFunction): void {
  if (request.user?.role !== "admin") {
    response.status(403).json({ error: "Admin access is required." });
    return;
  }
  next();
}

function parseQuestion(value: unknown, index: number): QuestionInput {
  if (!isRecord(value)) {
    throw new ApiError(400, `Question ${index + 1} must be an object.`);
  }

  const type = value.type;
  if (type !== "single" && type !== "multiple" && type !== "written") {
    throw new ApiError(400, `Question ${index + 1} has an unsupported type.`);
  }

  const prompt = requiredString(value.prompt, `Question ${index + 1} prompt`, 1, 2000);
  const options = Array.isArray(value.options)
    ? value.options.map((option) => requiredString(option, "Option", 1, 500))
    : [];
  const correctAnswers = Array.isArray(value.correctAnswers)
    ? value.correctAnswers.map((answer) => requiredString(answer, "Correct answer", 1, 500))
    : [];
  const points = value.points === undefined ? 1 : value.points;

  if (!Number.isInteger(points) || (points as number) < 1 || (points as number) > 1000) {
    throw new ApiError(400, `Question ${index + 1} points must be an integer from 1 to 1000.`);
  }
  if (type === "written") {
    if (options.length || correctAnswers.length) {
      throw new ApiError(400, `Written question ${index + 1} cannot have options or correct answers.`);
    }
  } else {
    if (options.length < 2 || new Set(options).size !== options.length) {
      throw new ApiError(400, `Question ${index + 1} needs at least two unique options.`);
    }
    if (!correctAnswers.length || correctAnswers.some((answer) => !options.includes(answer))) {
      throw new ApiError(400, `Question ${index + 1} needs valid correct answers from its options.`);
    }
    if (type === "single" && correctAnswers.length !== 1) {
      throw new ApiError(400, `Single-choice question ${index + 1} must have exactly one correct answer.`);
    }
  }

  return { type, prompt, options, correctAnswers, points: points as number };
}

function getQuestions(testId: string): StoredQuestion[] {
  const rows = database
    .prepare(
      `SELECT id, position, type, prompt, options_json, correct_answers_json, points
       FROM questions WHERE test_id = ? ORDER BY position`
    )
    .all(testId) as Array<{
    id: string;
    position: number;
    type: QuestionType;
    prompt: string;
    options_json: string;
    correct_answers_json: string;
    points: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    type: row.type,
    prompt: row.prompt,
    options: JSON.parse(row.options_json) as string[],
    correctAnswers: JSON.parse(row.correct_answers_json) as string[],
    points: row.points
  }));
}

function publicQuestion(question: StoredQuestion) {
  return {
    id: question.id,
    type: question.type,
    prompt: question.prompt,
    options: question.options,
    points: question.points
  };
}

function insertTest(
  sectionId: string,
  title: string,
  durationMinutes: number | null,
  questions: QuestionInput[]
): string {
  const testId = randomUUID();
  const insertTestRow = database.prepare(
    "INSERT INTO tests (id, section_id, title, duration_minutes) VALUES (?, ?, ?, ?)"
  );
  const insertQuestion = database.prepare(
    `INSERT INTO questions (id, test_id, position, type, prompt, options_json, correct_answers_json, points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const create = database.transaction(() => {
    insertTestRow.run(testId, sectionId, title, durationMinutes);
    questions.forEach((question, position) => {
      insertQuestion.run(
        randomUUID(),
        testId,
        position,
        question.type,
        question.prompt,
        JSON.stringify(question.options),
        JSON.stringify(question.correctAnswers),
        question.points
      );
    });
  });

  create();
  return testId;
}

function parseImportedQuestions(filename: string, contents: string): QuestionInput[] {
  if (!contents.trim() || contents.length > 4_000_000) {
    throw new ApiError(400, "The question file is empty or too large.");
  }

  let rows: unknown[];
  if (filename.toLowerCase().endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new ApiError(400, "The JSON question file could not be parsed.");
    }
    rows = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.questions)
        ? parsed.questions
        : [];
  } else if (filename.toLowerCase().endsWith(".csv")) {
    try {
      const csvRows = parseCsv(contents, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      }) as Array<Record<string, string>>;
      rows = csvRows.map((row) => ({
        type: row.type,
        prompt: row.prompt,
        options: row.options ? row.options.split("|").map((item) => item.trim()) : [],
        correctAnswers: row.correctAnswers
          ? row.correctAnswers.split("|").map((item) => item.trim())
          : [],
        points: row.points ? Number(row.points) : 1
      }));
    } catch (error) {
      throw new ApiError(400, `The CSV question file could not be parsed: ${String(error)}`);
    }
  } else {
    throw new ApiError(400, "Upload a .json or .csv question file.");
  }

  if (!rows.length || rows.length > 500) {
    throw new ApiError(400, "A mock test must contain between 1 and 500 questions.");
  }
  return rows.map((row, index) => parseQuestion(row, index));
}

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/auth/register", async (request, response) => {
  if (!isRecord(request.body)) throw new ApiError(400, "A request body is required.");
  const username = requiredString(request.body.username, "Username", 3, 32);
  const password = request.body.password;
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new ApiError(400, "Username can contain only letters, numbers, underscores, and hyphens.");
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    throw new ApiError(400, "Password must be 8-128 characters.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user: AuthUser = { id: randomUUID(), username, role: "student" };
  try {
    database
      .prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)")
      .run(user.id, user.username, passwordHash, user.role);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new ApiError(409, "That username is already taken.");
    }
    throw error;
  }
  setSessionCookie(response, user);
  response.status(201).json({ user });
});

app.post("/api/auth/login", async (request, response) => {
  if (!isRecord(request.body)) throw new ApiError(400, "A request body is required.");
  const username = requiredString(request.body.username, "Username", 1, 32);
  const password = request.body.password;
  if (typeof password !== "string" || password.length > 128) {
    throw new ApiError(400, "Username or password is incorrect.");
  }
  const row = database
    .prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?")
    .get(username) as (AuthUser & { password_hash: string }) | undefined;
  if (!row || !(await bcrypt.compare(password, row.password_hash))) {
    throw new ApiError(401, "Username or password is incorrect.");
  }

  const user: AuthUser = { id: row.id, username: row.username, role: row.role };
  setSessionCookie(response, user);
  response.json({ user });
});

app.post("/api/auth/logout", (_request, response) => {
  response.clearCookie(cookieName, { httpOnly: true, sameSite: "lax", path: "/" });
  response.status(204).end();
});

app.get("/api/auth/me", requireUser, (request, response) => {
  response.json({ user: request.user });
});

app.get("/api/sections", requireUser, (_request, response) => {
  const sections = database
    .prepare(
      `SELECT s.id, s.subject, s.name, s.created_at,
              COUNT(t.id) AS test_count
       FROM sections s LEFT JOIN tests t ON t.section_id = s.id
       GROUP BY s.id ORDER BY s.subject, s.name`
    )
    .all();
  response.json({ sections });
});

app.post("/api/admin/sections", requireUser, requireAdmin, (request, response) => {
  if (!isRecord(request.body)) throw new ApiError(400, "A request body is required.");
  const subject = requiredString(request.body.subject, "Subject", 1, 100);
  const name = requiredString(request.body.name, "Section name", 1, 100);
  const id = randomUUID();
  database
    .prepare("INSERT INTO sections (id, subject, name) VALUES (?, ?, ?)")
    .run(id, subject, name);
  response.status(201).json({ section: { id, subject, name, test_count: 0 } });
});

app.get("/api/tests", requireUser, (_request, response) => {
  const tests = database
    .prepare(
      `SELECT t.id, t.section_id, t.title, t.duration_minutes, t.created_at,
              s.subject, s.name AS section_name, COUNT(q.id) AS question_count
       FROM tests t
       JOIN sections s ON s.id = t.section_id
       JOIN questions q ON q.test_id = t.id
       GROUP BY t.id ORDER BY t.created_at DESC`
    )
    .all();
  response.json({ tests });
});

app.post("/api/admin/tests", requireUser, requireAdmin, (request, response) => {
  if (!isRecord(request.body)) throw new ApiError(400, "A request body is required.");
  const sectionId = requiredString(request.body.sectionId, "Section", 1, 100);
  const title = requiredString(request.body.title, "Test title", 1, 150);
  const durationMinutes = request.body.durationMinutes;
  if (
    durationMinutes !== null &&
    durationMinutes !== undefined &&
    (!Number.isInteger(durationMinutes) || (durationMinutes as number) < 1 || (durationMinutes as number) > 600)
  ) {
    throw new ApiError(400, "Duration must be between 1 and 600 minutes, or empty for untimed.");
  }
  const rawQuestions = request.body.questions;
  if (!Array.isArray(rawQuestions) || !rawQuestions.length || rawQuestions.length > 500) {
    throw new ApiError(400, "A mock test must contain between 1 and 500 questions.");
  }
  const questions = rawQuestions.map((question, index) => parseQuestion(question, index));
  const section = database.prepare("SELECT id FROM sections WHERE id = ?").get(sectionId);
  if (!section) throw new ApiError(404, "Section not found.");
  const testId = insertTest(
    sectionId,
    title,
    typeof durationMinutes === "number" ? durationMinutes : null,
    questions
  );
  response.status(201).json({ testId });
});

app.post("/api/admin/tests/import", requireUser, requireAdmin, (request, response) => {
  if (!isRecord(request.body)) throw new ApiError(400, "A request body is required.");
  const sectionId = requiredString(request.body.sectionId, "Section", 1, 100);
  const title = requiredString(request.body.title, "Test title", 1, 150);
  const filename = requiredString(request.body.filename, "Filename", 1, 255);
  const contents = request.body.contents;
  if (typeof contents !== "string") throw new ApiError(400, "Question file contents are required.");

  const durationMinutes = request.body.durationMinutes;
  if (
    durationMinutes !== null &&
    durationMinutes !== undefined &&
    (!Number.isInteger(durationMinutes) || (durationMinutes as number) < 1 || (durationMinutes as number) > 600)
  ) {
    throw new ApiError(400, "Duration must be between 1 and 600 minutes, or empty for untimed.");
  }
  const section = database.prepare("SELECT id FROM sections WHERE id = ?").get(sectionId);
  if (!section) throw new ApiError(404, "Section not found.");

  const questions = parseImportedQuestions(filename, contents);
  const testId = insertTest(
    sectionId,
    title,
    typeof durationMinutes === "number" ? durationMinutes : null,
    questions
  );
  response.status(201).json({ testId, questionCount: questions.length });
});

app.post("/api/tests/:testId/start", requireUser, (request, response) => {
  const test = database
    .prepare("SELECT id, title, duration_minutes FROM tests WHERE id = ?")
    .get(request.params.testId) as
    | { id: string; title: string; duration_minutes: number | null }
    | undefined;
  if (!test) throw new ApiError(404, "Mock test not found.");

  const questions = getQuestions(test.id);
  const attemptId = randomUUID();
  const startedAt = new Date().toISOString();
  database
    .prepare(
      "INSERT INTO attempts (id, user_id, test_id, started_at, status) VALUES (?, ?, ?, ?, 'in_progress')"
    )
    .run(attemptId, request.user!.id, test.id, startedAt);

  response.status(201).json({
    attemptId,
    startedAt,
    test: {
      id: test.id,
      title: test.title,
      durationMinutes: test.duration_minutes,
      questions: questions.map(publicQuestion)
    }
  });
});

app.post("/api/attempts/:attemptId/submit", requireUser, (request, response) => {
  if (!isRecord(request.body) || !isRecord(request.body.answers)) {
    throw new ApiError(400, "Answers must be provided as an object keyed by question ID.");
  }

  const attempt = database
    .prepare(
      `SELECT a.id, a.test_id, a.started_at, a.status, t.duration_minutes
       FROM attempts a JOIN tests t ON t.id = a.test_id
       WHERE a.id = ? AND a.user_id = ?`
    )
    .get(request.params.attemptId, request.user!.id) as
    | {
        id: string;
        test_id: string;
        started_at: string;
        status: string;
        duration_minutes: number | null;
      }
    | undefined;
  if (!attempt) throw new ApiError(404, "Test attempt not found.");
  if (attempt.status !== "in_progress") throw new ApiError(409, "This test attempt has already ended.");

  const questions = getQuestions(attempt.test_id);
  const answerEntries = request.body.answers;
  const questionIds = new Set(questions.map((question) => question.id));
  const answers: Record<string, string | string[]> = {};
  for (const [questionId, answer] of Object.entries(answerEntries)) {
    if (!questionIds.has(questionId)) throw new ApiError(400, "An answer refers to an unknown question.");
    if (typeof answer === "string") {
      if (answer.length > 5000) throw new ApiError(400, "A written answer is too long.");
      answers[questionId] = answer;
    } else if (Array.isArray(answer) && answer.every((item) => typeof item === "string")) {
      answers[questionId] = answer as string[];
    } else {
      throw new ApiError(400, "Answers must be text or a list of selected options.");
    }
  }

  let score = 0;
  const maxScore = questions.reduce(
    (total, question) => total + (question.type === "written" ? 0 : question.points),
    0
  );
  for (const question of questions) {
    if (question.type === "written") continue;
    const submitted = answers[question.id];
    const submittedAnswers = typeof submitted === "string" ? [submitted] : submitted ?? [];
    if (submittedAnswers.some((answer) => !question.options.includes(answer))) {
      throw new ApiError(400, `Question ${question.position + 1} has an invalid option.`);
    }
    const correct = [...question.correctAnswers].sort();
    const actual = [...submittedAnswers].sort();
    if (correct.length === actual.length && correct.every((answer, index) => answer === actual[index])) {
      score += question.points;
    }
  }

  const elapsedMilliseconds = Date.now() - new Date(attempt.started_at).getTime();
  const expired =
    attempt.duration_minutes !== null &&
    elapsedMilliseconds > attempt.duration_minutes * 60_000 + 5_000;
  const status = expired ? "expired" : "graded";
  const finalScore = expired ? 0 : score;
  database
    .prepare(
      `UPDATE attempts
       SET submitted_at = ?, status = ?, answers_json = ?, score = ?, max_score = ?
       WHERE id = ?`
    )
    .run(new Date().toISOString(), status, JSON.stringify(answers), finalScore, maxScore, attempt.id);

  response.json({
    status,
    score: finalScore,
    maxScore,
    writtenQuestionsNeedReview: questions.some((question) => question.type === "written")
  });
});

app.get("/api/analytics/me", requireUser, (request, response) => {
  const attempts = database
    .prepare(
      `SELECT a.id, a.status, a.started_at, a.submitted_at, a.score, a.max_score,
              t.title AS test_title, s.subject, s.name AS section_name
       FROM attempts a
       JOIN tests t ON t.id = a.test_id
       JOIN sections s ON s.id = t.section_id
       WHERE a.user_id = ?
       ORDER BY a.started_at DESC LIMIT 100`
    )
    .all(request.user!.id) as Array<{
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

  const completed = attempts.filter((attempt) => attempt.status !== "in_progress");
  const graded = completed.filter(
    (attempt): attempt is typeof attempt & { score: number; max_score: number } =>
      attempt.score !== null && attempt.max_score !== null
  );
  const possiblePoints = graded.reduce((total, attempt) => total + attempt.max_score, 0);
  const earnedPoints = graded.reduce((total, attempt) => total + attempt.score, 0);

  response.json({
    summary: {
      attempts: completed.length,
      averagePercentage:
        possiblePoints > 0 ? Math.round((earnedPoints / possiblePoints) * 100) : null
    },
    attempts
  });
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ApiError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  console.error("API request failed:", error);
  response.status(500).json({ error: "An unexpected server error occurred." });
});

void seedAdmin()
  .then(() => {
    app.listen(port, () => {
      console.log(`API server listening on http://localhost:${port}`);
    });
  })
  .catch((error: unknown) => {
    console.error("API startup failed:", error);
    process.exitCode = 1;
  });
