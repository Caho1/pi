import { stdin, stdout, stderr, env } from "node:process";

const workerId = env.MOCK_WORKER_ID ?? "worker";
let buffer = "";

stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) {
      void handleLine(line);
    }
    newlineIndex = buffer.indexOf("\n");
  }
});

async function handleLine(line) {
  try {
    const request = JSON.parse(line);
    if (request.method === "process") {
      const task = request.params.task;
      write({
        id: request.id,
        ok: true,
        result: {
          taskId: task.taskId,
          runId: `run-${workerId}-${task.taskId}`,
          specId: task.compiledSpec.specId,
          status: "succeeded",
          completion: {
            barrier: "settled-barrier",
            promptResolved: true,
            terminalEventSeen: true,
            noPendingBackgroundWork: true,
            finalizerPassed: true,
          },
          result: {
            submissionMode: "submit_result",
            structured: {
              workerId,
            },
          },
          artifacts: [],
          timestamps: {
            startedAt: "2026-04-14T02:31:00.000Z",
            finishedAt: "2026-04-14T02:31:01.000Z",
          },
        },
      });
      return;
    }

    if (request.method === "cancel") {
      write({
        id: request.id,
        ok: true,
        result: true,
      });
      return;
    }

    write({
      id: request.id,
      ok: false,
      error: {
        message: `Unknown method ${request.method}`,
      },
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  }
}

function write(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}
