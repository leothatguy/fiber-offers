window.addEventListener("DOMContentLoaded", () => {
  for (const code of document.querySelectorAll(".docs-main pre > code")) {
    const source = code.textContent;
    const pre = code.parentElement;
    const language = code.dataset.language ?? pre.dataset.language ?? inferLanguage(source);

    pre.dataset.language = language === "plain" ? "code" : language;
    code.classList.add(`language-${language}`);
    code.innerHTML = highlight(source, language);
  }

  setupDocumentationScrollSpy();
  setupMobileSidebarActiveLink();
});

function setupMobileSidebarActiveLink() {
  const sidebar = document.querySelector(".docs-sidebar");
  const activeLink = sidebar?.querySelector('a[aria-current="page"]');
  if (!sidebar || !activeLink) return;

  const revealActiveLink = () => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const sidebarRect = sidebar.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    sidebar.scrollLeft += linkRect.left - sidebarRect.left - (sidebar.clientWidth - linkRect.width) / 2;
  };

  requestAnimationFrame(revealActiveLink);
  window.addEventListener("resize", revealActiveLink);
}

function setupDocumentationScrollSpy() {
  const toc = document.querySelector(".docs-toc");
  if (!toc) return;

  const sections = [...toc.querySelectorAll('a[href^="#"]')]
    .map((link) => ({ link, section: document.getElementById(link.getAttribute("href").slice(1)) }))
    .filter((entry) => entry.section);
  if (sections.length === 0) return;

  let frame;
  let pendingHashTarget = sectionForHash();
  const updateActiveSection = () => {
    frame = undefined;
    const readingLine = Math.max(120, window.innerHeight * 0.3);
    let active = pendingHashTarget ?? sections[0];

    if (!pendingHashTarget) {
      for (const entry of sections) {
        if (entry.section.getBoundingClientRect().top <= readingLine) active = entry;
      }
    }

    for (const entry of sections) {
      entry.link.classList.toggle("is-active", entry === active);
    }
  };
  const scheduleUpdate = () => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(updateActiveSection);
  };

  function sectionForHash() {
    const hash = location.hash.slice(1);
    return sections.find((entry) => entry.section.id === hash);
  }

  window.addEventListener("scroll", () => {
    pendingHashTarget = undefined;
    scheduleUpdate();
  }, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("hashchange", () => {
    pendingHashTarget = sectionForHash();
    scheduleUpdate();
  });
  updateActiveSection();
  requestAnimationFrame(scheduleUpdate);
  setTimeout(scheduleUpdate, 80);
}

function inferLanguage(source) {
  const trimmed = source.trim();
  if (/^[{[]/.test(trimmed)) return "json";
  if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//m.test(trimmed)) return "http";
  if (/^[A-Za-z-]+:\s+\S+/m.test(trimmed)) return "http";
  if (/\b(import|export|const|let|await|async|function|class|=>)\b/.test(source)) return "javascript";
  if (/^(?:[A-Z][A-Z0-9_]*=|curl\b|npm\b|node\b|#)/m.test(trimmed) || /\n[A-Z][A-Z0-9_]*=/.test(source)) {
    return "shell";
  }
  return "plain";
}

function highlight(source, language) {
  if (language === "json") return highlightJson(source);
  if (language === "javascript") return highlightJavaScript(source);
  if (language === "http") return highlightHttp(source);
  if (language === "shell") return highlightShell(source);
  return highlightPlain(source);
}

function withTokens(source, transform) {
  const tokens = [];
  const hold = (value, type) => {
    const marker = `\uE000T${tokens.length}X\uE001`;
    tokens.push({ value, type });
    return marker;
  };
  const transformed = transform(source, hold);
  return escapeHtml(transformed).replace(/\uE000T(\d+)X\uE001/g, (_, index) => {
    const token = tokens[Number(index)];
    return `<span class="token-${token.type}">${escapeHtml(token.value)}</span>`;
  });
}

function highlightJson(source) {
  return withTokens(source, (input, hold) => {
    let result = input.replace(/("(?:\\.|[^"\\])*")(\s*:)?/g, (_, value, colon) => {
      return `${hold(value, colon ? "property" : "string")}${colon ?? ""}`;
    });
    result = result.replace(/\b(true|false|null)\b/g, (value) => hold(value, "boolean"));
    return result.replace(/(^|[^\w.])(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi, (_, prefix, value) => {
      return `${prefix}${hold(value, "number")}`;
    });
  });
}

function highlightJavaScript(source) {
  return withTokens(source, (input, hold) => {
    let result = input.replace(/\/\/.*$/gm, (value) => hold(value, "comment"));
    result = result.replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) => hold(value, "string"));
    result = result.replace(/\b(import|from|export|const|let|var|async|await|function|return|if|else|new|throw|class|try|catch)\b/g, (value) => hold(value, "keyword"));
    result = result.replace(/\b(true|false|null|undefined)\b/g, (value) => hold(value, "boolean"));
    result = result.replace(/\b(Error|Promise|Buffer|console)\b/g, (value) => hold(value, "variable"));
    result = result.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, (value) => hold(value, "function"));
    result = result.replace(/\.([A-Za-z_$][\w$]*)/g, (_, value) => `.${hold(value, "property")}`);
    return result.replace(/(^|[^\w.])(\d+(?:\.\d+)?)/g, (_, prefix, value) => `${prefix}${hold(value, "number")}`);
  });
}

function highlightShell(source) {
  return withTokens(source, (input, hold) => {
    let result = input.replace(/(^|\s)(#.*$)/gm, (_, prefix, value) => `${prefix}${hold(value, "comment")}`);
    result = result.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) => hold(value, "string"));
    result = result.replace(/https?:\/\/[^\s'"\\]+/g, (value) => hold(value, "url"));
    result = result.replace(/(^|\n)([A-Za-z-]+)(?=:\s)/g, (_, prefix, value) => `${prefix}${hold(value, "header")}`);
    result = result.replace(/\b[A-Z][A-Z0-9_]*(?==)/g, (value) => hold(value, "variable"));
    result = result.replace(/=(?!\s)([A-Za-z_][A-Za-z0-9_-]*)/g, (_, value) => `=${hold(value, "string")}`);
    result = result.replace(/--[a-z][a-z-]*/gi, (value) => hold(value, "property"));
    result = result.replace(/(^|\n)(\s*)(curl|npm|node|GET|POST|PUT|PATCH|DELETE)\b/g, (_, prefix, space, value) => {
      return `${prefix}${space}${hold(value, "command")}`;
    });
    result = result.replace(/\b(curl|npm|node)\b/g, (value) => hold(value, "command"));
    result = result.replace(/\b(Bearer|run|install|verify|dev)\b/g, (value) => hold(value, "keyword"));
    result = result.replace(/\bfiber:[a-z0-9-]+\b/gi, (value) => hold(value, "string"));
    result = result.replace(/\b(true|false)\b/g, (value) => hold(value, "boolean"));
    result = result.replace(/\\(?=\s*$|\n)/gm, (value) => hold(value, "operator"));
    return result.replace(/(^|[^\w.])(\d+(?:\.\d+)?)/g, (_, prefix, value) => `${prefix}${hold(value, "number")}`);
  });
}

function highlightHttp(source) {
  return withTokens(source, (input, hold) => {
    let result = input.replace(/(^|\s)(#.*$)/gm, (_, prefix, value) => `${prefix}${hold(value, "comment")}`);
    result = result.replace(/("(?:\\.|[^"\\])*")(\s*:)?/g, (_, value, colon) => {
      return `${hold(value, colon ? "property" : "string")}${colon ?? ""}`;
    });
    result = result.replace(/(^|\n)(GET|POST|PUT|PATCH|DELETE)(?=\s)/g, (_, prefix, value) => `${prefix}${hold(value, "command")}`);
    result = result.replace(/(^|\n)([A-Za-z-]+)(?=:\s)/g, (_, prefix, value) => `${prefix}${hold(value, "header")}`);
    result = result.replace(/(:\s*)([A-Za-z][A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9._-]*)*)/g, (_, prefix, value) => {
      return `${prefix}${hold(value, "string")}`;
    });
    result = result.replace(/\/[A-Za-z0-9_:.?=&{}-]+(?:\/[A-Za-z0-9_:.?=&{}-]+)*/g, (value) => hold(value, "url"));
    result = result.replace(/\b(Bearer)\b/g, (value) => hold(value, "keyword"));
    result = result.replace(/\b(true|false|null)\b/g, (value) => hold(value, "boolean"));
    return result.replace(/(^|[^\w.])(-?\d+(?:\.\d+)?)/g, (_, prefix, value) => `${prefix}${hold(value, "number")}`);
  });
}

function highlightPlain(source) {
  return withTokens(source, (input, hold) => {
    let result = input.replace(/(^|\s)(#.*$)/gm, (_, prefix, value) => `${prefix}${hold(value, "comment")}`);
    result = result.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) => hold(value, "string"));
    result = result.replace(/https?:\/\/[^\s'"\\]+/g, (value) => hold(value, "url"));
    result = result.replace(/(^|\n)([A-Za-z-]+)(?=:\s)/g, (_, prefix, value) => `${prefix}${hold(value, "header")}`);
    result = result.replace(/\/[A-Za-z0-9_:.?=&{}-]+(?:\/[A-Za-z0-9_:.?=&{}-]+)*/g, (value) => hold(value, "url"));
    result = result.replace(/\b[A-Z][A-Z0-9_]*(?==)/g, (value) => hold(value, "variable"));
    result = result.replace(/\b(Bearer|GET|POST|PUT|PATCH|DELETE|curl|npm|node)\b/g, (value) => hold(value, "keyword"));
    result = result.replace(/\b(true|false|null)\b/g, (value) => hold(value, "boolean"));
    return result.replace(/(^|[^\w.])(-?\d+(?:\.\d+)?)/g, (_, prefix, value) => `${prefix}${hold(value, "number")}`);
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
