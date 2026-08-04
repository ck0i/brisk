export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

export const BUILT_IN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "show keys and commands" },
  { name: "/model", description: "select a provider/model" },
  { name: "/login", description: "sign in to an OAuth provider" },
  { name: "/logout", description: "remove a local provider grant" },
  { name: "/new", description: "start a new session" },
  { name: "/sessions", description: "list or resume a session" },
  { name: "/resume", description: "resume a session" },
  { name: "/compact", description: "compact context" },
  { name: "/context", description: "inspect context usage" },
  { name: "/agents", description: "open child agents" },
  { name: "/reload", description: "reload configuration and extensions" },
  { name: "/cost", description: "show recorded cost" },
  { name: "/settings", description: "edit runtime settings" },
  { name: "/clear", description: "clear visible messages" },
  { name: "/quit", description: "exit Brisk" },
];
