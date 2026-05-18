(function bootstrapClientHelpers() {
  async function api(path, options = {}) {
    const fetchOptions = { ...options };
    fetchOptions.headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    const response = await fetch(path, fetchOptions);
    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const payload = isJson ? await response.json() : null;

    if (!response.ok) {
      const message = payload && payload.error ? payload.error : "REQUEST_FAILED";
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    return payload;
  }

  function showMessage(element, text, type = "info") {
    if (!element) {
      return;
    }

    if (!text) {
      element.textContent = "";
      element.className = "message";
      return;
    }

    element.textContent = text;
    element.className = `message ${type} visible`;
  }

  function formatDate(value) {
    if (!value) {
      return "-";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }

    return date.toLocaleString("ru-RU");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  window.appApi = {
    api,
    showMessage,
    formatDate,
    escapeHtml,
  };
})();
