const { api, showMessage } = window.appApi;

const loginTabButton = document.getElementById("loginTab");
const registerTabButton = document.getElementById("registerTab");
const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const authMessage = document.getElementById("authMessage");

function activateTab(tabName) {
  const isLogin = tabName === "login";

  loginTabButton.classList.toggle("active", isLogin);
  registerTabButton.classList.toggle("active", !isLogin);
  loginForm.classList.toggle("active", isLogin);
  registerForm.classList.toggle("active", !isLogin);
  showMessage(authMessage, "", "info");
}

loginTabButton.addEventListener("click", () => activateTab("login"));
registerTabButton.addEventListener("click", () => activateTab("register"));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const email = String(loginForm.email.value || "").trim().toLowerCase();
  const password = String(loginForm.password.value || "");

  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });

    window.location.href = "/dashboard";
  } catch (error) {
    showMessage(authMessage, `Ошибка входа: ${error.message}`, "error");
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = String(registerForm.name.value || "").trim();
  const email = String(registerForm.email.value || "").trim().toLowerCase();
  const password = String(registerForm.password.value || "");
  const role = String(registerForm.role.value || "").trim();

  try {
    await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, role }),
    });

    showMessage(authMessage, "Регистрация успешна. Перенаправляю в кабинет...", "success");
    setTimeout(() => {
      window.location.href = "/dashboard";
    }, 600);
  } catch (error) {
    showMessage(authMessage, `Ошибка регистрации: ${error.message}`, "error");
  }
});

async function bootstrapAuthPage() {
  try {
    const payload = await api("/api/auth/me");
    if (payload.user) {
      window.location.href = "/dashboard";
    }
  } catch (error) {
    showMessage(authMessage, `Не удалось проверить сессию: ${error.message}`, "error");
  }
}

bootstrapAuthPage();
