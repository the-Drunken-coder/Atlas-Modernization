#!/usr/bin/env node
import { runCLI } from "./cli-application.js";

process.exitCode = await runCLI(process.argv.slice(2));
