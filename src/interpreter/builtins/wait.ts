/**
 * wait builtin - wait for background jobs to complete.
 *
 * Usage:
 *   wait        - Wait for all background jobs
 *   wait PID    - Wait for specific PID
 *   wait %N     - Wait for job number N
 *   wait -n     - Wait for any one job to complete
 */

import type { ExecResult } from "../../types.js";
import { failure, OK, result } from "../helpers/result.js";
import type { InterpreterContext, Job } from "../types.js";

export async function handleWait(
  ctx: InterpreterContext,
  args: string[],
): Promise<ExecResult> {
  const jobTable = ctx.state.jobTable;

  // Parse -n flag
  let waitAny = false;
  const pids: number[] = [];
  const jobSpecs: number[] = [];

  for (const arg of args) {
    if (arg === "-n") {
      waitAny = true;
    } else if (arg.startsWith("%")) {
      const jobNum = Number.parseInt(arg.slice(1), 10);
      if (Number.isNaN(jobNum)) {
        return failure(`bash: wait: \`${arg}': not a valid identifier\n`);
      }
      jobSpecs.push(jobNum);
    } else {
      const pid = Number.parseInt(arg, 10);
      if (Number.isNaN(pid)) {
        return failure(`bash: wait: \`${arg}': not a valid identifier\n`);
      }
      pids.push(pid);
    }
  }

  // No job table — if specific PIDs/jobs were requested, that's an error
  if (!jobTable || jobTable.size === 0) {
    if (pids.length > 0) {
      return failure(
        `bash: wait: pid ${pids[0]} is not a child of this shell\n`,
        127,
      );
    }
    if (jobSpecs.length > 0) {
      return failure(`bash: wait: %${jobSpecs[0]}: no such job\n`, 127);
    }
    return OK;
  }

  // Collect jobs to wait for
  let jobsToWait: Job[];

  if (pids.length > 0 || jobSpecs.length > 0) {
    // Wait for specific jobs
    jobsToWait = [];
    for (const pid of pids) {
      const job = findJobByPid(jobTable, pid);
      if (job) {
        jobsToWait.push(job);
      } else {
        return failure(
          `bash: wait: pid ${pid} is not a child of this shell\n`,
          127,
        );
      }
    }
    for (const jobNum of jobSpecs) {
      const job = jobTable.get(jobNum);
      if (job) {
        jobsToWait.push(job);
      } else {
        return failure(`bash: wait: %${jobNum}: no such job\n`, 127);
      }
    }
  } else if (waitAny) {
    // Wait for any one running job
    const running = [...jobTable.values()].filter(
      (j) => j.status === "Running",
    );
    if (running.length === 0) {
      return OK;
    }
    // Race all running job promises
    const winner = await Promise.race(
      running.map((j) => j.promise.then(() => j)),
    );
    return collectJobOutput(winner, jobTable);
  } else {
    // Wait for all jobs
    // bash: "If ID is not given, the return status is zero."
    const running = [...jobTable.values()].filter(
      (j) => j.status === "Running",
    );
    if (running.length > 0) {
      await Promise.all(running.map((j) => j.promise));
    }
    // Collect output from completed jobs but leave cleanup/notifications
    // to drainCompletedJobs (runs at the start of the next statement)
    let stdout = "";
    let stderr = "";
    for (const [, job] of jobTable) {
      stdout += job.stdout;
      stderr += job.stderr;
      job.stdout = "";
      job.stderr = "";
    }
    return result(stdout, stderr, 0);
  }

  if (jobsToWait.length === 0) {
    return OK;
  }

  // Separate already-finished jobs from running ones
  const stillRunning = jobsToWait.filter((j) => j.status === "Running");
  if (stillRunning.length > 0) {
    await Promise.all(stillRunning.map((j) => j.promise));
  }

  // Return the exit code of the last job waited for
  const lastJob = jobsToWait[jobsToWait.length - 1];
  return collectJobOutput(lastJob, jobTable);
}

function findJobByPid(
  jobTable: Map<number, Job>,
  pid: number,
): Job | undefined {
  for (const [, job] of jobTable) {
    if (job.pid === pid) return job;
  }
  return undefined;
}

function collectJobOutput(job: Job, jobTable: Map<number, Job>): ExecResult {
  let stdout = "";
  let stderr = "";

  // Collect output from the completed job
  stdout += job.stdout;
  stderr += job.stderr;
  job.stdout = "";
  job.stderr = "";
  job.notified = true;

  // Clean up completed job
  if (job.status !== "Running") {
    jobTable.delete(job.jobId);
  }

  return result(stdout, stderr, job.exitCode);
}
