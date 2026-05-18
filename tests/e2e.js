const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

const BASE_URL = "http://localhost:3000";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class HttpClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  _captureCookies(response) {
    let cookieLines = [];

    if (typeof response.headers.getSetCookie === "function") {
      cookieLines = response.headers.getSetCookie();
    } else {
      const singleHeader = response.headers.get("set-cookie");
      if (singleHeader) {
        cookieLines = [singleHeader];
      }
    }

    for (const cookieLine of cookieLines) {
      const firstPart = String(cookieLine).split(";")[0];
      const separatorIndex = firstPart.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = firstPart.slice(0, separatorIndex);
      const value = firstPart.slice(separatorIndex + 1);
      this.cookies.set(key, value);
    }
  }

  async request(route, options = {}) {
    const headers = {
      ...(options.headers || {}),
    };

    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const cookieValue = this.cookieHeader();
    if (cookieValue) {
      headers.Cookie = cookieValue;
    }

    const response = await fetch(`${this.baseUrl}${route}`, {
      method: options.method || "GET",
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    });

    this._captureCookies(response);

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await response.json() : null;

    return {
      ok: response.ok,
      status: response.status,
      payload,
    };
  }
}

function waitForServer(baseUrl, timeoutMs = 20000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          resolve();
          return;
        }
      } catch (error) {
        // Continue polling until timeout.
      }

      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Server did not become healthy in time"));
        return;
      }

      setTimeout(check, 250);
    };

    check();
  });
}

function emitAck(socket, eventName, payload, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout waiting ack for ${eventName}`));
    }, timeoutMs);

    socket.emit(eventName, payload, (ack) => {
      clearTimeout(timeoutId);
      resolve(ack);
    });
  });
}

function onceEvent(socket, eventName, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timeout waiting event ${eventName}`));
    }, timeoutMs);

    const handler = (data) => {
      clearTimeout(timeoutId);
      resolve(data);
    };

    socket.once(eventName, handler);
  });
}

function createSocket(client) {
  return io(BASE_URL, {
    transports: ["websocket"],
    extraHeaders: {
      Cookie: client.cookieHeader(),
    },
  });
}

async function main() {
  const cwd = path.resolve(__dirname, "..");
  const server = spawn("node", ["src/server.js"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });

  const sockets = [];

  try {
    await waitForServer(BASE_URL);

    const organizer = new HttpClient(BASE_URL);
    const participantA = new HttpClient(BASE_URL);
    const participantB = new HttpClient(BASE_URL);
    const participantC = new HttpClient(BASE_URL);

    const uniq = Date.now();

    const registerOrganizer = await organizer.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Org",
        email: `org-${uniq}@mail.test`,
        password: "secret123",
        role: "organizer",
      },
    });
    assert(registerOrganizer.status === 201, "Organizer registration failed");

    const registerA = await participantA.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Alice",
        email: `alice-${uniq}@mail.test`,
        password: "secret123",
        role: "participant",
      },
    });
    assert(registerA.status === 201, "Participant Alice registration failed");

    const registerB = await participantB.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Bob",
        email: `bob-${uniq}@mail.test`,
        password: "secret123",
        role: "participant",
      },
    });
    assert(registerB.status === 201, "Participant Bob registration failed");

    const registerC = await participantC.request("/api/auth/register", {
      method: "POST",
      json: {
        name: "Cara",
        email: `cara-${uniq}@mail.test`,
        password: "secret123",
        role: "participant",
      },
    });
    assert(registerC.status === 201, "Participant Cara registration failed");

    const participantCreateQuiz = await participantA.request("/api/quizzes", {
      method: "POST",
      json: {
        title: "Forbidden quiz",
        category: "Test",
      },
    });
    assert(
      participantCreateQuiz.status === 403,
      "Participant should not be allowed to create quizzes",
    );

    const createQuiz = await organizer.request("/api/quizzes", {
      method: "POST",
      json: {
        title: "Math and Logic",
        category: "Education",
        questionTimeSec: 5,
        rules: "One point for each correct answer",
      },
    });
    assert(createQuiz.status === 201, "Quiz creation failed");

    const quizId = createQuiz.payload && createQuiz.payload.quiz && createQuiz.payload.quiz.id;
    assert(Number.isInteger(quizId), "Quiz id missing");

    const addQuestion1 = await organizer.request(`/api/quizzes/${quizId}/questions`, {
      method: "POST",
      json: {
        prompt: "2 + 2 = ?",
        imageUrl: "",
        allowMultiple: false,
        choices: [
          { text: "3", isCorrect: false },
          { text: "4", isCorrect: true },
          { text: "5", isCorrect: false },
          { text: "6", isCorrect: false },
        ],
      },
    });
    assert(addQuestion1.status === 201, "Failed to add question 1");

    const addQuestion2 = await organizer.request(`/api/quizzes/${quizId}/questions`, {
      method: "POST",
      json: {
        prompt: "Pick prime numbers",
        imageUrl: "https://example.com/prime.png",
        allowMultiple: true,
        choices: [
          { text: "2", isCorrect: true },
          { text: "3", isCorrect: true },
          { text: "4", isCorrect: false },
          { text: "5", isCorrect: true },
        ],
      },
    });
    assert(addQuestion2.status === 201, "Failed to add question 2");

    const startSession = await organizer.request(`/api/quizzes/${quizId}/start`, {
      method: "POST",
      json: {},
    });
    assert(startSession.status === 201, "Failed to create room/session");

    const roomCode =
      startSession.payload &&
      startSession.payload.session &&
      startSession.payload.session.roomCode;
    assert(roomCode, "Room code missing");

    const organizerSocket = createSocket(organizer);
    const socketA = createSocket(participantA);
    const socketB = createSocket(participantB);
    const socketC = createSocket(participantC);
    sockets.push(organizerSocket, socketA, socketB, socketC);

    const finishedPromises = [
      onceEvent(organizerSocket, "quiz:finished", 30000),
      onceEvent(socketA, "quiz:finished", 30000),
      onceEvent(socketB, "quiz:finished", 30000),
      onceEvent(socketC, "quiz:finished", 30000),
    ];

    const questionPlan = {
      Alice: {
        "2 + 2 = ?": ["4"],
        "Pick prime numbers": ["2", "3", "5"],
      },
      Bob: {
        "2 + 2 = ?": ["4"],
        "Pick prime numbers": ["2", "3"],
      },
      Cara: {
        "2 + 2 = ?": ["3"],
        "Pick prime numbers": ["4"],
      },
    };

    const participantSockets = [
      { name: "Alice", socket: socketA },
      { name: "Bob", socket: socketB },
      { name: "Cara", socket: socketC },
    ];

    for (const participant of participantSockets) {
      participant.socket.on("quiz:question", async (payload) => {
        const selectedTexts =
          (questionPlan[participant.name] &&
            questionPlan[participant.name][payload.question.prompt]) ||
          [];

        const choiceIds = payload.question.choices
          .filter((choice) => selectedTexts.includes(choice.text))
          .map((choice) => choice.id);

        await sleep(120);

        participant.socket.emit(
          "participant:answer",
          {
            code: roomCode,
            questionId: payload.question.id,
            choiceIds,
          },
          () => {
            // Ack is validated by leaderboard and final score checks.
          },
        );
      });
    }

    const organizerJoinAck = await emitAck(organizerSocket, "room:join", {
      code: roomCode,
    });
    assert(organizerJoinAck.ok, "Organizer failed to join room");
    assert(organizerJoinAck.isHost === true, "Organizer host flag should be true");

    for (const participant of participantSockets) {
      const joinAck = await emitAck(participant.socket, "room:join", {
        code: roomCode,
      });
      assert(joinAck.ok, `${participant.name} failed to join room`);
      assert(joinAck.isHost === false, `${participant.name} must not be host`);
    }

    const startAck = await emitAck(organizerSocket, "organizer:startQuiz", {
      code: roomCode,
    });
    assert(startAck.ok, "Organizer failed to start quiz");

    const finishedEvents = await Promise.all(finishedPromises);
    const organizerFinished = finishedEvents[0];
    const finalLeaderboard = organizerFinished.leaderboard || [];
    assert(finalLeaderboard.length === 3, "Leaderboard should contain 3 participants");

    const byName = new Map(finalLeaderboard.map((entry) => [entry.name, entry.score]));
    assert(byName.get("Alice") === 2, "Alice should have 2 points");
    assert(byName.get("Bob") === 1, "Bob should have 1 point");
    assert(byName.get("Cara") === 0, "Cara should have 0 points");

    const organizerHistory = await organizer.request("/api/history");
    assert(organizerHistory.status === 200, "Organizer history should be accessible");
    assert(
      Array.isArray(organizerHistory.payload.history) &&
        organizerHistory.payload.history.length >= 1,
      "Organizer history should contain at least one session",
    );

    const participantHistory = await participantA.request("/api/history");
    assert(participantHistory.status === 200, "Participant history should be accessible");
    assert(
      Array.isArray(participantHistory.payload.history) &&
        participantHistory.payload.history.length >= 1,
      "Participant history should contain at least one session",
    );

    const organizerMe = await organizer.request("/api/auth/me");
    assert(
      organizerMe.status === 200 &&
        organizerMe.payload &&
        organizerMe.payload.user &&
        organizerMe.payload.user.role === "organizer",
      "Organizer session check failed",
    );

    console.log("E2E PASSED");
    console.log("Scenario: organizer + 3 participants completed realtime quiz successfully.");
    console.log("Final scores:", Object.fromEntries(byName.entries()));
  } catch (error) {
    console.error("E2E FAILED:", error.message);
    if (serverLog.trim()) {
      console.error("Server log:\n" + serverLog);
    }
    process.exitCode = 1;
  } finally {
    for (const socket of sockets) {
      if (socket && socket.connected) {
        socket.disconnect();
      } else if (socket) {
        socket.close();
      }
    }

    if (!server.killed) {
      server.kill("SIGTERM");
      await sleep(250);
      if (!server.killed) {
        server.kill("SIGKILL");
      }
    }
  }
}

main();
