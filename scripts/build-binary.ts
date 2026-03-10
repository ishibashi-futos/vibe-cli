import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const cliEntrypoint = "./src/cli/index.ts";
const forwardedArgs = process.argv.slice(2);

function includesFlag(flag: string): boolean {
  return forwardedArgs.some(
    (arg, index) =>
      arg === flag ||
      arg.startsWith(`${flag}=`) ||
      (index > 0 && forwardedArgs[index - 1] === flag),
  );
}

const hasOutfile = includesFlag("--outfile");
const hasOutdir = includesFlag("--outdir");
const outfile = hasOutfile || hasOutdir ? undefined : "dist/vibe-cli";

if (outfile) {
  await mkdir(dirname(outfile), { recursive: true });
}

const command = ["bun", "build", "--compile", cliEntrypoint, ...forwardedArgs];

if (outfile) {
  command.push("--outfile", outfile);
}

const proc = Bun.spawn(command, {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

const exitCode = await proc.exited;
process.exit(exitCode);
