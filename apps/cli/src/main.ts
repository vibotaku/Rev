import { CommanderError } from "commander";
import { buildProgram } from "./program";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  if (!(err instanceof CommanderError)) process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
}
