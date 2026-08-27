import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { LeboncoinAd, LeboncoinSearchParams } from "./types";

const FUEL_MAP: Record<string, string> = {
  "hybride rechargeable": "8",
  "hybrid rechargeable": "8",
  phev: "8",
  essence: "1",
  petrol: "1",
  diesel: "2",
  gpl: "3",
  lpg: "3",
  electrique: "4",
  électrique: "4",
  electric: "4",
  hybride: "6",
  hybrid: "6",
};

const GEARBOX_MAP: Record<string, string> = {
  manuelle: "1",
  manual: "1",
  automatique: "2",
  automatic: "2",
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(moduleDirectory, "../../..");
const workerScript = join(projectRoot, "python/lbc_worker.py");

let cachedPythonPath: string | undefined;

function getPythonPath(): string {
  if (cachedPythonPath) return cachedPythonPath;

  const candidates = [
    process.env.LBC_PYTHON_PATH,
    join(projectRoot, ".venv/bin/python"),
    join(projectRoot, ".venv/Scripts/python.exe"),
    "/opt/homebrew/bin/python3.11",
    "/usr/local/bin/python3.11",
    "python3.11",
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "python3",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    try {
      execFileSync(
        candidate,
        [
          "-c",
          "from importlib.metadata import version; assert tuple(map(int, version('lbc').split('.'))) >= (1, 1, 5)",
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      cachedPythonPath = candidate;
      console.error(`[LBC] Python worker uses ${candidate}`);
      return candidate;
    } catch {
      // Try the next Python installation.
    }
  }

  throw new Error(
    "Python with lbc>=1.1.5 was not found. Create .venv and install requirements.txt.",
  );
}

type WorkerSuccess = {
  id: number;
  ok: true;
  ads: LeboncoinAd[];
};

type WorkerFailure = {
  id: number;
  ok: false;
  error: {
    type: string;
    message: string;
  };
};

type WorkerResponse = WorkerSuccess | WorkerFailure;

type PendingRequest = {
  resolve: (ads: LeboncoinAd[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

let workerProcess: ChildProcessWithoutNullStreams | undefined;
let workerReader: Interface | undefined;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function rejectPendingRequests(error: Error): void {
  for (const request of pendingRequests.values()) {
    clearTimeout(request.timeout);
    request.reject(error);
  }
  pendingRequests.clear();
}

function clearWorker(
  processToClear: ChildProcessWithoutNullStreams,
  error: Error,
): void {
  if (workerProcess !== processToClear) return;
  workerReader?.close();
  workerReader = undefined;
  workerProcess = undefined;
  rejectPendingRequests(error);
}

function handleWorkerLine(line: string): void {
  let response: WorkerResponse;
  try {
    response = JSON.parse(line) as WorkerResponse;
  } catch {
    console.error(`[LBC Python] Invalid worker response: ${line.slice(0, 300)}`);
    return;
  }

  const pending = pendingRequests.get(response.id);
  if (!pending) return;
  pendingRequests.delete(response.id);
  clearTimeout(pending.timeout);

  if (response.ok) {
    pending.resolve(response.ads);
    return;
  }

  pending.reject(
    new Error(`${response.error.type}: ${response.error.message}`),
  );
}

function startWorker(): ChildProcessWithoutNullStreams {
  if (workerProcess && !workerProcess.killed) return workerProcess;
  if (!existsSync(workerScript)) {
    throw new Error(`Python worker not found at ${workerScript}`);
  }

  const python = getPythonPath();
  const child = spawn(python, [workerScript], {
    cwd: projectRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  workerProcess = child;
  workerReader = createInterface({ input: child.stdout });
  workerReader.on("line", handleWorkerLine);
  child.stderr.on("data", (chunk: Buffer) => {
    const message = chunk.toString("utf8").trim();
    if (message) console.error(`[LBC Python] ${message}`);
  });
  child.once("error", (error) => clearWorker(child, error));
  child.once("exit", (code, signal) => {
    clearWorker(
      child,
      new Error(
        `Python worker stopped unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      ),
    );
  });
  return child;
}

export function fuelToLbcCode(fuel: string): string | undefined {
  const lower = fuel.toLowerCase();
  if (FUEL_MAP[lower]) return FUEL_MAP[lower];
  for (const [key, code] of Object.entries(FUEL_MAP)) {
    if (lower.includes(key)) return code;
  }
  return undefined;
}

export function gearboxToLbcCode(gearbox: string): string | undefined {
  const lower = gearbox.toLowerCase();
  if (GEARBOX_MAP[lower]) return GEARBOX_MAP[lower];
  if (lower.includes("manuelle") || lower.includes("manual")) return "1";
  if (lower.includes("automatique") || lower.includes("auto")) return "2";
  return undefined;
}

export function normalizeModel(model: string): string {
  const beforeVersion = model.split(/\s+\d+\.\d+/)[0]!.trim();
  if (beforeVersion && beforeVersion !== model) return beforeVersion;
  return model.split(/\s+/)[0] ?? model;
}

export function searchLeboncoinViaPython(
  params: LeboncoinSearchParams,
): Promise<LeboncoinAd[]> {
  const child = startWorker();
  const requestId = nextRequestId;
  nextRequestId += 1;
  const timeoutMs = Math.max(
    10_000,
    Number(process.env.LBC_WORKER_TIMEOUT_MS ?? 90_000),
  );
  const maxPages = Math.min(
    5,
    Math.max(1, params.maxPages ?? Number(process.env.LBC_MAX_PAGES ?? 3)),
  );

  return new Promise<LeboncoinAd[]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Python Leboncoin request timed out after ${timeoutMs} ms.`));
      child.kill();
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeout });
    const request = JSON.stringify({
      id: requestId,
      params: {
        ...params,
        maxPages,
      },
    });
    child.stdin.write(`${request}\n`, (error) => {
      if (!error) return;
      const pending = pendingRequests.get(requestId);
      if (!pending) return;
      pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
  });
}

export function stopLeboncoinPythonWorker(): void {
  const child = workerProcess;
  if (!child) return;
  workerProcess = undefined;
  workerReader?.close();
  workerReader = undefined;
  rejectPendingRequests(new Error("Python worker stopped."));
  child.kill();
}
