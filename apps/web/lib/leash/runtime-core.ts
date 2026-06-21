import { join } from "node:path";

export interface HelperScriptCopy {
  from: string;
  to: string;
  recursive: boolean;
}

export interface HelperScriptLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  copies: HelperScriptCopy[];
}

export interface BuildHelperScriptLaunchOptions {
  rootDir: string;
  runtimeSourceDir: string | null;
  runtimeDir: string | null;
  nodeBin: string;
  scriptName: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

function helperScriptsDir(rootDir: string, runtimeSourceDir: string | null): string {
  return runtimeSourceDir ? join(runtimeSourceDir, "apps", "web", "scripts") : join(rootDir, "apps", "web", "scripts");
}

function brainPackageDir(rootDir: string, runtimeSourceDir: string | null): string {
  return runtimeSourceDir ? join(runtimeSourceDir, "packages", "brain") : join(rootDir, "packages", "brain");
}

export function buildHelperScriptLaunch({
  rootDir,
  runtimeSourceDir,
  runtimeDir,
  nodeBin,
  scriptName,
  args = [],
  env = process.env,
}: BuildHelperScriptLaunchOptions): HelperScriptLaunch {
  if (runtimeDir) {
    return {
      command: nodeBin,
      args: [
        "--import",
        join(runtimeDir, "node_modules", "tsx", "dist", "esm", "index.mjs"),
        join(runtimeDir, ".leash-scripts", scriptName),
        ...args,
      ],
      cwd: runtimeDir,
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      copies: [
        {
          from: join(helperScriptsDir(rootDir, runtimeSourceDir), scriptName),
          to: join(runtimeDir, ".leash-scripts", scriptName),
          recursive: false,
        },
        {
          from: brainPackageDir(rootDir, runtimeSourceDir),
          to: join(runtimeDir, "node_modules", "@mycelium", "brain"),
          recursive: true,
        },
      ],
    };
  }

  return {
    command: nodeBin,
    args: ["--import", "tsx/esm", join(helperScriptsDir(rootDir, runtimeSourceDir), scriptName), ...args],
    cwd: rootDir,
    env: { ...env },
    copies: [],
  };
}
