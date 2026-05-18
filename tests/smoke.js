const {
  assert,
  HttpClient,
  startServer,
  emitAck,
  onceEvent,
  createSocket,
  randomEmail,
} = require("./helpers");

async function main() {
  const server = await startServer(3011);
  const sockets = [];
  const cases = [];

  const context = {
    organizer: new HttpClient(server.baseUrl),
    participant: new HttpClient(server.baseUrl),
    roomCode: "",
    questionId: 0,
    correctChoiceId: 0,
  };

  async function runCase(name, fn) {
    try {
      await fn();
      cases.push({ name, status: "PASS" });
      console.log(`PASS: ${name}`);
    } catch (error) {
      cases.push({ name, status: "FAIL", error: error.message });
      console.error(`FAIL: ${name} -> ${error.message}`);
      throw error;
    }
  }

  try {
    await runCase("Smoke-01 Health endpoint", async () => {
      const response = await fetch(`${server.baseUrl}/api/health`);
      assert(response.ok, "Health endpoint should return 200");
    });

    await runCase("Smoke-02 Organizer registration", async () => {
      const response = await context.organizer.request("/api/auth/register", {
        method: "POST",
        json: {
          name: "Smoke Organizer",
          email: randomEmail("smoke-org"),
          password: "secret123",
          role: "organizer",
        },
      });
      assert(response.status === 201, "Organizer registration must be 201");
    });

    await runCase("Smoke-03 Participant registration", async () => {
      const response = await context.participant.request("/api/auth/register", {
        method: "POST",
        json: {
          name: "Smoke Participant",
          email: randomEmail("smoke-part"),
          password: "secret123",
          role: "participant",
        },
      });
      assert(response.status === 201, "Participant registration must be 201");
    });

    await runCase("Smoke-04 Duplicate email blocked", async () => {
      const email = randomEmail("smoke-dup");
      const firstClient = new HttpClient(server.baseUrl);

      const first = await firstClient.request("/api/auth/register", {
        method: "POST",
        json: {
          name: "Dup User A",
          email,
          password: "secret123",
          role: "participant",
        },
      });
      assert(first.status === 201, "First registration should pass");

      const secondClient = new HttpClient(server.baseUrl);
      const second = await secondClient.request("/api/auth/register", {
        method: "POST",
        json: {
          name: "Dup User B",
          email,
          password: "secret123",
          role: "participant",
        },
      });

      assert(second.status === 409, "Duplicate email should return 409");
    });

    await runCase("Smoke-05 Invalid login rejected", async () => {
      const client = new HttpClient(server.baseUrl);
      const register = await client.request("/api/auth/register", {
        method: "POST",
        json: {
          name: "Login Target",
          email: randomEmail("smoke-login"),
          password: "secret123",
          role: "participant",
        },
      });
      assert(register.status === 201, "Setup registration should pass");

      const wrongLogin = await new HttpClient(server.baseUrl).request("/api/auth/login", {
        method: "POST",
        json: {
          email: register.payload.user.email,
          password: "wrong-pass",
        },
      });
      assert(wrongLogin.status === 401, "Wrong password must return 401");
    });

    await runCase("Smoke-06 Organizer creates quiz", async () => {
      const response = await context.organizer.request("/api/quizzes", {
        method: "POST",
        json: {
          title: "Smoke Quiz",
          category: "General",
          questionTimeSec: 6,
          rules: "Smoke rules",
        },
      });
      assert(response.status === 201, "Quiz creation should pass");
      context.quizId = response.payload.quiz.id;
      assert(Number.isInteger(context.quizId), "quizId should be integer");
    });

    await runCase("Smoke-07 Participant cannot create quiz", async () => {
      const response = await context.participant.request("/api/quizzes", {
        method: "POST",
        json: {
          title: "Forbidden",
          category: "Forbidden",
        },
      });
      assert(response.status === 403, "Participant create quiz must be forbidden");
    });

    await runCase("Smoke-08 Add single-choice question", async () => {
      const response = await context.organizer.request(
        `/api/quizzes/${context.quizId}/questions`,
        {
          method: "POST",
          json: {
            prompt: "Capital of France?",
            imageUrl: "",
            allowMultiple: false,
            choices: [
              { text: "Berlin", isCorrect: false },
              { text: "Paris", isCorrect: true },
              { text: "Rome", isCorrect: false },
              { text: "Madrid", isCorrect: false },
            ],
          },
        },
      );
      assert(response.status === 201, "Add question must return 201");
    });

    await runCase("Smoke-09 Add multi-choice question with image", async () => {
      const response = await context.organizer.request(
        `/api/quizzes/${context.quizId}/questions`,
        {
          method: "POST",
          json: {
            prompt: "Pick even numbers",
            imageUrl: "https://example.com/even.png",
            allowMultiple: true,
            choices: [
              { text: "1", isCorrect: false },
              { text: "2", isCorrect: true },
              { text: "4", isCorrect: true },
              { text: "7", isCorrect: false },
            ],
          },
        },
      );
      assert(response.status === 201, "Add multi question must return 201");
    });

    await runCase("Smoke-10 Start session by organizer", async () => {
      const response = await context.organizer.request(`/api/quizzes/${context.quizId}/start`, {
        method: "POST",
        json: {},
      });
      assert(response.status === 201, "Start session should return 201");
      context.roomCode = response.payload.session.roomCode;
      assert(Boolean(context.roomCode), "Room code should exist");
    });

    await runCase("Smoke-11 Room preview by code", async () => {
      const response = await context.participant.request(
        `/api/session/by-code/${encodeURIComponent(context.roomCode)}`,
      );
      assert(response.status === 200, "Session preview should return 200");
      assert(response.payload.session.roomCode === context.roomCode, "Room code mismatch");
    });

    await runCase("Smoke-12 Realtime join and start", async () => {
      context.organizerSocket = createSocket(context.organizer, server.baseUrl);
      context.participantSocket = createSocket(context.participant, server.baseUrl);
      sockets.push(context.organizerSocket, context.participantSocket);

      const organizerJoin = await emitAck(context.organizerSocket, "room:join", {
        code: context.roomCode,
      });
      assert(organizerJoin.ok && organizerJoin.isHost, "Organizer join ack invalid");

      const participantJoin = await emitAck(context.participantSocket, "room:join", {
        code: context.roomCode,
      });
      assert(participantJoin.ok && !participantJoin.isHost, "Participant join ack invalid");

      context.firstQuestionPromise = onceEvent(context.participantSocket, "quiz:question");

      const startAck = await emitAck(context.organizerSocket, "organizer:startQuiz", {
        code: context.roomCode,
      });
      assert(startAck.ok, "Quiz start ack must be ok");
    });

    await runCase("Smoke-13 Participant answers active question", async () => {
      const questionPayload = await context.firstQuestionPromise;
      context.questionId = questionPayload.question.id;

      const selectedChoice = questionPayload.question.choices[0];
      assert(selectedChoice, "Question should contain at least one choice");
      context.correctChoiceId = selectedChoice.id;

      const firstAck = await emitAck(context.participantSocket, "participant:answer", {
        code: context.roomCode,
        questionId: context.questionId,
        choiceIds: [context.correctChoiceId],
      });

      assert(firstAck.ok, "First answer should be accepted");
    });

    await runCase("Smoke-14 Double submit blocked", async () => {
      const secondAck = await emitAck(context.participantSocket, "participant:answer", {
        code: context.roomCode,
        questionId: context.questionId,
        choiceIds: [context.correctChoiceId],
      });

      assert(secondAck.ok === false, "Second answer must be rejected");
      assert(
        secondAck.error === "QUESTION_ALREADY_ANSWERED",
        "Second answer should fail with QUESTION_ALREADY_ANSWERED",
      );
    });

    await runCase("Smoke-15 History available for both roles", async () => {
      await onceEvent(context.organizerSocket, "quiz:finished");

      const organizerHistory = await context.organizer.request("/api/history");
      const participantHistory = await context.participant.request("/api/history");

      assert(organizerHistory.status === 200, "Organizer history must be accessible");
      assert(participantHistory.status === 200, "Participant history must be accessible");
      assert(
        Array.isArray(organizerHistory.payload.history) &&
          organizerHistory.payload.history.length > 0,
        "Organizer history should contain at least one session",
      );
      assert(
        Array.isArray(participantHistory.payload.history) &&
          participantHistory.payload.history.length > 0,
        "Participant history should contain at least one session",
      );
    });

    console.log("\nSMOKE SUMMARY");
    for (const item of cases) {
      console.log(`- ${item.status}: ${item.name}`);
    }
    console.log(`\nSMOKE PASSED: ${cases.length}/${cases.length}`);
  } catch (error) {
    console.error("\nSMOKE FAILED");
    for (const item of cases) {
      const suffix = item.error ? ` -> ${item.error}` : "";
      console.error(`- ${item.status}: ${item.name}${suffix}`);
    }
    console.error("Server log:\n" + server.getLog());
    process.exitCode = 1;
  } finally {
    for (const socket of sockets) {
      if (socket && socket.connected) {
        socket.disconnect();
      } else if (socket) {
        socket.close();
      }
    }

    await server.stop();
  }
}

main();
