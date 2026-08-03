import { createInterface, type Interface } from "node:readline/promises";

import type { OAuthAuthInfo, OAuthPrompt } from "@oh-my-pi/pi-ai";

import type { AuthPrompter } from "../providers/auth-service.ts";

export interface TextTerminal {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export class TerminalAuthPrompter implements AuthPrompter {
  private readonly readline: Interface;

  constructor(
    private readonly terminal: TextTerminal = {
      input: process.stdin,
      output: process.stdout,
    },
  ) {
    this.readline = createInterface({
      input: terminal.input,
      output: terminal.output,
      terminal: Boolean(process.stdout.isTTY),
    });
  }

  openBrowser(info: OAuthAuthInfo): void {
    if (info.instructions) this.write(`${info.instructions}\n`);
    const target = info.launchUrl ?? info.url;
    const opened = launchBrowser(target);
    this.write(opened ? "Opening the authorization page in your browser.\n" : "Open this URL:\n");
    this.write(`${target}\n`);
  }

  async prompt(prompt: OAuthPrompt): Promise<string> {
    return await this.ask(prompt.message, {
      ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      allowEmpty: prompt.allowEmpty ?? false,
    });
  }

  async manualCode(): Promise<string> {
    return await this.ask("Paste the callback URL or authorization code", { allowEmpty: false });
  }

  progress(message: string): void {
    this.write(`${message}\n`);
  }

  async ask(
    message: string,
    options: { readonly placeholder?: string; readonly allowEmpty?: boolean } = {},
  ): Promise<string> {
    const suffix = options.placeholder ? ` (${options.placeholder})` : "";
    while (true) {
      const answer = (await this.readline.question(`${message}${suffix}: `)).trim();
      if (answer || options.allowEmpty === true) return answer;
      this.write("A value is required.\n");
    }
  }

  close(): void {
    this.readline.close();
  }

  private write(value: string): void {
    this.terminal.output.write(value);
  }
}

export function launchBrowser(url: string, platform = process.platform): boolean {
  const command = browserCommand(url, platform);
  if (!command) return false;
  try {
    const subprocess = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    subprocess.unref();
    return true;
  } catch {
    return false;
  }
}

export function browserCommand(url: string, platform: NodeJS.Platform): string[] | undefined {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") {
    return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
  }
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return ["xdg-open", url];
  }
  return undefined;
}
