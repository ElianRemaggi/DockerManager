const state = {
  containers: [],
  stats: [],
  selectedId: "",
  filter: "all",
  query: "",
  view: "list",
  busy: new Set()
};

const els = {
  hostState: document.querySelector("#hostState"),
  runningCount: document.querySelector("#runningCount"),
  stoppedCount: document.querySelector("#stoppedCount"),
  searchInput: document.querySelector("#searchInput"),
  filters: document.querySelectorAll(".filter"),
  viewModes: document.querySelectorAll(".view-mode"),
  refreshButton: document.querySelector("#refreshButton"),
  restartSelected: document.querySelector("#restartSelected"),
  lastUpdated: document.querySelector("#lastUpdated"),
  list: document.querySelector("#containerList"),
  details: document.querySelector("#detailsPanel"),
  detailsContent: document.querySelector("#detailsContent"),
  detailsResizer: document.querySelector(".details-resizer"),
  template: document.querySelector("#containerCardTemplate")
};

const DETAILS_WIDTH_KEY = "dm-details-width";
const DETAILS_WIDTH_DEFAULT = 430;
const DETAILS_WIDTH_MIN = 320;
const DETAILS_WIDTH_MAX_RATIO = 0.65;

function detailsWidthBounds() {
  return {
    min: DETAILS_WIDTH_MIN,
    max: Math.floor(window.innerWidth * DETAILS_WIDTH_MAX_RATIO)
  };
}

function setDetailsWidth(width) {
  const { min, max } = detailsWidthBounds();
  const clamped = Math.min(max, Math.max(min, width));
  document.documentElement.style.setProperty("--details-width", `${clamped}px`);
  localStorage.setItem(DETAILS_WIDTH_KEY, String(clamped));
  return clamped;
}

function initDetailsResize() {
  const saved = Number(localStorage.getItem(DETAILS_WIDTH_KEY));
  if (saved >= DETAILS_WIDTH_MIN) {
    setDetailsWidth(saved);
  }

  const resizer = els.detailsResizer;
  if (!resizer) return;

  let startX = 0;
  let startWidth = 0;

  function canResize() {
    return window.matchMedia("(min-width: 1181px)").matches;
  }

  function onPointerMove(clientX) {
    const delta = startX - clientX;
    setDetailsWidth(startWidth + delta);
  }

  function stopResize() {
    resizer.classList.remove("is-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", stopResize);
  }

  function onMouseMove(event) {
    onPointerMove(event.clientX);
  }

  function startResize(clientX) {
    if (!canResize()) return;
    startX = clientX;
    startWidth = els.details.getBoundingClientRect().width;
    resizer.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopResize);
  }

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    startResize(event.clientX);
  });

  resizer.addEventListener("dblclick", () => {
    if (!canResize()) return;
    setDetailsWidth(DETAILS_WIDTH_DEFAULT);
  });

  resizer.addEventListener("keydown", (event) => {
    if (!canResize()) return;
    const step = event.shiftKey ? 40 : 16;
    const current = els.details.getBoundingClientRect().width;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setDetailsWidth(current + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setDetailsWidth(current - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      setDetailsWidth(DETAILS_WIDTH_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setDetailsWidth(detailsWidthBounds().max);
    }
  });

  window.addEventListener("resize", () => {
    const current = els.details.getBoundingClientRect().width;
    setDetailsWidth(current);
  });
}

initDetailsResize();

function formatDate(value) {
  if (!value || value.startsWith("0001-")) return "sin dato";
  return new Intl.DateTimeFormat("es-AR", {
    dateStyle: "short",
    timeStyle: "medium"
  }).format(new Date(value));
}

function statFor(container) {
  return state.stats.find((item) => item.ID === container.shortId || item.Name === container.name) || {};
}

function portSummary(container) {
  const ports = container.normalizedPorts || [];
  if (!ports.length) return "sin puertos publicados";
  return ports.map((port) => port.label).join(" | ");
}

function severityRank(severity) {
  return { critical: 3, warning: 2, info: 1, ok: 0 }[severity] ?? 0;
}

function topDiagnostic(container) {
  return [...(container.diagnostics || [])].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0];
}

function diagnosticClass(container) {
  return topDiagnostic(container)?.severity || "ok";
}

function renderDiagnostics(diagnostics = []) {
  return `
    <div class="diagnostic-list">
      ${diagnostics.map((item) => `
        <div class="diagnostic ${escapeHtml(item.severity)}">
          <strong>${escapeHtml(item.title)}</strong>
          <p>${escapeHtml(item.detail)}</p>
          ${item.command ? `<code>${escapeHtml(item.command)}</code>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderPorts(container) {
  const ports = container.normalizedPorts || [];
  if (!ports.length) return "<p>Sin puertos publicados.</p>";
  return `
    <div class="port-list">
      ${ports.map((port) => `
        <div class="port-row">
          <span>${escapeHtml(port.label)}</span>
          ${port.url ? `<a href="${escapeHtml(port.url)}" target="_blank" rel="noreferrer">Abrir</a>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function matchesFilter(container) {
  if (state.filter === "running" && !container.running) return false;
  if (state.filter === "stopped" && container.running) return false;
  if (!state.query) return true;
  const haystack = [
    container.name,
    container.image,
    container.status,
    container.description,
    container.compose?.project,
    container.compose?.service
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(state.query.toLowerCase());
}

function composeProject(container) {
  return container.compose?.project || "Sin Docker Compose";
}

function composeService(container) {
  return container.compose?.service || container.name;
}

function setBusy(id, isBusy) {
  if (isBusy) state.busy.add(id);
  else state.busy.delete(id);
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).error || message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") ? response.json() : response.text();
}

async function loadContainers() {
  els.hostState.textContent = "Actualizando Docker...";
  els.refreshButton.disabled = true;
  try {
    const data = await api("/api/containers");
    state.containers = data.containers.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
    state.stats = data.stats;
    els.hostState.textContent = "Conectado al daemon local";
    els.lastUpdated.textContent = `Actualizado ${formatDate(data.generatedAt)}`;
    if (state.selectedId && !state.containers.some((item) => item.id === state.selectedId)) {
      state.selectedId = "";
    }
    render();
  } catch (error) {
    els.hostState.textContent = "Error de conexión";
    els.list.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
  } finally {
    els.refreshButton.disabled = false;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function runAction(container, action) {
  setBusy(container.id, true);
  try {
    await api(`/api/containers/${encodeURIComponent(container.name)}/${action}`, { method: "POST" });
    await loadContainers();
    const updated = state.containers.find((item) => item.name === container.name);
    if (updated) {
      state.selectedId = updated.id;
      showDetails(updated);
    }
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(container.id, false);
  }
}

async function runBulkAction(containers, action) {
  const ids = containers.map((container) => container.name).filter(Boolean);
  if (!ids.length) return;

  for (const container of containers) setBusy(container.id, true);
  try {
    await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ action, ids })
    });
    await loadContainers();
  } catch (error) {
    alert(error.message);
  } finally {
    for (const container of containers) state.busy.delete(container.id);
    render();
  }
}

async function loadLogs(container, tail = 250) {
  const logTarget = document.querySelector("#logsOutput");
  if (!logTarget) return;
  logTarget.textContent = "Cargando logs...";
  try {
    const logs = await api(`/api/containers/${encodeURIComponent(container.name)}/logs?tail=${tail}`);
    logTarget.textContent = logs || "Sin logs para mostrar.";
  } catch (error) {
    logTarget.textContent = error.message;
  }
}

function render() {
  const running = state.containers.filter((item) => item.running).length;
  els.runningCount.textContent = running;
  els.stoppedCount.textContent = state.containers.length - running;

  const visible = state.containers.filter(matchesFilter);
  els.list.innerHTML = "";

  if (!visible.length) {
    els.list.innerHTML = `<div class="empty-state">No hay contenedores para este filtro.</div>`;
    renderDetails();
    return;
  }

  if (state.view === "compose") {
    renderComposeGroups(visible);
  } else {
    for (const container of visible) {
      els.list.append(renderContainerCard(container));
    }
  }

  renderDetails();
}

function renderContainerCard(container) {
  const card = els.template.content.firstElementChild.cloneNode(true);
  const stats = statFor(container);
  const isBusy = state.busy.has(container.id);

  card.classList.toggle("selected", container.id === state.selectedId);
  card.querySelector(".select-container").dataset.id = container.id;
  card.querySelector(".status-dot").classList.add(container.running ? "running" : "stopped");
  card.querySelector(".card-title").textContent = state.view === "compose" ? composeService(container) : container.name;
  card.querySelector(".card-subtitle").textContent = state.view === "compose" ? container.name : container.image || container.shortId;
  card.querySelector(".description").textContent = container.description || "Sin descripción en labels.";

  const diagnostic = topDiagnostic(container);
  const info = [
    container.status,
    container.health?.status ? `health: ${container.health.status}` : "",
    diagnostic ? diagnostic.title : "",
    container.compose?.project ? `compose: ${container.compose.project}/${container.compose.service}` : "",
    container.compose?.orphaned ? "compose huérfano" : "",
    stats.CPUPerc ? `CPU ${stats.CPUPerc}` : "",
    stats.MemUsage ? `RAM ${stats.MemUsage}` : "",
    portSummary(container)
  ].filter(Boolean);
  card.querySelector(".info-row").innerHTML = info.map((item) => `<span class="pill ${escapeHtml(diagnosticClass(container))}">${escapeHtml(item)}</span>`).join("");

  card.querySelector(".card-main").addEventListener("click", () => {
    state.selectedId = container.id;
    render();
    showDetails(container);
  });

  const startButton = card.querySelector(".start");
  const stopButton = card.querySelector(".stop");
  const restartButton = card.querySelector(".restart");
  const logsButton = card.querySelector(".logs");
  startButton.disabled = container.running || isBusy;
  stopButton.disabled = !container.running || isBusy;
  restartButton.disabled = !container.running || isBusy;
  logsButton.disabled = isBusy;
  startButton.addEventListener("click", () => runAction(container, "start"));
  stopButton.addEventListener("click", () => runAction(container, "stop"));
  restartButton.addEventListener("click", () => runAction(container, "restart"));
  logsButton.addEventListener("click", () => {
    state.selectedId = container.id;
    render();
    showDetails(container, true);
  });

  return card;
}

function renderComposeGroups(containers) {
  const groups = new Map();
  for (const container of containers) {
    const project = composeProject(container);
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push(container);
  }

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === "Sin Docker Compose") return 1;
    if (b === "Sin Docker Compose") return -1;
    return a.localeCompare(b);
  });

  for (const [project, projectContainers] of sortedGroups) {
    const group = document.createElement("section");
    group.className = "compose-group";

    const running = projectContainers.filter((container) => container.running).length;
    const stopped = projectContainers.length - running;
    const workingDir = projectContainers.find((container) => container.compose?.workingDir)?.compose?.workingDir || "";
    const orphaned = projectContainers.some((container) => container.compose?.orphaned);
    const critical = projectContainers.some((container) => (container.diagnostics || []).some((item) => item.severity === "critical"));
    const runnable = projectContainers.filter((container) => !container.running);
    const stoppable = projectContainers.filter((container) => container.running);

    group.innerHTML = `
      <header class="compose-head">
        <div>
          <div class="compose-title">
            <h3>${escapeHtml(project)}</h3>
            <span class="pill">${projectContainers.length} contenedores</span>
            <span class="pill">${running} activos</span>
            <span class="pill">${stopped} detenidos</span>
            ${orphaned ? `<span class="pill warning">huérfano</span>` : ""}
            ${critical ? `<span class="pill critical">requiere atención</span>` : ""}
          </div>
          <div class="compose-meta">${escapeHtml(workingDir || "Contenedores sin metadata de docker compose")}</div>
        </div>
        <div class="compose-actions">
          <button class="compose-start" ${runnable.length ? "" : "disabled"}>Prender grupo</button>
          <button class="compose-stop danger" ${stoppable.length ? "" : "disabled"}>Apagar grupo</button>
          <button class="compose-restart secondary" ${stoppable.length ? "" : "disabled"}>Reiniciar grupo</button>
        </div>
      </header>
    `;

    group.querySelector(".compose-start").addEventListener("click", () => runBulkAction(runnable, "start"));
    group.querySelector(".compose-stop").addEventListener("click", () => runBulkAction(stoppable, "stop"));
    group.querySelector(".compose-restart").addEventListener("click", () => runBulkAction(stoppable, "restart"));

    for (const container of projectContainers.sort((a, b) => composeService(a).localeCompare(composeService(b)))) {
      group.append(renderContainerCard(container));
    }

    els.list.append(group);
  }
}

function renderDetails() {
  if (!state.selectedId) return;
  const container = state.containers.find((item) => item.id === state.selectedId);
  if (container) showDetails(container, false);
}

function listObject(value) {
  if (!value || (Array.isArray(value) && !value.length) || (!Array.isArray(value) && !Object.keys(value).length)) {
    return "<p>Sin datos.</p>";
  }
  return `<pre class="code-block">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderMounts(mounts = []) {
  if (!mounts.length) return "<p>Sin datos.</p>";
  return `
    <div class="mount-list">
      ${mounts.map((mount) => `
        <div class="mount-row ${mount.hostPathExists === false ? "missing" : ""}">
          <div>
            <strong>${escapeHtml(mount.destination)}</strong>
            <p>${escapeHtml(mount.source || "sin source")}</p>
          </div>
          <span class="pill ${mount.hostPathExists === false ? "critical" : "ok"}">
            ${mount.hostPathExists === false ? "no existe" : "ok"}
          </span>
        </div>
      `).join("")}
    </div>
  `;
}

function showDetails(container, openLogs = false) {
  const stats = statFor(container);
  els.detailsContent.innerHTML = `
    <div class="details-head">
      <h2>${escapeHtml(container.name)}</h2>
      <p>${escapeHtml(container.image || container.shortId)}</p>
      <div class="action-row">
        <button id="detailStart" ${container.running ? "disabled" : ""}>Prender</button>
        <button id="detailStop" class="danger" ${container.running ? "" : "disabled"}>Apagar</button>
        <button id="detailRestart" class="secondary" ${container.running ? "" : "disabled"}>Reiniciar</button>
      </div>
    </div>
    <div class="section">
      <h3>Estado</h3>
      <dl class="kv">
        <dt>Estado</dt><dd>${escapeHtml(container.status)}</dd>
        <dt>Health</dt><dd>${escapeHtml(container.health?.status || "sin healthcheck")}</dd>
        <dt>PID</dt><dd>${escapeHtml(container.pid || "sin proceso")}</dd>
        <dt>Exit code</dt><dd>${escapeHtml(container.exitCode)}</dd>
        <dt>Inicio</dt><dd>${escapeHtml(formatDate(container.startedAt))}</dd>
        <dt>Creado</dt><dd>${escapeHtml(formatDate(container.created))}</dd>
        <dt>CPU</dt><dd>${escapeHtml(stats.CPUPerc || "sin dato")}</dd>
        <dt>Memoria</dt><dd>${escapeHtml(stats.MemUsage || "sin dato")}</dd>
        <dt>Red I/O</dt><dd>${escapeHtml(stats.NetIO || "sin dato")}</dd>
        <dt>Block I/O</dt><dd>${escapeHtml(stats.BlockIO || "sin dato")}</dd>
      </dl>
    </div>
    <div class="section">
      <h3>Diagnóstico</h3>
      ${renderDiagnostics(container.diagnostics || [])}
    </div>
    <div class="section">
      <h3>Descripción</h3>
      <p>${escapeHtml(container.description || "No hay labels de descripción para este contenedor.")}</p>
    </div>
    <div class="section">
      <h3>Puertos</h3>
      ${renderPorts(container)}
    </div>
    <div class="section">
      <h3>Volúmenes</h3>
      ${renderMounts(container.mounts)}
    </div>
    <div class="section">
      <h3>Redes</h3>
      ${listObject(container.networks)}
    </div>
    <div class="section">
      <h3>Configuración</h3>
      <dl class="kv">
        <dt>ID</dt><dd>${escapeHtml(container.shortId)}</dd>
        <dt>Comando</dt><dd>${escapeHtml(container.command || "sin dato")}</dd>
        <dt>Workdir</dt><dd>${escapeHtml(container.workingDir || "sin dato")}</dd>
        <dt>Compose</dt><dd>${escapeHtml(container.compose?.project ? `${container.compose.project}/${container.compose.service}` : "sin compose")}</dd>
        <dt>Compose dir</dt><dd>${escapeHtml(container.compose?.workingDir || "sin dato")}</dd>
        <dt>Restart</dt><dd>${escapeHtml(JSON.stringify(container.hostConfig.restartPolicy))}</dd>
        <dt>Privileged</dt><dd>${escapeHtml(container.hostConfig.privileged ? "sí" : "no")}</dd>
      </dl>
    </div>
    <div class="section">
      <h3>Variables de entorno</h3>
      ${listObject(container.env)}
    </div>
    <div class="section">
      <h3>Labels</h3>
      ${listObject(container.labels)}
    </div>
    <div class="section">
      <h3>Logs</h3>
      <div class="log-tools">
        <select id="tailSelect">
          <option value="100">100 líneas</option>
          <option value="250" selected>250 líneas</option>
          <option value="500">500 líneas</option>
          <option value="1000">1000 líneas</option>
        </select>
        <button id="loadLogs" class="secondary">Cargar logs</button>
      </div>
      <pre id="logsOutput" class="code-block">Logs no cargados.</pre>
    </div>
  `;

  els.detailsContent.querySelector("#detailStart").addEventListener("click", () => runAction(container, "start"));
  els.detailsContent.querySelector("#detailStop").addEventListener("click", () => runAction(container, "stop"));
  els.detailsContent.querySelector("#detailRestart").addEventListener("click", () => runAction(container, "restart"));
  els.detailsContent.querySelector("#loadLogs").addEventListener("click", () => {
    loadLogs(container, Number(els.detailsContent.querySelector("#tailSelect").value));
  });

  if (openLogs) loadLogs(container);
}

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  render();
});

els.filters.forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    els.filters.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

els.viewModes.forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    els.viewModes.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

els.refreshButton.addEventListener("click", loadContainers);

els.restartSelected.addEventListener("click", async () => {
  const ids = [...document.querySelectorAll(".select-container:checked")].map((item) => {
    const container = state.containers.find((candidate) => candidate.id === item.dataset.id);
    return container?.name;
  }).filter(Boolean);
  if (!ids.length) {
    alert("Seleccioná al menos un contenedor.");
    return;
  }
  els.restartSelected.disabled = true;
  try {
    await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ action: "restart", ids })
    });
    await loadContainers();
  } catch (error) {
    alert(error.message);
  } finally {
    els.restartSelected.disabled = false;
  }
});

loadContainers();
setInterval(loadContainers, 30000);
