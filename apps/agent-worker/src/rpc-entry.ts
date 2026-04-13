import path from "node:path";

import {
  DefaultEventTranslator,
  DefaultPiExecutor,
  DefaultPiResourceAssembler,
  DefaultTaskProcessor,
  FileSystemArtifactStore,
  FileSystemTraceStore,
  FileSystemWorkspaceManager,
} from "./index.js";
import { runRpcTaskProcessorServer } from "./rpc-server.js";

const runtimeRoot = path.resolve(process.env.PI_RUNTIME_ROOT ?? "runtime");

const processor = new DefaultTaskProcessor(
  new FileSystemWorkspaceManager(runtimeRoot),
  new DefaultPiExecutor(
    new DefaultPiResourceAssembler(runtimeRoot),
    new DefaultEventTranslator(),
    new FileSystemTraceStore(runtimeRoot),
    new FileSystemArtifactStore(runtimeRoot),
  ),
);

runRpcTaskProcessorServer(processor);
