import type { CliCommand } from "./args.ts";
import { ensureConfigDirectories, type ConfigPaths } from "../config/paths.ts";
import { SessionIndex } from "../sessions/session-index.ts";

export async function runSessionsCommand(
  command: Extract<CliCommand, { readonly name: "sessions" }>,
  paths: ConfigPaths,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  await ensureConfigDirectories(paths);
  const index = new SessionIndex({
    sessionsDir: paths.sessionsDir,
    sessionIndexPath: paths.sessionIndexPath,
  });
  const sessions = await index.list();
  if (command.json) {
    output.write(`${JSON.stringify(sessions)}\n`);
    return;
  }
  if (sessions.length === 0) {
    output.write("No Brisk sessions found.\n");
    return;
  }
  for (const session of sessions) {
    output.write(
      `${session.id}  ${session.updatedAt.slice(0, 16).replace("T", " ")}  ${session.selectedProvider}/${session.selectedModel}  ${session.title}\n  ${session.workspace}\n`,
    );
  }
}
