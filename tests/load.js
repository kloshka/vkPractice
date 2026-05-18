const {
  assert,
  HttpClient,
  startServer,
  emitAck,
  onceEvent,
  createSocket,
  randomEmail,
  clamp,
} = require("./helpers");

async function main() {
  const requestedParticipants = Number.parseInt(process.env.PARTICIPANTS || "20", 10);
  const participantsCount = clamp(
    Number.isFinite(requestedParticipants) ? requestedParticipants : 20,
    10,
    30,
  );

  const server = await startServer(3012);
  const sockets = [];

  try {
    const organizer = new HttpClient(server.baseUrl);
    const participantClients = Array.from({ length: participantsCount }, () => {
      return new HttpClient(server.baseUrl);
    });

    const organizerRegister = await organizer.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Load Organizer",
        email: randomEmail("load-org"),
        password: "secret123",
        role: "organizer",
      },
    });
    assert(organizerRegister.status === 201, "Organizer registration failed");

    await Promise.all(
      participantClients.map((client, index) => {
        return client.request("/api/auth/register", {
          method: "POST",
          json: {
            name: `P${index + 1}`,
            email: randomEmail(`load-p${index + 1}`),
            password: "secret123",
            role: "participant",
          },
        });
      }),
    ).then((responses) => {
      for (const response of responses) {
        assert(response.status === 201, "Participant registration failed in load setup");
      }
    });

    const createQuiz = await organizer.request("/api/quizzes", {
      method: "POST",
      json: {
        title: `Load Quiz ${participantsCount}`,
        category: "Load",
        questionTimeSec: 4,
        rules: "Load test rules",
      },
    });
    assert(createQuiz.status === 201, "Load quiz creation failed");
    const quizId = createQuiz.payload.quiz.id;

    const questions = [
      {
        prompt: "1 + 1 = ?",
        choices: [
          { text: "1", isCorrect: false },
          { text: "2", isCorrect: true },
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: false },
        ],
      },
      {
        prompt: "Sun rises in the ...",
        choices: [
          { text: "North", isCorrect: false },
          { text: "West", isCorrect: false },
          { text: "East", isCorrect: true },
          { text: "South", isCorrect: false },
        ],
      },
      {
        prompt: "5 is",
        choices: [
          { text: "Even", isCorrect: false },
          { text: "Prime", isCorrect: true },
          { text: "Negative", isCorrect: false },
          { text: "Zero", isCorrect: false },
        ],
      },
    ];

    for (const question of questions) {
      const addQuestion = await organizer.request(`/api/quizzes/${quizId}/questions`, {
        method: "POST",
        json: {
          prompt: question.prompt,
          imageUrl: "",
          allowMultiple: false,
          choices: question.choices,
        },
      });
      assert(addQuestion.status === 201, "Load question creation failed");
    }

    const startRoom = await organizer.request(`/api/quizzes/${quizId}/start`, {
      method: "POST",
      json: {},
    });
    assert(startRoom.status === 201, "Load session creation failed");
    const roomCode = startRoom.payload.session.roomCode;

    const organizerSocket = createSocket(organizer, server.baseUrl);
    sockets.push(organizerSocket);

    const participantEntries = participantClients.map((client, index) => {
      const socket = createSocket(client, server.baseUrl);
      sockets.push(socket);
      return {
        index,
        name: `P${index + 1}`,
        socket,
      };
    });

    for (const entry of participantEntries) {
      entry.socket.on("quiz:question", async (payload) => {
        const answerChance = Math.random() < 0.7;
        let choiceIds = [];

        if (answerChance) {
          const correctChoice = payload.question.choices.find((choice) => {
            const normalizedPrompt = payload.question.prompt;
            if (normalizedPrompt === "1 + 1 = ?") {
              return choice.text === "2";
            }
            if (normalizedPrompt === "Sun rises in the ...") {
              return choice.text === "East";
            }
            if (normalizedPrompt === "5 is") {
              return choice.text === "Prime";
            }

            return false;
          });

          if (correctChoice) {
            choiceIds = [correctChoice.id];
          }
        }

        if (!choiceIds.length && payload.question.choices.length) {
          const fallback = payload.question.choices[entry.index % payload.question.choices.length];
          choiceIds = [fallback.id];
        }

        entry.socket.emit(
          "participant:answer",
          {
            code: roomCode,
            questionId: payload.question.id,
            choiceIds,
          },
          () => {
            // Final validation happens via leaderboard checks.
          },
        );
      });
    }

    const startedAt = Date.now();

    const organizerJoin = await emitAck(organizerSocket, "room:join", {
      code: roomCode,
    });
    assert(organizerJoin.ok, "Organizer failed to join load room");

    const joinResponses = await Promise.all(
      participantEntries.map((entry) => {
        return emitAck(entry.socket, "room:join", {
          code: roomCode,
        });
      }),
    );

    const joinedCount = joinResponses.filter((ack) => ack && ack.ok).length;
    assert(
      joinedCount === participantsCount,
      `Expected ${participantsCount} joined participants, got ${joinedCount}`,
    );

    const finishPromise = onceEvent(organizerSocket, "quiz:finished", 45000);

    const startAck = await emitAck(organizerSocket, "organizer:startQuiz", {
      code: roomCode,
    });
    assert(startAck.ok, "Organizer could not start load quiz");

    const finished = await finishPromise;
    const endedAt = Date.now();

    const leaderboard = finished.leaderboard || [];
    assert(
      leaderboard.length === participantsCount,
      `Expected leaderboard with ${participantsCount} participants, got ${leaderboard.length}`,
    );

    const minScore = Math.min(...leaderboard.map((entry) => entry.score));
    const maxScore = Math.max(...leaderboard.map((entry) => entry.score));

    assert(minScore >= 0, "Score should not be negative");
    assert(maxScore <= questions.length, "Score should not exceed number of questions");

    const durationMs = endedAt - startedAt;

    console.log("LOAD PASSED");
    console.log(`Participants: ${participantsCount}`);
    console.log(`Joined: ${joinedCount}`);
    console.log(`Leaderboard size: ${leaderboard.length}`);
    console.log(`Score range: ${minScore}..${maxScore}`);
    console.log(`Duration ms: ${durationMs}`);
  } catch (error) {
    console.error("LOAD FAILED:", error.message);
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
