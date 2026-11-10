#!/usr/bin/env node
// @ts-check
import { main } from "../src/main.js";

main(process.argv.slice(2), { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`${e?.stack ?? e}\n`);
    process.exitCode = 1;
  },
);
