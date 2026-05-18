const {
  assert,
  sleep,
  HttpClient,
  startServer,
  emitAck,
  onceEvent,
  createSocket,
  randomEmail,
} = require("./helpers");

async function testEmptyFields(baseUrl) {
  const client = new HttpClient(baseUrl);

  const badRegister = await client.request("/api/auth/register", {
    method: "POST",
    json: {
      name: "",
      email: "",
      password: "",
      role: "",
    },
  });
  assert(badRegister.status === 400, "Empty registration fields should return 400");

  const organizer = new HttpClient(baseUrl);
  const registerOrganizer = await organizer.request("/api/auth/register", {
    method: "POST",
    json: {
      name: "Edge Organizer",
      email: randomEmail("edge-org-empty"),
      password: "secret123",
      role: "organizer",
    },
  });
  assert(registerOrganizer.status === 201, "Organizer registration failed in empty-fields test");

  const emptyQuiz = await organizer.request("/api/quizzes", {
    method: "POST",
    json: {
      title: "",
      category: "",
    },
  });
  assert(emptyQuiz.status === 400, "Empty quiz fields should return 400");

  const validQuiz = await organizer.request("/api/quizzes", {
    method: "POST",
    json: {
      title: "Edge Empty Quiz",
      category: "Edge",
      questionTimeSec: 6,
      rules: "Edge",
    },
  });
  assert(validQuiz.status === 201, "Valid quiz creation failed");

  const badQuestion = await organizer.request(
    `/api/quizzes/${validQuiz.payload.quiz.id}/questions`,
    {
      method: "POST",
      json: {
        prompt: "",
        imageUrl: "",
        allowMultiple: false,
        choices: [{ text: "Only one", isCorrect: true }],
      },
    },
  );
  assert(badQuestion.status === 400, "Invalid question payload should return 400");
}

async function testRepeatLogin(baseUrl) {
  const registrationClient = new HttpClient(baseUrl);
  const email = randomEmail("edge-repeat-login");
  const password = "secret123";

  const register = await registrationClient.request("/api/auth/register", {
    method: "POST",
    json: {
      name: "Repeat Login User",
      email,
      password,
      role: "participant",
    },
  });
  assert(register.status === 201, "Repeat login setup registration failed");

  const loginClientA = new HttpClient(baseUrl);
  const loginClientB = new HttpClient(baseUrl);

  const loginA = await loginClientA.request("/api/auth/login", {
    method: "POST",
    json: { email, password },
  });
  const loginB = await loginClientB.request("/api/auth/login", {
    method: "POST",
    json: { email, password },
  });

  assert(loginA.status === 200, "First login should be successful");
  assert(loginB.status === 200, "Second login should be successful");

  const meA = await loginClientA.request("/api/auth/me");
  const meB = await loginClientB.request("/api/auth/me");

  assert(meA.status === 200 && meA.payload.user, "First session should be active");
  assert(meB.status === 200 && meB.payload.user, "Second session should be active");
  assert(
    meA.payload.user.email === meB.payload.user.email,
    "Both sessions should belong to the same user",
  );
}

async function testDoubleClickAnswer(baseUrl) {
  const organizer = new HttpClient(baseUrl);
  const participant = new HttpClient(baseUrl);
  const sockets = [];

  try {
    const organizerRegister = await organizer.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Edge Double Organizer",
        email: randomEmail("edge-double-org"),
        password: "secret123",
        role: "organizer",
      },
    });
    assert(organizerRegister.status === 201, "Organizer register failed in double-click test");

    const participantRegister = await participant.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Edge Double Participant",
        email: randomEmail("edge-double-part"),
        password: "secret123",
        role: "participant",
      },
    });
    assert(participantRegister.status === 201, "Participant register failed in double-click test");

    const quiz = await organizer.request("/api/quizzes", {
      method: "POST",
      json: {
        title: "Edge Double Quiz",
        category: "Edge",
        questionTimeSec: 6,
        rules: "Edge",
      },
    });
    assert(quiz.status === 201, "Quiz creation failed in double-click test");

    const addQuestion = await organizer.request(`/api/quizzes/${quiz.payload.quiz.id}/questions`, {
      method: "POST",
      json: {
        prompt: "2+3=?",
        imageUrl: "",
        allowMultiple: false,
        choices: [
          { text: "4", isCorrect: false },
          { text: "5", isCorrect: true },
          { text: "6", isCorrect: false },
          { text: "7", isCorrect: false },
        ],
      },
    });
    assert(addQuestion.status === 201, "Question creation failed in double-click test");

    const startSession = await organizer.request(`/api/quizzes/${quiz.payload.quiz.id}/start`, {
      method: "POST",
      json: {},
    });
    assert(startSession.status === 201, "Session creation failed in double-click test");

    const roomCode = startSession.payload.session.roomCode;

    const organizerSocket = createSocket(organizer, baseUrl);
    const participantSocket = createSocket(participant, baseUrl);
    sockets.push(organizerSocket, participantSocket);

    await emitAck(organizerSocket, "room:join", { code: roomCode });
    await emitAck(participantSocket, "room:join", { code: roomCode });

    const questionPromise = onceEvent(participantSocket, "quiz:question");
    await emitAck(organizerSocket, "organizer:startQuiz", { code: roomCode });

    const question = await questionPromise;
    const correctChoice = question.question.choices.find((item) => item.text === "5");
    assert(correctChoice, "Correct choice not found in double-click test");

    const firstAnswer = await emitAck(participantSocket, "participant:answer", {
      code: roomCode,
      questionId: question.question.id,
      choiceIds: [correctChoice.id],
    });

    const secondAnswer = await emitAck(participantSocket, "participant:answer", {
      code: roomCode,
      questionId: question.question.id,
      choiceIds: [correctChoice.id],
    });

    assert(firstAnswer.ok === true, "First click answer should be accepted");
    assert(secondAnswer.ok === false, "Second click answer should be rejected");
    assert(
      secondAnswer.error === "QUESTION_ALREADY_ANSWERED",
      "Second click should fail with QUESTION_ALREADY_ANSWERED",
    );
  } finally {
    for (const socket of sockets) {
      if (socket && socket.connected) {
        socket.disconnect();
      } else if (socket) {
        socket.close();
      }
    }
  }
}

async function testDisconnectReconnect(baseUrl) {
  const organizer = new HttpClient(baseUrl);
  const participant = new HttpClient(baseUrl);
  const sockets = [];

  try {
    const organizerRegister = await organizer.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Edge Reconnect Organizer",
        email: randomEmail("edge-reconnect-org"),
        password: "secret123",
        role: "organizer",
      },
    });
    assert(organizerRegister.status === 201, "Organizer register failed in reconnect test");

    const participantRegister = await participant.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Edge Reconnect Participant",
        email: randomEmail("edge-reconnect-part"),
        password: "secret123",
        role: "participant",
      },
    });
    assert(participantRegister.status === 201, "Participant register failed in reconnect test");

    const quiz = await organizer.request("/api/quizzes", {
      method: "POST",
      json: {
        title: "Edge Reconnect Quiz",
        category: "Edge",
        questionTimeSec: 7,
        rules: "Edge",
      },
    });
    assert(quiz.status === 201, "Quiz creation failed in reconnect test");

    const addQuestion = await organizer.request(`/api/quizzes/${quiz.payload.quiz.id}/questions`, {
      method: "POST",
      json: {
        prompt: "Reconnect question",
        imageUrl: "",
        allowMultiple: false,
        choices: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
          { text: "C", isCorrect: false },
          { text: "D", isCorrect: false },
        ],
      },
    });
    assert(addQuestion.status === 201, "Question creation failed in reconnect test");

    const startSession = await organizer.request(`/api/quizzes/${quiz.payload.quiz.id}/start`, {
      method: "POST",
      json: {},
    });
    assert(startSession.status === 201, "Session creation failed in reconnect test");

    const roomCode = startSession.payload.session.roomCode;

    const organizerSocket = createSocket(organizer, baseUrl);
    let participantSocket = createSocket(participant, baseUrl);
    sockets.push(organizerSocket, participantSocket);

    await emitAck(organizerSocket, "room:join", { code: roomCode });
    await emitAck(participantSocket, "room:join", { code: roomCode });

    const firstQuestionPromise = onceEvent(participantSocket, "quiz:question");
    await emitAck(organizerSocket, "organizer:startQuiz", { code: roomCode });

    await firstQuestionPromise;

    participantSocket.disconnect();
    await sleep(300);

    participantSocket = createSocket(participant, baseUrl);
    sockets.push(participantSocket);

    const rejoinAck = await emitAck(participantSocket, "room:join", { code: roomCode });
    assert(rejoinAck.ok === true, "Rejoin should be successful");
    assert(
      Boolean(rejoinAck.currentQuestion),
      "Rejoin during live session should return currentQuestion",
    );

    const currentQuestion = rejoinAck.currentQuestion.question;
    const choiceA = currentQuestion.choices.find((item) => item.text === "A");
    assert(choiceA, "Choice A not found in reconnect question");

    const answerAck = await emitAck(participantSocket, "participant:answer", {
      code: roomCode,
      questionId: currentQuestion.id,
      choiceIds: [choiceA.id],
    });
    assert(answerAck.ok === true, "Answer after reconnect should be accepted");

    await onceEvent(organizerSocket, "quiz:finished");
  } finally {
    for (const socket of sockets) {
      if (socket && socket.connected) {
        socket.disconnect();
      } else if (socket) {
        socket.close();
      }
    }
  }
}

async function main() {
  const server = await startServer(3013);

  const checks = [];

  async function runCheck(name, fn) {
    try {
      await fn();
      checks.push({ name, status: "PASS" });
      console.log(`PASS: ${name}`);
    } catch (error) {
      checks.push({ name, status: "FAIL", error: error.message });
      console.error(`FAIL: ${name} -> ${error.message}`);
      throw error;
    }
  }

  try {
    await runCheck("Edge-01 Empty fields", async () => {
      await testEmptyFields(server.baseUrl);
    });

    await runCheck("Edge-02 Repeat logins", async () => {
      await testRepeatLogin(server.baseUrl);
    });

    await runCheck("Edge-03 Double click answer", async () => {
      await testDoubleClickAnswer(server.baseUrl);
    });

    await runCheck("Edge-04 Disconnect and reconnect", async () => {
      await testDisconnectReconnect(server.baseUrl);
    });

    console.log("\nEDGE SUMMARY");
    for (const item of checks) {
      console.log(`- ${item.status}: ${item.name}`);
    }
    console.log(`\nEDGE PASSED: ${checks.length}/${checks.length}`);
  } catch (error) {
    console.error("\nEDGE FAILED");
    for (const item of checks) {
      const suffix = item.error ? ` -> ${item.error}` : "";
      console.error(`- ${item.status}: ${item.name}${suffix}`);
    }
    console.error("Server log:\n" + server.getLog());
    process.exitCode = 1;
  } finally {
    await server.stop();
  }
}

main();
