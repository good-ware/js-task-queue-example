# Task Queue TypeScript Example

This app demonstrates how to use [`@goodware/task-queue`](https://www.npmjs.com/package/@goodware/task-queue) from TypeScript to:

- limit concurrency with `workers`
- cap queued work with `size`
- apply simple backpressure with `queue.full`
- wait for task completion through the `promise` returned by `push()`

It runs directly on Node 24+ using Node's built-in TypeScript support, so there is no extra TypeScript runtime dependency in this example.

## Run it

```bash
npm start
```

Override backfill queue size and max concurrency:

```bash
npm start -- --size 20 --workers 5
```

For auto-reload while iterating:

```bash
npm run dev
```

CLI flags:

- `--size <number>`: maximum queue size used for backfill pressure control (default: `4`)
- `--workers <number>`: maximum concurrent workers (default: `2`)
- `--help`: show usage

## What it does

The example simulates importing **60 customer jobs**. It uses:

- configurable `workers` so only that many jobs execute at the same time
- configurable `size` so only that many jobs are in-flight (running/queued in the queue)
- basic backpressure with `queue.full` before submitting more work
- periodic failures (`jobId % 15 === 0`) to demonstrate per-job error handling

At the end of each run, it prints:

- total jobs processed
- each job's elapsed time in milliseconds
- maximum concurrency observed
- average (time-weighted) concurrency
- total backpressure wait time
- total runtime for the full script
