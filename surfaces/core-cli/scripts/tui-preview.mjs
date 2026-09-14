#!/usr/bin/env node
import { createInteractiveCLI } from "../dist/terminal-ui.js";
import { createPreviewOperator, isPreviewState } from "../dist/tui-preview-operator.js";

const stateArgument = process.argv.indexOf("--state");
const initialState = stateArgument >= 0 ? process.argv[stateArgument + 1] : "ready";
if (!isPreviewState(initialState)) {
  process.stderr.write(`Unknown preview state: ${initialState ?? ""}\n`);
  process.exitCode = 2;
} else {
  try {
    await createInteractiveCLI().runMenu(createPreviewOperator(initialState));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
