const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");

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

async function startServer(port) {
  const resolvedPort = Number(port) || 3010;
  const cwd = path.resolve(__dirname, "..");
  const server = spawn("node", ["src/server.js"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: {
      ...process.env,
      PORT: String(resolvedPort),
    },
  });

  let serverLog = "";
  server.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });

  const baseUrl = `http://localhost:${resolvedPort}`;
  await waitForServer(baseUrl);

  return {
    baseUrl,
    getLog: () => serverLog,
    async stop() {
      if (server.exitCode !== null || server.killed) {
        return;
      }

      server.kill("SIGTERM");
      await sleep(300);

      if (server.exitCode === null && !server.killed) {
        server.kill("SIGKILL");
      }
    },
  };
}

function emitAck(socket, eventName, payload, timeoutMs = 8000) {
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

function onceEvent(socket, eventName, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      clearTimeout(timeoutId);
      resolve(payload);
    };

    const timeoutId = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timeout waiting event ${eventName}`));
    }, timeoutMs);

    socket.once(eventName, handler);
  });
}

function createSocket(client, baseUrl) {
  return io(baseUrl, {
    transports: ["websocket"],
    extraHeaders: {
      Cookie: client.cookieHeader(),
    },
  });
}

function randomEmail(prefix) {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  return `${prefix}-${suffix}@mail.test`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = {
  assert,
  sleep,
  HttpClient,
  startServer,
  emitAck,
  onceEvent,
  createSocket,
  randomEmail,
  clamp,
};
