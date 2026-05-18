const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const db = require("./db");
const { setupSocket } = require("./socket");
const { generateRoomCode, normalizeCode, parsePositiveInteger } = require("./utils");

const app = express();
const server = http.createServer(app);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "quiz-mvp-dev-secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24,
  },
});

app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);

function setSessionUser(req, user) {
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    res.status(401).json({ error: "AUTH_REQUIRED" });
    return;
  }

  next();
}

function requireOrganizer(req, res, next) {
  if (!req.session.user || req.session.user.role !== "organizer") {
    res.status(403).json({ error: "ORGANIZER_ROLE_REQUIRED" });
    return;
  }

  next();
}

function quizBelongsToOrganizer(quizId, organizerId) {
  const quiz = db
    .prepare(
      `
      SELECT id, organizer_id, title, category, question_time_sec, rules, created_at
      FROM quizzes
      WHERE id = ?
    `,
    )
    .get(quizId);

  if (!quiz || quiz.organizer_id !== organizerId) {
    return null;
  }

  return quiz;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  const name = String(req.body && req.body.name ? req.body.name : "").trim();
  const email = String(req.body && req.body.email ? req.body.email : "")
    .trim()
    .toLowerCase();
  const password = String(req.body && req.body.password ? req.body.password : "");
  const role = String(req.body && req.body.role ? req.body.role : "").trim();

  if (!name || !email || !password || !role) {
    res.status(400).json({ error: "ALL_FIELDS_REQUIRED" });
    return;
  }

  if (!["participant", "organizer"].includes(role)) {
    res.status(400).json({ error: "INVALID_ROLE" });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: "PASSWORD_TOO_SHORT" });
    return;
  }

  const existingUser = db
    .prepare(
      `
      SELECT id
      FROM users
      WHERE email = ?
    `,
    )
    .get(email);

  if (existingUser) {
    res.status(409).json({ error: "EMAIL_ALREADY_EXISTS" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const result = db
    .prepare(
      `
      INSERT INTO users (name, email, password_hash, role)
      VALUES (?, ?, ?, ?)
    `,
    )
    .run(name, email, passwordHash, role);

  const user = db
    .prepare(
      `
      SELECT id, name, email, role
      FROM users
      WHERE id = ?
    `,
    )
    .get(result.lastInsertRowid);

  setSessionUser(req, user);

  res.status(201).json({ user });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body && req.body.email ? req.body.email : "")
    .trim()
    .toLowerCase();
  const password = String(req.body && req.body.password ? req.body.password : "");

  if (!email || !password) {
    res.status(400).json({ error: "EMAIL_PASSWORD_REQUIRED" });
    return;
  }

  const userRow = db
    .prepare(
      `
      SELECT id, name, email, role, password_hash
      FROM users
      WHERE email = ?
    `,
    )
    .get(email);

  if (!userRow) {
    res.status(401).json({ error: "INVALID_CREDENTIALS" });
    return;
  }

  const isValidPassword = await bcrypt.compare(password, userRow.password_hash);
  if (!isValidPassword) {
    res.status(401).json({ error: "INVALID_CREDENTIALS" });
    return;
  }

  setSessionUser(req, userRow);

  res.json({
    user: {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      role: userRow.role,
    },
  });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post("/api/quizzes", requireAuth, requireOrganizer, (req, res) => {
  const title = String(req.body && req.body.title ? req.body.title : "").trim();
  const category = String(req.body && req.body.category ? req.body.category : "").trim();
  const rules = String(req.body && req.body.rules ? req.body.rules : "").trim();
  const questionTimeSec = parsePositiveInteger(
    req.body && req.body.questionTimeSec,
    20,
  );

  if (!title || !category) {
    res.status(400).json({ error: "TITLE_CATEGORY_REQUIRED" });
    return;
  }

  const sanitizedQuestionTime = Math.min(Math.max(questionTimeSec, 5), 180);

  const result = db
    .prepare(
      `
      INSERT INTO quizzes (organizer_id, title, category, question_time_sec, rules)
      VALUES (?, ?, ?, ?, ?)
    `,
    )
    .run(
      req.session.user.id,
      title,
      category,
      sanitizedQuestionTime,
      rules,
    );

  const quiz = db
    .prepare(
      `
      SELECT id, title, category, question_time_sec, rules, created_at
      FROM quizzes
      WHERE id = ?
    `,
    )
    .get(result.lastInsertRowid);

  res.status(201).json({ quiz });
});

app.get("/api/quizzes/mine", requireAuth, requireOrganizer, (req, res) => {
  const quizzes = db
    .prepare(
      `
      SELECT
        q.id,
        q.title,
        q.category,
        q.question_time_sec,
        q.rules,
        q.created_at,
        COUNT(questions.id) AS question_count
      FROM quizzes q
      LEFT JOIN questions ON questions.quiz_id = q.id
      WHERE q.organizer_id = ?
      GROUP BY q.id
      ORDER BY q.created_at DESC
    `,
    )
    .all(req.session.user.id);

  res.json({ quizzes });
});

app.get("/api/quizzes/:quizId", requireAuth, requireOrganizer, (req, res) => {
  const quizId = Number.parseInt(req.params.quizId, 10);
  if (!Number.isInteger(quizId)) {
    res.status(400).json({ error: "INVALID_QUIZ_ID" });
    return;
  }

  const quiz = quizBelongsToOrganizer(quizId, req.session.user.id);
  if (!quiz) {
    res.status(404).json({ error: "QUIZ_NOT_FOUND" });
    return;
  }

  const questions = db
    .prepare(
      `
      SELECT id, prompt, image_url, allow_multiple, order_index
      FROM questions
      WHERE quiz_id = ?
      ORDER BY order_index ASC, id ASC
    `,
    )
    .all(quizId)
    .map((question) => ({
      ...question,
      choices: db
        .prepare(
          `
          SELECT id, choice_text, is_correct
          FROM choices
          WHERE question_id = ?
          ORDER BY id ASC
        `,
        )
        .all(question.id),
    }));

  res.json({ quiz, questions });
});

app.post(
  "/api/quizzes/:quizId/questions",
  requireAuth,
  requireOrganizer,
  (req, res) => {
    const quizId = Number.parseInt(req.params.quizId, 10);
    if (!Number.isInteger(quizId)) {
      res.status(400).json({ error: "INVALID_QUIZ_ID" });
      return;
    }

    const quiz = quizBelongsToOrganizer(quizId, req.session.user.id);
    if (!quiz) {
      res.status(404).json({ error: "QUIZ_NOT_FOUND" });
      return;
    }

    const prompt = String(req.body && req.body.prompt ? req.body.prompt : "").trim();
    const imageUrl = String(req.body && req.body.imageUrl ? req.body.imageUrl : "").trim();
    const allowMultiple = Boolean(req.body && req.body.allowMultiple);
    const rawChoices = Array.isArray(req.body && req.body.choices)
      ? req.body.choices
      : [];

    if (!prompt) {
      res.status(400).json({ error: "QUESTION_PROMPT_REQUIRED" });
      return;
    }

    const choices = rawChoices
      .map((choice) => ({
        text: String(choice && choice.text ? choice.text : "").trim(),
        isCorrect: Boolean(choice && choice.isCorrect),
      }))
      .filter((choice) => choice.text);

    if (choices.length < 2) {
      res.status(400).json({ error: "AT_LEAST_TWO_CHOICES_REQUIRED" });
      return;
    }

    const correctCount = choices.filter((choice) => choice.isCorrect).length;

    if (correctCount === 0) {
      res.status(400).json({ error: "AT_LEAST_ONE_CORRECT_CHOICE_REQUIRED" });
      return;
    }

    if (!allowMultiple && correctCount !== 1) {
      res.status(400).json({ error: "SINGLE_CHOICE_QUESTION_MUST_HAVE_ONE_CORRECT" });
      return;
    }

    const maxOrderRow = db
      .prepare(
        `
        SELECT COALESCE(MAX(order_index), 0) AS max_order
        FROM questions
        WHERE quiz_id = ?
      `,
      )
      .get(quizId);
    const orderIndex = Number(maxOrderRow.max_order) + 1;

    const transaction = db.transaction(() => {
      const insertedQuestion = db
        .prepare(
          `
          INSERT INTO questions (quiz_id, prompt, image_url, allow_multiple, order_index)
          VALUES (?, ?, ?, ?, ?)
        `,
        )
        .run(quizId, prompt, imageUrl, allowMultiple ? 1 : 0, orderIndex);

      const questionId = insertedQuestion.lastInsertRowid;

      const insertChoice = db.prepare(
        `
          INSERT INTO choices (question_id, choice_text, is_correct)
          VALUES (?, ?, ?)
        `,
      );

      for (const choice of choices) {
        insertChoice.run(questionId, choice.text, choice.isCorrect ? 1 : 0);
      }

      return questionId;
    });

    const questionId = transaction();

    res.status(201).json({ questionId });
  },
);

app.post(
  "/api/quizzes/:quizId/start",
  requireAuth,
  requireOrganizer,
  (req, res) => {
    const quizId = Number.parseInt(req.params.quizId, 10);
    if (!Number.isInteger(quizId)) {
      res.status(400).json({ error: "INVALID_QUIZ_ID" });
      return;
    }

    const quiz = quizBelongsToOrganizer(quizId, req.session.user.id);
    if (!quiz) {
      res.status(404).json({ error: "QUIZ_NOT_FOUND" });
      return;
    }

    const questionCountRow = db
      .prepare(
        `
        SELECT COUNT(*) AS total_questions
        FROM questions
        WHERE quiz_id = ?
      `,
      )
      .get(quizId);

    if (!questionCountRow || Number(questionCountRow.total_questions) === 0) {
      res.status(400).json({ error: "QUIZ_HAS_NO_QUESTIONS" });
      return;
    }

    let roomCode = "";
    for (let index = 0; index < 20; index += 1) {
      const candidate = generateRoomCode();
      const existing = db
        .prepare(
          `
            SELECT id
            FROM quiz_sessions
            WHERE room_code = ?
          `,
        )
        .get(candidate);

      if (!existing) {
        roomCode = candidate;
        break;
      }
    }

    if (!roomCode) {
      res.status(500).json({ error: "FAILED_TO_GENERATE_ROOM_CODE" });
      return;
    }

    const result = db
      .prepare(
        `
        INSERT INTO quiz_sessions (quiz_id, room_code, status, current_question_index)
        VALUES (?, ?, 'waiting', -1)
      `,
      )
      .run(quizId, roomCode);

    res.status(201).json({
      session: {
        id: result.lastInsertRowid,
        roomCode,
        status: "waiting",
      },
    });
  },
);

app.get("/api/session/by-code/:code", requireAuth, (req, res) => {
  const roomCode = normalizeCode(req.params.code);

  if (!roomCode) {
    res.status(400).json({ error: "ROOM_CODE_REQUIRED" });
    return;
  }

  const sessionRow = db
    .prepare(
      `
      SELECT
        s.id,
        s.quiz_id,
        s.room_code,
        s.status,
        s.current_question_index,
        s.started_at,
        s.ended_at,
        q.title,
        q.category,
        q.question_time_sec,
        q.rules,
        q.organizer_id
      FROM quiz_sessions s
      JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.room_code = ?
    `,
    )
    .get(roomCode);

  if (!sessionRow) {
    res.status(404).json({ error: "SESSION_NOT_FOUND" });
    return;
  }

  const myParticipation = db
    .prepare(
      `
      SELECT score
      FROM session_participants
      WHERE session_id = ? AND user_id = ?
    `,
    )
    .get(sessionRow.id, req.session.user.id);

  res.json({
    session: {
      id: sessionRow.id,
      quizId: sessionRow.quiz_id,
      roomCode: sessionRow.room_code,
      status: sessionRow.status,
      title: sessionRow.title,
      category: sessionRow.category,
      questionTimeSec: sessionRow.question_time_sec,
      rules: sessionRow.rules || "",
      organizerId: sessionRow.organizer_id,
      myScore: myParticipation ? myParticipation.score : 0,
    },
  });
});

app.get("/api/history", requireAuth, (req, res) => {
  const user = req.session.user;

  if (user.role === "organizer") {
    const history = db
      .prepare(
        `
        SELECT
          s.id,
          s.room_code,
          s.status,
          s.started_at,
          s.ended_at,
          s.created_at,
          q.title,
          q.category,
          COALESCE(participants.players, 0) AS players,
          (
            SELECT u.name
            FROM session_participants sp2
            JOIN users u ON u.id = sp2.user_id
            WHERE sp2.session_id = s.id
            ORDER BY sp2.score DESC, u.name ASC
            LIMIT 1
          ) AS winner_name,
          (
            SELECT sp2.score
            FROM session_participants sp2
            WHERE sp2.session_id = s.id
            ORDER BY sp2.score DESC
            LIMIT 1
          ) AS winner_score
        FROM quiz_sessions s
        JOIN quizzes q ON q.id = s.quiz_id
        LEFT JOIN (
          SELECT session_id, COUNT(*) AS players
          FROM session_participants
          GROUP BY session_id
        ) participants ON participants.session_id = s.id
        WHERE q.organizer_id = ?
        ORDER BY s.created_at DESC
        LIMIT 100
      `,
      )
      .all(user.id);

    res.json({ role: user.role, history });
    return;
  }

  const history = db
    .prepare(
      `
      SELECT
        s.id,
        s.room_code,
        s.status,
        s.started_at,
        s.ended_at,
        q.title,
        q.category,
        sp.score,
        (
          SELECT 1 + COUNT(*)
          FROM session_participants better
          WHERE better.session_id = sp.session_id AND better.score > sp.score
        ) AS rank,
        (
          SELECT COUNT(*)
          FROM session_participants allp
          WHERE allp.session_id = sp.session_id
        ) AS total_players
      FROM session_participants sp
      JOIN quiz_sessions s ON s.id = sp.session_id
      JOIN quizzes q ON q.id = s.quiz_id
      WHERE sp.user_id = ?
      ORDER BY sp.joined_at DESC
      LIMIT 100
    `,
    )
    .all(user.id);

  res.json({ role: user.role, history });
});

app.get("/api/sessions/:sessionId/leaderboard", requireAuth, (req, res) => {
  const sessionId = Number.parseInt(req.params.sessionId, 10);
  if (!Number.isInteger(sessionId)) {
    res.status(400).json({ error: "INVALID_SESSION_ID" });
    return;
  }

  const sessionRow = db
    .prepare(
      `
      SELECT s.id, q.organizer_id
      FROM quiz_sessions s
      JOIN quizzes q ON q.id = s.quiz_id
      WHERE s.id = ?
    `,
    )
    .get(sessionId);

  if (!sessionRow) {
    res.status(404).json({ error: "SESSION_NOT_FOUND" });
    return;
  }

  const isOrganizerOwner = sessionRow.organizer_id === req.session.user.id;
  const isParticipant = db
    .prepare(
      `
      SELECT id
      FROM session_participants
      WHERE session_id = ? AND user_id = ?
    `,
    )
    .get(sessionId, req.session.user.id);

  if (!isOrganizerOwner && !isParticipant) {
    res.status(403).json({ error: "FORBIDDEN" });
    return;
  }

  const leaderboard = db
    .prepare(
      `
      SELECT sp.user_id, u.name, sp.score
      FROM session_participants sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.session_id = ?
      ORDER BY sp.score DESC, u.name ASC
    `,
    )
    .all(sessionId)
    .map((entry, index) => ({
      rank: index + 1,
      userId: entry.user_id,
      name: entry.name,
      score: entry.score,
    }));

  res.json({ leaderboard });
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "dashboard.html"));
});

app.get("/live", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "live.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  console.error(error);
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});

setupSocket(server, sessionMiddleware);

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Quiz MVP is running on http://localhost:${port}`);
});
