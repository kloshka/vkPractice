const { Server } = require("socket.io");
const db = require("./db");
const { normalizeCode } = require("./utils");

const activeSessions = new Map();

function roomName(sessionId) {
  return `session:${sessionId}`;
}

function getSessionByCode(code) {
  return db
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
    .get(code);
}

function getQuestionsWithChoices(quizId) {
  const questionRows = db
    .prepare(
      `
      SELECT
        id,
        prompt,
        image_url,
        allow_multiple,
        order_index
      FROM questions
      WHERE quiz_id = ?
      ORDER BY order_index ASC, id ASC
    `,
    )
    .all(quizId);

  const getChoiceRows = db.prepare(
    `
      SELECT id, choice_text
      FROM choices
      WHERE question_id = ?
      ORDER BY id ASC
    `,
  );

  return questionRows.map((question) => ({
    ...question,
    choices: getChoiceRows.all(question.id),
  }));
}

function getLeaderboard(sessionId) {
  return db
    .prepare(
      `
      SELECT
        sp.user_id,
        u.name,
        sp.score
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
}

function toClientQuestion(question) {
  return {
    id: question.id,
    prompt: question.prompt,
    imageUrl: question.image_url || "",
    allowMultiple: Boolean(question.allow_multiple),
    choices: question.choices.map((choice) => ({
      id: choice.id,
      text: choice.choice_text,
    })),
  };
}

function emitLeaderboard(io, sessionId) {
  const leaderboard = getLeaderboard(sessionId);
  io.to(roomName(sessionId)).emit("quiz:leaderboard", { leaderboard });
  return leaderboard;
}

function clearSessionTimer(sessionId) {
  const existingState = activeSessions.get(sessionId);
  if (existingState && existingState.timer) {
    clearTimeout(existingState.timer);
  }
}

function finishSession(io, sessionId) {
  clearSessionTimer(sessionId);
  activeSessions.delete(sessionId);

  db.prepare(
    `
      UPDATE quiz_sessions
      SET status = 'ended', ended_at = COALESCE(ended_at, datetime('now'))
      WHERE id = ?
    `,
  ).run(sessionId);

  const leaderboard = getLeaderboard(sessionId);
  io.to(roomName(sessionId)).emit("quiz:finished", { leaderboard });
}

function scheduleQuestion(io, state, nextIndex) {
  clearSessionTimer(state.sessionId);

  if (nextIndex >= state.questions.length) {
    finishSession(io, state.sessionId);
    return;
  }

  const question = state.questions[nextIndex];
  const expiresAt = Date.now() + state.questionTimeSec * 1000;

  state.currentIndex = nextIndex;
  state.expiresAt = expiresAt;

  db.prepare(
    `
      UPDATE quiz_sessions
      SET
        status = 'live',
        current_question_index = ?,
        started_at = COALESCE(started_at, datetime('now'))
      WHERE id = ?
    `,
  ).run(nextIndex, state.sessionId);

  io.to(roomName(state.sessionId)).emit("quiz:question", {
    index: nextIndex + 1,
    total: state.questions.length,
    question: toClientQuestion(question),
    endsAt: expiresAt,
  });

  emitLeaderboard(io, state.sessionId);

  state.timer = setTimeout(() => {
    scheduleQuestion(io, state, nextIndex + 1);
  }, state.questionTimeSec * 1000);

  activeSessions.set(state.sessionId, state);
}

function recoverLiveSession(io, session) {
  const questions = getQuestionsWithChoices(session.quiz_id);

  if (!questions.length) {
    finishSession(io, session.id);
    return;
  }

  const startIndex =
    session.current_question_index >= 0 &&
    session.current_question_index < questions.length
      ? session.current_question_index
      : 0;

  const state = {
    sessionId: session.id,
    roomCode: session.room_code,
    questionTimeSec: session.question_time_sec,
    questions,
    currentIndex: -1,
    expiresAt: null,
    timer: null,
  };

  scheduleQuestion(io, state, startIndex);
}

function setupSocket(server, sessionMiddleware) {
  const io = new Server(server);

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
  });

  io.use((socket, next) => {
    if (!socket.request.session || !socket.request.session.user) {
      return next(new Error("AUTH_REQUIRED"));
    }

    return next();
  });

  io.on("connection", (socket) => {
    const user = socket.request.session.user;

    socket.on("room:join", (payload, callback) => {
      const done = typeof callback === "function" ? callback : () => {};
      const code = normalizeCode(payload && payload.code);

      if (!code) {
        done({ ok: false, error: "ROOM_CODE_REQUIRED" });
        return;
      }

      const session = getSessionByCode(code);
      if (!session) {
        done({ ok: false, error: "SESSION_NOT_FOUND" });
        return;
      }

      const isHost = user.id === session.organizer_id;

      if (!isHost) {
        db.prepare(
          `
            INSERT INTO session_participants (session_id, user_id)
            VALUES (?, ?)
            ON CONFLICT(session_id, user_id) DO NOTHING
          `,
        ).run(session.id, user.id);
      }

      socket.join(roomName(session.id));

      if (session.status === "live" && !activeSessions.has(session.id)) {
        recoverLiveSession(io, session);
      }

      const currentState = activeSessions.get(session.id);
      const response = {
        ok: true,
        isHost,
        session: {
          id: session.id,
          code: session.room_code,
          title: session.title,
          category: session.category,
          status: session.status,
          questionTimeSec: session.question_time_sec,
          rules: session.rules || "",
        },
      };

      if (
        session.status === "live" &&
        currentState &&
        currentState.currentIndex >= 0 &&
        currentState.currentIndex < currentState.questions.length
      ) {
        response.currentQuestion = {
          index: currentState.currentIndex + 1,
          total: currentState.questions.length,
          question: toClientQuestion(
            currentState.questions[currentState.currentIndex],
          ),
          endsAt: currentState.expiresAt,
        };
      }

      if (session.status === "ended") {
        response.leaderboard = getLeaderboard(session.id);
      }

      done(response);
    });

    socket.on("organizer:startQuiz", (payload, callback) => {
      const done = typeof callback === "function" ? callback : () => {};
      const code = normalizeCode(payload && payload.code);

      const session = getSessionByCode(code);
      if (!session) {
        done({ ok: false, error: "SESSION_NOT_FOUND" });
        return;
      }

      if (session.organizer_id !== user.id) {
        done({ ok: false, error: "FORBIDDEN" });
        return;
      }

      if (session.status === "ended") {
        done({ ok: false, error: "SESSION_ALREADY_ENDED" });
        return;
      }

      if (activeSessions.has(session.id) || session.status === "live") {
        done({ ok: false, error: "SESSION_ALREADY_LIVE" });
        return;
      }

      const questions = getQuestionsWithChoices(session.quiz_id);
      if (!questions.length) {
        done({ ok: false, error: "NO_QUESTIONS" });
        return;
      }

      const state = {
        sessionId: session.id,
        roomCode: session.room_code,
        questionTimeSec: session.question_time_sec,
        questions,
        currentIndex: -1,
        expiresAt: null,
        timer: null,
      };

      socket.join(roomName(session.id));
      scheduleQuestion(io, state, 0);

      done({ ok: true });
    });

    socket.on("organizer:finishQuiz", (payload, callback) => {
      const done = typeof callback === "function" ? callback : () => {};
      const code = normalizeCode(payload && payload.code);

      const session = getSessionByCode(code);
      if (!session) {
        done({ ok: false, error: "SESSION_NOT_FOUND" });
        return;
      }

      if (session.organizer_id !== user.id) {
        done({ ok: false, error: "FORBIDDEN" });
        return;
      }

      finishSession(io, session.id);
      done({ ok: true });
    });

    socket.on("participant:answer", (payload, callback) => {
      const done = typeof callback === "function" ? callback : () => {};
      const code = normalizeCode(payload && payload.code);
      const questionId = Number.parseInt(payload && payload.questionId, 10);
      const rawChoiceIds = Array.isArray(payload && payload.choiceIds)
        ? payload.choiceIds
        : [];

      if (!code || !Number.isInteger(questionId)) {
        done({ ok: false, error: "INVALID_PAYLOAD" });
        return;
      }

      const session = getSessionByCode(code);
      if (!session || session.status !== "live") {
        done({ ok: false, error: "SESSION_NOT_LIVE" });
        return;
      }

      const currentState = activeSessions.get(session.id);
      if (!currentState) {
        done({ ok: false, error: "SESSION_STATE_NOT_FOUND" });
        return;
      }

      const activeQuestion = currentState.questions[currentState.currentIndex];
      if (!activeQuestion || activeQuestion.id !== questionId) {
        done({ ok: false, error: "QUESTION_NOT_ACTIVE" });
        return;
      }

      if (Date.now() > currentState.expiresAt) {
        done({ ok: false, error: "ANSWER_TIME_EXPIRED" });
        return;
      }

      const participantRow = db
        .prepare(
          `
            SELECT id
            FROM session_participants
            WHERE session_id = ? AND user_id = ?
          `,
        )
        .get(session.id, user.id);

      if (!participantRow) {
        done({ ok: false, error: "JOIN_ROOM_FIRST" });
        return;
      }

      const existingAnswer = db
        .prepare(
          `
            SELECT id
            FROM answers
            WHERE session_id = ? AND question_id = ? AND user_id = ?
          `,
        )
        .get(session.id, questionId, user.id);

      if (existingAnswer) {
        done({ ok: false, error: "QUESTION_ALREADY_ANSWERED" });
        return;
      }

      const choiceIds = Array.from(
        new Set(
          rawChoiceIds
            .map((choiceId) => Number.parseInt(choiceId, 10))
            .filter((choiceId) => Number.isInteger(choiceId)),
        ),
      );

      if (!choiceIds.length) {
        done({ ok: false, error: "NO_CHOICES_SELECTED" });
        return;
      }

      if (!activeQuestion.allow_multiple && choiceIds.length !== 1) {
        done({ ok: false, error: "ONLY_SINGLE_CHOICE_ALLOWED" });
        return;
      }

      const choiceRows = db
        .prepare(
          `
            SELECT id, is_correct
            FROM choices
            WHERE question_id = ?
          `,
        )
        .all(questionId);

      const validChoiceIds = new Set(choiceRows.map((choice) => choice.id));
      if (!choiceIds.every((choiceId) => validChoiceIds.has(choiceId))) {
        done({ ok: false, error: "INVALID_CHOICES" });
        return;
      }

      const correctChoiceIds = choiceRows
        .filter((choice) => choice.is_correct === 1)
        .map((choice) => choice.id);
      const correctSet = new Set(correctChoiceIds);

      const isCorrect =
        choiceIds.length === correctChoiceIds.length &&
        choiceIds.every((choiceId) => correctSet.has(choiceId));

      db.prepare(
        `
          INSERT INTO answers (session_id, question_id, user_id, selected_choice_ids, is_correct)
          VALUES (?, ?, ?, ?, ?)
        `,
      ).run(
        session.id,
        questionId,
        user.id,
        JSON.stringify(choiceIds),
        isCorrect ? 1 : 0,
      );

      if (isCorrect) {
        db.prepare(
          `
            UPDATE session_participants
            SET score = score + 1
            WHERE session_id = ? AND user_id = ?
          `,
        ).run(session.id, user.id);
      }

      const scoreRow = db
        .prepare(
          `
            SELECT score
            FROM session_participants
            WHERE session_id = ? AND user_id = ?
          `,
        )
        .get(session.id, user.id);

      emitLeaderboard(io, session.id);

      done({
        ok: true,
        isCorrect,
        score: scoreRow ? scoreRow.score : 0,
      });
    });
  });

  return io;
}

module.exports = {
  setupSocket,
};
