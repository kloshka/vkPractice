const { api, showMessage, escapeHtml } = window.appApi;

const roomCodeLabel = document.getElementById("roomCodeLabel");
const sessionTitle = document.getElementById("sessionTitle");
const sessionCategory = document.getElementById("sessionCategory");
const sessionRules = document.getElementById("sessionRules");
const sessionStatus = document.getElementById("sessionStatus");
const questionTimer = document.getElementById("questionTimer");

const hostControls = document.getElementById("hostControls");
const startQuizButton = document.getElementById("startQuizButton");
const finishQuizButton = document.getElementById("finishQuizButton");

const questionMeta = document.getElementById("questionMeta");
const questionPrompt = document.getElementById("questionPrompt");
const questionImage = document.getElementById("questionImage");
const answerForm = document.getElementById("answerForm");
const submitAnswerButton = document.getElementById("submitAnswerButton");
const leaderboardNode = document.getElementById("leaderboard");
const liveMessage = document.getElementById("liveMessage");

const state = {
  user: null,
  roomCode: "",
  isHost: false,
  sessionStatus: "waiting",
  currentQuestion: null,
  submittedQuestionId: null,
  timerIntervalId: null,
  socket: null,
};

function updateSessionStatus(status) {
  state.sessionStatus = status;
  const statusByCode = {
    waiting: "Ожидание запуска",
    live: "Идет вопрос",
    ended: "Квиз завершен",
  };

  sessionStatus.textContent = statusByCode[status] || status;
}

function updateHostControls() {
  if (state.isHost) {
    hostControls.classList.remove("hidden");
  } else {
    hostControls.classList.add("hidden");
  }

  startQuizButton.disabled = !(state.isHost && state.sessionStatus === "waiting");
  finishQuizButton.disabled = !(state.isHost && state.sessionStatus !== "ended");
}

function clearTimer() {
  if (state.timerIntervalId) {
    clearInterval(state.timerIntervalId);
    state.timerIntervalId = null;
  }
  questionTimer.textContent = "";
}

function startTimer(endsAt) {
  clearTimer();

  const tick = () => {
    const leftMs = Number(endsAt) - Date.now();
    const leftSec = Math.max(0, Math.ceil(leftMs / 1000));
    questionTimer.textContent = `Осталось: ${leftSec} c`;

    if (leftSec <= 0) {
      clearTimer();
      if (!state.isHost) {
        submitAnswerButton.disabled = true;
      }
    }
  };

  tick();
  state.timerIntervalId = setInterval(tick, 300);
}

function renderQuestion(payload) {
  const question = payload.question;
  state.currentQuestion = question;
  state.submittedQuestionId = null;

  questionMeta.textContent = `Вопрос ${payload.index}/${payload.total}`;
  questionPrompt.textContent = question.prompt || "";

  if (question.imageUrl) {
    questionImage.src = question.imageUrl;
    questionImage.classList.remove("hidden");
  } else {
    questionImage.src = "";
    questionImage.classList.add("hidden");
  }

  const inputType = question.allowMultiple ? "checkbox" : "radio";
  answerForm.innerHTML = question.choices
    .map(
      (choice) => `
      <label class="answer-option">
        <input
          type="${inputType}"
          name="answerChoice"
          value="${choice.id}"
          ${state.isHost ? "disabled" : ""}
        />
        <span>${escapeHtml(choice.text)}</span>
      </label>
    `,
    )
    .join("");

  submitAnswerButton.disabled = state.isHost;
  submitAnswerButton.textContent = state.isHost
    ? "Организатор только наблюдает"
    : "Отправить ответ";

  startTimer(payload.endsAt);
}

function renderLeaderboard(leaderboard, isFinal) {
  if (!Array.isArray(leaderboard) || leaderboard.length === 0) {
    leaderboardNode.innerHTML = "<p class='muted-text'>Пока нет результатов.</p>";
    return;
  }

  leaderboardNode.innerHTML = [
    `<div class="leaderboard-head"><span>#</span><span>Игрок</span><span>Очки</span></div>`,
    ...leaderboard.map(
      (entry) => `
      <div class="leaderboard-row">
        <span>${entry.rank}</span>
        <span>${escapeHtml(entry.name)}</span>
        <span>${entry.score}</span>
      </div>
    `,
    ),
  ].join("");

  if (isFinal) {
    showMessage(liveMessage, "Квиз завершен. Финальный лидерборд обновлен.", "success");
  }
}

function bindSocketEvents() {
  state.socket.on("quiz:question", (payload) => {
    updateSessionStatus("live");
    updateHostControls();
    renderQuestion(payload);
  });

  state.socket.on("quiz:leaderboard", (payload) => {
    renderLeaderboard(payload.leaderboard || [], false);
  });

  state.socket.on("quiz:finished", (payload) => {
    updateSessionStatus("ended");
    updateHostControls();
    clearTimer();
    submitAnswerButton.disabled = true;
    submitAnswerButton.textContent = "Квиз завершен";
    renderLeaderboard(payload.leaderboard || [], true);
  });

  state.socket.on("connect_error", (error) => {
    showMessage(liveMessage, `Ошибка WebSocket: ${error.message}`, "error");
  });
}

function bindActions() {
  submitAnswerButton.addEventListener("click", () => {
    if (state.isHost) {
      return;
    }

    if (!state.currentQuestion) {
      showMessage(liveMessage, "Сейчас нет активного вопроса", "error");
      return;
    }

    if (state.submittedQuestionId === state.currentQuestion.id) {
      showMessage(liveMessage, "Ответ на этот вопрос уже отправлен", "info");
      return;
    }

    const selectedChoiceIds = Array.from(
      answerForm.querySelectorAll("input[name='answerChoice']:checked"),
    ).map((node) => Number.parseInt(node.value, 10));

    state.socket.emit(
      "participant:answer",
      {
        code: state.roomCode,
        questionId: state.currentQuestion.id,
        choiceIds: selectedChoiceIds,
      },
      (result) => {
        if (!result || !result.ok) {
          const reason = result && result.error ? result.error : "UNKNOWN_ERROR";
          showMessage(liveMessage, `Ответ не принят: ${reason}`, "error");
          return;
        }

        state.submittedQuestionId = state.currentQuestion.id;
        submitAnswerButton.disabled = true;
        showMessage(
          liveMessage,
          result.isCorrect
            ? `Верно. Текущий счет: ${result.score}`
            : `Неверно. Текущий счет: ${result.score}`,
          result.isCorrect ? "success" : "info",
        );
      },
    );
  });

  startQuizButton.addEventListener("click", () => {
    state.socket.emit("organizer:startQuiz", { code: state.roomCode }, (result) => {
      if (!result || !result.ok) {
        const reason = result && result.error ? result.error : "UNKNOWN_ERROR";
        showMessage(liveMessage, `Не удалось запустить квиз: ${reason}`, "error");
        return;
      }

      showMessage(liveMessage, "Квиз запущен", "success");
      updateSessionStatus("live");
      updateHostControls();
    });
  });

  finishQuizButton.addEventListener("click", () => {
    state.socket.emit("organizer:finishQuiz", { code: state.roomCode }, (result) => {
      if (!result || !result.ok) {
        const reason = result && result.error ? result.error : "UNKNOWN_ERROR";
        showMessage(liveMessage, `Не удалось завершить квиз: ${reason}`, "error");
        return;
      }

      showMessage(liveMessage, "Квиз остановлен организатором", "info");
    });
  });
}

async function joinRoom() {
  state.socket.emit("room:join", { code: state.roomCode }, (result) => {
    if (!result || !result.ok) {
      const reason = result && result.error ? result.error : "UNKNOWN_ERROR";
      showMessage(liveMessage, `Не удалось подключиться: ${reason}`, "error");
      return;
    }

    state.isHost = Boolean(result.isHost);
    updateSessionStatus(result.session.status || "waiting");

    sessionTitle.textContent = result.session.title;
    sessionCategory.textContent = `Категория: ${result.session.category}`;
    sessionRules.textContent = result.session.rules
      ? `Правила: ${result.session.rules}`
      : "Правила: без дополнительных ограничений";

    if (result.currentQuestion) {
      updateSessionStatus("live");
      renderQuestion(result.currentQuestion);
    }

    if (result.leaderboard) {
      renderLeaderboard(result.leaderboard, true);
      submitAnswerButton.disabled = true;
      submitAnswerButton.textContent = "Квиз завершен";
    }

    updateHostControls();
  });
}

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  state.roomCode = String(params.get("code") || "").trim().toUpperCase();
  roomCodeLabel.textContent = state.roomCode || "-";

  if (!state.roomCode) {
    showMessage(liveMessage, "Код комнаты не передан", "error");
    submitAnswerButton.disabled = true;
    return;
  }

  try {
    const mePayload = await api("/api/auth/me");
    if (!mePayload.user) {
      window.location.href = "/";
      return;
    }

    state.user = mePayload.user;

    try {
      const preview = await api(`/api/session/by-code/${encodeURIComponent(state.roomCode)}`);
      if (preview && preview.session) {
        sessionTitle.textContent = preview.session.title;
        sessionCategory.textContent = `Категория: ${preview.session.category}`;
        sessionRules.textContent = preview.session.rules
          ? `Правила: ${preview.session.rules}`
          : "Правила: без дополнительных ограничений";
      }
    } catch (error) {
      showMessage(liveMessage, `Не удалось загрузить данные комнаты: ${error.message}`, "error");
    }

    state.socket = io();
    bindSocketEvents();
    bindActions();
    joinRoom();
  } catch (error) {
    showMessage(liveMessage, `Ошибка инициализации: ${error.message}`, "error");
  }
}

bootstrap();
