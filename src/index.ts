const TaskQueue: typeof import("@goodware/task-queue") = require("@goodware/task-queue");

type Job = {
  id: number;
  customer: string;
  durationMs: number;
  shouldFail?: boolean;
};

type JobSummary = {
  id: number;
  customer: string;
  status: "completed" | "failed";
  detail: string;
  durationMs: number;
};

const COMPANY_NAMES = [
  "Acme Co",
  "Globex",
  "Initech",
  "Umbrella",
  "Stark Industries",
  "Wayne Enterprises",
  "Wonka Factory",
  "Hooli",
  "Vehement Capital",
  "Massive Dynamic",
] as const;

const jobs: Job[] = Array.from({ length: 60 }, (_, index) => {
  const id = 101 + index;
  const customer = COMPANY_NAMES[index % COMPANY_NAMES.length];
  const durationMs = 250 + ((index * 137) % 700);
  const shouldFail = id % 15 === 0;

  return {
    id,
    customer,
    durationMs,
    shouldFail,
  };
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MIN_BACKPRESSURE_WAIT_MS = 25;
const MAX_BACKPRESSURE_WAIT_MS = 125;
const DEFAULT_SIZE = 4;
const DEFAULT_WORKERS = 2;

type CliOptions = {
  size: number;
  workers: number;
};

function parsePositiveIntegerArg(name: "size" | "workers", value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid --${name} value "${value}". Expected a positive integer.`);
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name} value "${value}". Expected a positive integer.`);
  }

  return parsed;
}

function parseCliOptions(argv: string[]): CliOptions {
  let size = DEFAULT_SIZE;
  let workers = DEFAULT_WORKERS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--size") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("Missing value for --size");
      }

      size = parsePositiveIntegerArg("size", value);
      i += 1;
      continue;
    }

    if (arg === "--workers") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("Missing value for --workers");
      }

      workers = parsePositiveIntegerArg("workers", value);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm start -- [--size <number>] [--workers <number>]");
      console.log("Defaults: --size 4 --workers 2");
      process.exitCode = 0;
      throw new Error("__EXIT_AFTER_HELP__");
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { size, workers };
}

function getRandomBackpressureWaitMs(): number {
  return (
    Math.floor(Math.random() * (MAX_BACKPRESSURE_WAIT_MS - MIN_BACKPRESSURE_WAIT_MS + 1)) +
    MIN_BACKPRESSURE_WAIT_MS
  );
}

const jobDurationsMs = new Map<number, number>();
let backpressureWaitMs = 0;

let activeWorkers = 0;

const concurrencyTracker = {
  firstStartedAt: undefined as number | undefined,
  lastTransitionAt: undefined as number | undefined,
  lastFinishedAt: undefined as number | undefined,
  weightedConcurrencyMs: 0,
  maxConcurrency: 0,
};

function recordConcurrencyUntil(now: number): void {
  if (concurrencyTracker.lastTransitionAt !== undefined) {
    concurrencyTracker.weightedConcurrencyMs +=
      activeWorkers * (now - concurrencyTracker.lastTransitionAt);
  } else {
    concurrencyTracker.firstStartedAt = now;
  }

  concurrencyTracker.lastTransitionAt = now;
}

function workerStarted(now: number): void {
  recordConcurrencyUntil(now);
  activeWorkers += 1;
  concurrencyTracker.maxConcurrency = Math.max(
    concurrencyTracker.maxConcurrency,
    activeWorkers
  );
}

function workerFinished(now: number): void {
  recordConcurrencyUntil(now);
  activeWorkers -= 1;

  if (activeWorkers === 0) {
    concurrencyTracker.lastFinishedAt = now;
  }
}

function getAverageConcurrency(): number {
  const { firstStartedAt, lastFinishedAt, weightedConcurrencyMs } = concurrencyTracker;

  if (
    firstStartedAt === undefined ||
    lastFinishedAt === undefined ||
    lastFinishedAt <= firstStartedAt
  ) {
    return 0;
  }

  return weightedConcurrencyMs / (lastFinishedAt - firstStartedAt);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}m ${seconds}s`;
}

function printSummary(summaries: JobSummary[], totalRuntimeMs: number): void {
  console.log("\nSummary:");
  console.log(`Jobs processed: ${summaries.length}`);

  for (const summary of summaries) {
    console.log(
      `- job ${summary.id} (${summary.customer}): ${summary.durationMs}ms [${summary.status}]`
    );
  }

  console.log(`Maximum concurrency: ${concurrencyTracker.maxConcurrency}`);
  console.log(`Average concurrency: ${getAverageConcurrency().toFixed(2)}`);
  console.log(`Backpressure wait time: ${formatDuration(backpressureWaitMs)}`);
  console.log(`Total runtime: ${formatDuration(totalRuntimeMs)}`);
}

async function processJob(job: Job): Promise<string> {
  const startedAt = Date.now();
  workerStarted(startedAt);

  console.log(
    `[start] job ${job.id} for ${job.customer.padEnd(17)} | active workers: ${activeWorkers}`
  );

  try {
    await sleep(job.durationMs);

    if (job.shouldFail) {
      throw new Error("simulated downstream API failure");
    }

    const elapsedMs = Date.now() - startedAt;
    return `processed ${job.customer} in ${elapsedMs}ms`;
  } finally {
    const finishedAt = Date.now();
    jobDurationsMs.set(job.id, finishedAt - startedAt);
    workerFinished(finishedAt);
  }
}

async function run(): Promise<void> {
  const scriptStartedAt = Date.now();
  const { size, workers } = parseCliOptions(process.argv.slice(2));

  const queue = new TaskQueue({
    name: "customer-import-demo",
    size,
    workers,
  });

  const summaries: Promise<JobSummary>[] = [];
  let completed: JobSummary[] = [];

  console.log(`Queue created with size=${size} and workers=${workers}`);
  console.log("Submitting jobs with basic backpressure while the queue is full...\n");

  try {
    for (const job of jobs) {
      while (queue.full) {
        const waitMs = getRandomBackpressureWaitMs();
        console.log(`[wait ] queue full before job ${job.id}; pausing ${waitMs}ms`);
        await sleep(waitMs);
        backpressureWaitMs += waitMs;
      }

      const result = await queue.push(() => processJob(job));

      console.log(
        `[queue] job ${job.id} accepted | running count: ${queue.taskCount}`
      );

      summaries.push(
        result.promise
          .then(
            (detail): JobSummary => ({
              id: job.id,
              customer: job.customer,
              status: "completed",
              detail,
              durationMs: jobDurationsMs.get(job.id) ?? 0,
            })
          )
          .catch(
            (error: unknown): JobSummary => ({
              id: job.id,
              customer: job.customer,
              status: "failed",
              detail: error instanceof Error ? error.message : String(error),
              durationMs: jobDurationsMs.get(job.id) ?? 0,
            })
          )
      );
    }

    completed = await Promise.all(summaries);

    console.log("\nResults:");
    for (const summary of completed) {
      const label = summary.status === "completed" ? "done " : "fail ";
      console.log(
        `[${label}] job ${summary.id} for ${summary.customer.padEnd(17)} | ${summary.detail} | ${summary.durationMs}ms`
      );
    }
  } finally {
    console.log("\nStopping queue and waiting for in-flight work to finish...");
    await queue.stop();
    console.log("Queue stopped.");
  }

  printSummary(completed, Date.now() - scriptStartedAt);
}

void run().catch((error: unknown) => {
  if (error instanceof Error && error.message === "__EXIT_AFTER_HELP__") {
    return;
  }
  console.error("App failed:", error);
  process.exitCode = 1;
});
