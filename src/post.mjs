// After the job's steps, whether they passed or not: finish the run and
// report it (lib.mjs).
import { finish } from './lib.mjs';

process.exitCode = await finish(process.env);
