const { api, showMessage, formatDate, escapeHtml } = window.appApi;

const userBadge = document.getElementById("userBadge");
const logoutButton = document.getElementById("logoutButton");
const organizerPanel = document.getElementById("organizerPanel");
const participantPanel = document.getElementById("participantPanel");
const dashboardMessage = document.getElementById("dashboardMessage");
const historyList = document.getElementById("historyList");

const createQuizForm = document.getElementById("createQuizForm");
const createQuestionForm = document.getElementById("createQuestionForm");
const questionQuizSelect = document.getElementById("questionQuizSelect");
const quizList = document.getElementById("quizList");
const joinRoomForm = document.getElementById("joinRoomForm");

const state = {
  user: null,
  quizzes: [],
};

function toStatusChip(status) {
  const labelByStatus = {
    waiting: "Ожидание",
    live: "В эфире",
    ended: "Завершен",
  };

  const safeStatus = status || "waiting";
  const statusLabel = labelByStatus[safeStatus] || safeStatus;
  return `<span class="status-chip ${safeStatus}">${statusLabel}</span>`;
}

function renderOrganizerQuizOptions() {
  if (!questionQuizSelect) {
    return;
  }

  if (!state.quizzes.length) {
    questionQuizSelect.innerHTML = "<option value=''>Сначала создайте квиз</option>";
    return;
  }

  questionQuizSelect.innerHTML = [
    "<option value=''>Выберите квиз</option>",
    ...state.quizzes.map(
      (quiz) =>
        `<option value="${quiz.id}">${escapeHtml(quiz.title)} (${escapeHtml(quiz.category)})</option>`,
    ),
  ].join("");
}

function renderOrganizerQuizList() {
  if (!quizList) {
    return;
  }

  if (!state.quizzes.length) {
    quizList.innerHTML = "<p class='muted-text'>Пока нет ни одного квиза.</p>";
    return;
  }

  quizList.innerHTML = state.quizzes
    .map(
      (quiz) => `
      <article class="quiz-item">
        <div class="quiz-item-head">
          <div>
            <h4>${escapeHtml(quiz.title)}</h4>
            <div class="quiz-item-meta">
              <span>Категория: ${escapeHtml(quiz.category)}</span>
              <span>Время: ${quiz.question_time_sec} сек.</span>
            </div>
          </div>
          <span class="status-chip waiting">Готов</span>
        </div>
        <div class="quiz-item-meta">
          <span>Вопросов: ${quiz.question_count}</span>
          <span>Создан: ${formatDate(quiz.created_at)}</span>
        </div>
        <div class="quiz-item-actions">
          <button class="btn btn-secondary" type="button" data-start-quiz="${quiz.id}" ${quiz.question_count > 0 ? "" : "disabled"}>
            Создать комнату
          </button>
        </div>
      </article>
    `,
    )
    .join("");

  document.querySelectorAll("[data-start-quiz]").forEach((button) => {
    button.addEventListener("click", async () => {
      const quizId = Number.parseInt(button.dataset.startQuiz || "", 10);
      if (!Number.isInteger(quizId)) {
        return;
      }

      button.disabled = true;

      try {
        const payload = await api(`/api/quizzes/${quizId}/start`, {
          method: "POST",
          body: JSON.stringify({}),
        });

        const roomCode = payload.session && payload.session.roomCode;
        if (!roomCode) {
          throw new Error("ROOM_CODE_MISSING");
        }

        window.location.href = `/live?code=${encodeURIComponent(roomCode)}`;
      } catch (error) {
        button.disabled = false;
        showMessage(dashboardMessage, `Не удалось создать комнату: ${error.message}`, "error");
      }
    });
  });
}

async function loadOrganizerData() {
  const payload = await api("/api/quizzes/mine");
  state.quizzes = Array.isArray(payload.quizzes) ? payload.quizzes : [];
  renderOrganizerQuizOptions();
  renderOrganizerQuizList();
}

function renderHistory(role, items) {
  if (!Array.isArray(items) || items.length === 0) {
    historyList.innerHTML = "<p class='muted-text'>История пока пуста.</p>";
    return;
  }

  if (role === "organizer") {
    historyList.innerHTML = items
      .map(
        (entry) => `
        <article class="history-item">
          <h4>${escapeHtml(entry.title)}</h4>
          <div class="history-meta">
            <span>Комната: ${escapeHtml(entry.room_code)}</span>
            <span>${toStatusChip(entry.status)}</span>
            <span>Игроков: ${entry.players}</span>
            <span>Победитель: ${entry.winner_name ? `${escapeHtml(entry.winner_name)} (${entry.winner_score || 0})` : "-"}</span>
            <span>Старт: ${formatDate(entry.started_at || entry.created_at)}</span>
          </div>
        </article>
      `,
      )
      .join("");
    return;
  }

  historyList.innerHTML = items
    .map(
      (entry) => `
      <article class="history-item">
        <h4>${escapeHtml(entry.title)}</h4>
        <div class="history-meta">
          <span>Комната: ${escapeHtml(entry.room_code)}</span>
          <span>${toStatusChip(entry.status)}</span>
          <span>Очки: ${entry.score}</span>
          <span>Место: ${entry.rank}/${entry.total_players}</span>
          <span>Старт: ${formatDate(entry.started_at)}</span>
        </div>
      </article>
    `,
    )
    .join("");
}

async function loadHistory() {
  const payload = await api("/api/history");
  renderHistory(payload.role, payload.history || []);
}

async function bootstrap() {
  try {
    const payload = await api("/api/auth/me");
    if (!payload.user) {
      window.location.href = "/";
      return;
    }

    state.user = payload.user;
    userBadge.textContent = `${state.user.name} (${state.user.role})`;

    if (state.user.role === "organizer") {
      organizerPanel.classList.remove("hidden");
      await loadOrganizerData();
    } else {
      participantPanel.classList.remove("hidden");
    }

    await loadHistory();
  } catch (error) {
    showMessage(dashboardMessage, `Ошибка инициализации: ${error.message}`, "error");
  }
}

logoutButton.addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
    window.location.href = "/";
  } catch (error) {
    showMessage(dashboardMessage, `Не удалось выйти: ${error.message}`, "error");
  }
});

if (createQuizForm) {
  createQuizForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const title = String(createQuizForm.title.value || "").trim();
    const category = String(createQuizForm.category.value || "").trim();
    const questionTimeSec = Number.parseInt(createQuizForm.questionTimeSec.value || "20", 10);
    const rules = String(createQuizForm.rules.value || "").trim();

    try {
      await api("/api/quizzes", {
        method: "POST",
        body: JSON.stringify({ title, category, questionTimeSec, rules }),
      });

      createQuizForm.reset();
      createQuizForm.questionTimeSec.value = "20";
      await loadOrganizerData();
      showMessage(dashboardMessage, "Квиз создан", "success");
    } catch (error) {
      showMessage(dashboardMessage, `Ошибка создания квиза: ${error.message}`, "error");
    }
  });
}

if (createQuestionForm) {
  createQuestionForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const quizId = Number.parseInt(questionQuizSelect.value || "", 10);
    const prompt = String(createQuestionForm.prompt.value || "").trim();
    const imageUrl = String(createQuestionForm.imageUrl.value || "").trim();
    const allowMultiple = Boolean(createQuestionForm.allowMultiple.checked);

    const choices = Array.from(document.querySelectorAll("#questionChoices .choice-row"))
      .map((row) => {
        const textInput = row.querySelector(".choice-text");
        const correctInput = row.querySelector(".choice-correct");

        return {
          text: String(textInput && textInput.value ? textInput.value : "").trim(),
          isCorrect: Boolean(correctInput && correctInput.checked),
        };
      })
      .filter((choice) => choice.text);

    if (!Number.isInteger(quizId)) {
      showMessage(dashboardMessage, "Сначала выберите квиз", "error");
      return;
    }

    try {
      await api(`/api/quizzes/${quizId}/questions`, {
        method: "POST",
        body: JSON.stringify({ prompt, imageUrl, allowMultiple, choices }),
      });

      createQuestionForm.reset();
      showMessage(dashboardMessage, "Вопрос добавлен", "success");
      await loadOrganizerData();
    } catch (error) {
      showMessage(dashboardMessage, `Ошибка добавления вопроса: ${error.message}`, "error");
    }
  });
}

if (joinRoomForm) {
  joinRoomForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const roomCode = String(joinRoomForm.roomCode.value || "").trim().toUpperCase();
    if (!roomCode) {
      showMessage(dashboardMessage, "Введите код комнаты", "error");
      return;
    }

    window.location.href = `/live?code=${encodeURIComponent(roomCode)}`;
  });
}

bootstrap();
