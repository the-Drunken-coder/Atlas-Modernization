#!/usr/bin/env node
import { runCLI } from "./application.js";

void runCLI(process.argv.slice(2)).then((status) => {
  process.exitCode = status;
});
