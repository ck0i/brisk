export interface ClipboardCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly which?: (command: string) => string | null;
}

export function clipboardCommand(
  options: ClipboardCommandOptions = {},
): readonly string[] | undefined {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? Bun.which;
  if (platform === "darwin") return which("pbcopy") ? ["pbcopy"] : undefined;
  if (platform === "win32") {
    const clip = which("clip.exe") ?? which("clip");
    return clip ? [clip] : undefined;
  }
  const wayland = which("wl-copy");
  if (wayland) return [wayland];
  const xclip = which("xclip");
  if (xclip) return [xclip, "-selection", "clipboard"];
  const xsel = which("xsel");
  return xsel ? [xsel, "--clipboard", "--input"] : undefined;
}

export async function copyTextToSystemClipboard(
  text: string,
  options: ClipboardCommandOptions = {},
): Promise<boolean> {
  const command = clipboardCommand(options);
  if (!command) return false;
  try {
    const child = Bun.spawn([...command], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    child.stdin.write(text);
    child.stdin.end();
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
