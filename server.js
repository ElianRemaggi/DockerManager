import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8088);
const dockerBin = process.env.DOCKER_BIN || "docker";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function docker(args, options = {}) {
  const timeout = options.timeout || 15000;
  const maxBuffer = options.maxBuffer || 1024 * 1024 * 8;

  return new Promise((resolve, reject) => {
    execFile(dockerBin, args, { timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message || "Docker command failed";
        reject(Object.assign(new Error(message), { statusCode: 500 }));
        return;
      }
      resolve(stdout);
    });
  });
}

function dockerCombined(args, options = {}) {
  const timeout = options.timeout || 15000;
  const maxBuffer = options.maxBuffer || 1024 * 1024 * 8;

  return new Promise((resolve, reject) => {
    execFile(dockerBin, args, { timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message || "Docker command failed";
        reject(Object.assign(new Error(message), { statusCode: 500 }));
        return;
      }
      resolve([stdout, stderr].filter(Boolean).join(""));
    });
  });
}

function runCommand(command, args, options = {}) {
  const timeout = options.timeout || 8000;
  const maxBuffer = options.maxBuffer || 1024 * 1024 * 2;

  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(stderr?.trim() || error.message), { statusCode: 500 }));
        return;
      }
      resolve(stdout);
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function text(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 32) {
        reject(Object.assign(new Error("Request too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJsonLines(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function safeContainerRef(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value || "")) {
    throw Object.assign(new Error("Invalid container id or name"), { statusCode: 400 });
  }
  return value;
}

function redactEnv(env = []) {
  const secretPattern = /(PASS|PASSWORD|TOKEN|SECRET|KEY|CREDENTIAL|AUTH|COOKIE)/i;
  return env.map((entry) => {
    const index = entry.indexOf("=");
    if (index === -1) return entry;
    const name = entry.slice(0, index);
    return secretPattern.test(name) ? `${name}=********` : entry;
  });
}

function labelsToDescription(labels = {}) {
  const candidates = [
    "description",
    "org.opencontainers.image.description",
    "org.label-schema.description"
  ];

  for (const key of candidates) {
    if (labels[key]) return labels[key];
  }
  return "";
}

async function pathExists(path) {
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizePorts(ports = {}) {
  return Object.entries(ports).flatMap(([containerPort, bindings]) => {
    if (!bindings) {
      return [{
        containerPort,
        published: false,
        label: `${containerPort} no publicado`
      }];
    }

    return bindings.map((binding) => {
      const hostIp = binding.HostIp || "0.0.0.0";
      const hostPort = binding.HostPort || "";
      return {
        containerPort,
        hostIp,
        hostPort,
        published: Boolean(hostPort),
        label: `${hostIp}:${hostPort}->${containerPort}`,
        url: hostPort ? `http://${hostIp === "0.0.0.0" || hostIp === "::" ? "localhost" : hostIp}:${hostPort}` : ""
      };
    });
  });
}

function parseHostListeners(output) {
  const listeners = [];
  for (const line of output.split("\n")) {
    if (!line.startsWith("LISTEN")) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[3] || "";
    const processText = parts.slice(5).join(" ");
    const match = local.match(/(?:\[.*\]|[^:]+):(\d+)$/);
    if (!match) continue;
    const processName = processText.match(/\("([^"]+)"/)?.[1] || "";
    listeners.push({
      port: match[1],
      local,
      process: processName,
      raw: processText
    });
  }
  return listeners;
}

async function getHostListeners() {
  const output = await runCommand("ss", ["-ltnp"], { timeout: 8000 }).catch(() => "");
  return parseHostListeners(output);
}

function buildDiagnostics(container, hostListeners = []) {
  const diagnostics = [];
  const add = (severity, title, detail, command = "") => diagnostics.push({ severity, title, detail, command });
  const compose = container.compose || {};

  if (compose.project && compose.workingDir && compose.orphaned) {
    add(
      "warning",
      "Compose huérfano",
      `El contenedor conserva labels del proyecto ${compose.project}, pero ${compose.workingDir} no existe en el host.`,
      `docker rm ${container.name}`
    );
  }

  for (const mount of container.mounts || []) {
    if ((mount.type === "bind" || mount.type === "volume") && mount.source && mount.hostPathExists === false) {
      add(
        "critical",
        "Path montado inexistente",
        `${mount.source} no existe en el host y está montado en ${mount.destination}.`,
        `ls -la ${mount.source}`
      );
    }
  }

  if (!container.running && container.exitCode !== 0) {
    add(
      "critical",
      "El contenedor salió con error",
      `Estado ${container.status}, exit code ${container.exitCode}.`,
      `docker logs --tail 120 ${container.name}`
    );
  } else if (!container.running) {
    add(
      "info",
      "Contenedor detenido",
      `Estado ${container.status}, exit code ${container.exitCode}.`,
      `docker start ${container.name}`
    );
  }

  if (container.running && container.restartCount > 3) {
    add(
      "warning",
      "Reinicios repetidos",
      `Docker registra ${container.restartCount} reinicios.`,
      `docker logs --tail 120 ${container.name}`
    );
  }

  if (container.health?.status && container.health.status !== "healthy") {
    add(
      container.health.status === "unhealthy" ? "critical" : "warning",
      "Healthcheck no saludable",
      `Healthcheck en estado ${container.health.status}.`,
      `docker inspect ${container.name}`
    );
  }

  for (const port of container.normalizedPorts || []) {
    if (!port.published || !port.hostPort) continue;
    const conflicts = hostListeners.filter((listener) => {
      if (listener.port !== port.hostPort) return false;
      if (container.running && listener.process === "docker-proxy") return false;
      return true;
    });
    for (const conflict of conflicts) {
      add(
        "warning",
        "Puerto ocupado en el host",
        `El puerto ${port.hostPort} aparece ocupado por ${conflict.process || conflict.local}.`,
        `ss -ltnp | grep :${port.hostPort}`
      );
    }
  }

  if (!diagnostics.length) {
    add("ok", "Sin problemas obvios", "No se detectaron binds faltantes, compose huérfano ni errores de estado.", "");
  }

  return diagnostics;
}

async function summarizeContainer(container, hostListeners) {
  const state = container.State || {};
  const config = container.Config || {};
  const networkSettings = container.NetworkSettings || {};
  const labels = config.Labels || {};
  const mounts = container.Mounts || [];
  const ports = networkSettings.Ports || {};
  const networks = networkSettings.Networks || {};

  const composeWorkingDir = labels["com.docker.compose.project.working_dir"] || "";
  const mountSummaries = await Promise.all(mounts.map(async (mount) => ({
    type: mount.Type,
    source: mount.Source,
    destination: mount.Destination,
    mode: mount.Mode,
    rw: mount.RW,
    hostPathExists: mount.Source ? await pathExists(mount.Source) : null
  })));

  const summary = {
    id: container.Id,
    shortId: container.Id?.slice(0, 12),
    name: container.Name?.replace(/^\//, ""),
    image: config.Image,
    imageId: container.Image,
    command: container.Path
      ? [container.Path, ...(container.Args || [])].join(" ")
      : "",
    created: container.Created,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt,
    status: state.Status,
    running: Boolean(state.Running),
    restarting: Boolean(state.Restarting),
    paused: Boolean(state.Paused),
    exitCode: state.ExitCode,
    pid: state.Pid,
    restartCount: container.RestartCount,
    platform: container.Platform,
    driver: container.Driver,
    description: labelsToDescription(labels),
    labels,
    compose: {
      project: labels["com.docker.compose.project"] || "",
      service: labels["com.docker.compose.service"] || "",
      workingDir: composeWorkingDir,
      workingDirExists: composeWorkingDir ? await pathExists(composeWorkingDir) : null,
      orphaned: Boolean(labels["com.docker.compose.project"] && composeWorkingDir && !(await pathExists(composeWorkingDir)))
    },
    ports,
    normalizedPorts: normalizePorts(ports),
    mounts: mountSummaries,
    networks: Object.fromEntries(
      Object.entries(networks).map(([name, value]) => [
        name,
        {
          ipAddress: value.IPAddress,
          gateway: value.Gateway,
          aliases: value.Aliases || []
        }
      ])
    ),
    env: redactEnv(config.Env || []),
    health: state.Health ? {
      status: state.Health.Status,
      failingStreak: state.Health.FailingStreak,
      log: (state.Health.Log || []).slice(-3).map((entry) => ({
        start: entry.Start,
        end: entry.End,
        exitCode: entry.ExitCode,
        output: entry.Output
      }))
    } : null,
    workingDir: config.WorkingDir,
    entrypoint: config.Entrypoint,
    exposedPorts: config.ExposedPorts || {},
    hostConfig: {
      restartPolicy: container.HostConfig?.RestartPolicy || {},
      networkMode: container.HostConfig?.NetworkMode,
      privileged: container.HostConfig?.Privileged,
      memory: container.HostConfig?.Memory,
      nanoCpus: container.HostConfig?.NanoCpus
    }
  };

  summary.diagnostics = buildDiagnostics(summary, hostListeners);
  return summary;
}

async function listContainers() {
  const idsOutput = await docker(["ps", "-aq"], { timeout: 10000 });
  const ids = idsOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) return [];

  const [inspectOutput, hostListeners] = await Promise.all([
    docker(["inspect", ...ids], { timeout: 20000 }),
    getHostListeners()
  ]);
  return Promise.all(JSON.parse(inspectOutput).map((container) => summarizeContainer(container, hostListeners)));
}

async function getStats() {
  const output = await docker(
    [
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}"
    ],
    { timeout: 20000 }
  );
  return parseJsonLines(output);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/containers") {
    const [containers, stats] = await Promise.all([
      listContainers(),
      getStats().catch(() => [])
    ]);
    json(res, 200, { containers, stats, generatedAt: new Date().toISOString() });
    return;
  }

  const actionMatch = url.pathname.match(/^\/api\/containers\/([^/]+)\/(start|stop|restart)$/);
  if (req.method === "POST" && actionMatch) {
    const id = safeContainerRef(decodeURIComponent(actionMatch[1]));
    const action = actionMatch[2];
    await docker([action, id], { timeout: action === "stop" ? 30000 : 20000 });
    json(res, 200, { ok: true, action, id });
    return;
  }

  const logsMatch = url.pathname.match(/^\/api\/containers\/([^/]+)\/logs$/);
  if (req.method === "GET" && logsMatch) {
    const id = safeContainerRef(decodeURIComponent(logsMatch[1]));
    const tail = Math.min(Math.max(Number(url.searchParams.get("tail") || 250), 20), 2000);
    const since = url.searchParams.get("since");
    const args = ["logs", "--timestamps", "--tail", String(tail)];
    if (since && /^[0-9]+[smhd]$/.test(since)) args.push("--since", since);
    args.push(id);
    const output = await dockerCombined(args, { timeout: 20000, maxBuffer: 1024 * 1024 * 16 });
    text(res, 200, output);
    return;
  }

  const inspectMatch = url.pathname.match(/^\/api\/containers\/([^/]+)\/inspect$/);
  if (req.method === "GET" && inspectMatch) {
    const id = safeContainerRef(decodeURIComponent(inspectMatch[1]));
    const output = await docker(["inspect", id], { timeout: 15000 });
    json(res, 200, JSON.parse(output)[0]);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/command") {
    const body = JSON.parse((await readRequestBody(req)) || "{}");
    const action = body.action;
    const allowed = new Set(["start", "stop", "restart"]);
    if (!allowed.has(action)) {
      throw Object.assign(new Error("Unsupported action"), { statusCode: 400 });
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(safeContainerRef) : [];
    if (!ids.length) {
      throw Object.assign(new Error("No containers selected"), { statusCode: 400 });
    }
    await docker([action, ...ids], { timeout: action === "stop" ? 45000 : 30000 });
    json(res, 200, { ok: true, action, ids });
    return;
  }

  json(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = normalize(join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    text(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    text(res, 200, body, mimeTypes[extname(filePath)] || "application/octet-stream");
  } catch {
    text(res, 404, "Not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message || "Unexpected error" });
  }
});

server.listen(port, host, () => {
  console.log(`Docker Manager UI listening on http://${host}:${port}`);
});
