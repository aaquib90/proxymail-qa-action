// Before the job's steps: start the run (lib.mjs).
import { start } from './lib.mjs';

await start(process.env);
