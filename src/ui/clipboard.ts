import { Buffer } from "node:buffer";

import type { ImageContent } from "../core/messages.ts";

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CLIPBOARD_TEXT_BYTES = 10 * 1024 * 1024;

export type ClipboardPaste = ImageContent | { readonly type: "text"; readonly text: string };

interface NativeClipboardImage {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

export interface ClipboardCommandOptions {
  readonly platform?: NodeJS.Platform;
  readonly which?: (command: string) => string | null;
}

export interface ClipboardReadOptions extends ClipboardCommandOptions {
  readonly readImage?: () => Promise<NativeClipboardImage | null | undefined>;
  readonly run?: (command: readonly string[]) => Promise<Uint8Array | undefined>;
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

export function clipboardReadCommand(
  options: ClipboardCommandOptions = {},
): readonly string[] | undefined {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? Bun.which;
  if (platform === "darwin") return which("pbpaste") ? ["pbpaste"] : undefined;
  if (platform === "win32") {
    const powershell = which("powershell.exe") ?? which("powershell");
    return powershell
      ? [powershell, "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]
      : undefined;
  }
  const wayland = which("wl-paste");
  if (wayland) return [wayland, "--no-newline"];
  const xclip = which("xclip");
  if (xclip) return [xclip, "-selection", "clipboard", "-o"];
  const xsel = which("xsel");
  return xsel ? [xsel, "--clipboard", "--output"] : undefined;
}

/** Read an image first, then plain text, without loading native bindings until paste is used. */
export async function readSystemClipboard(
  options: ClipboardReadOptions = {},
): Promise<ClipboardPaste | undefined> {
  const readImage =
    options.readImage ??
    (async () => {
      const native = await import("@oh-my-pi/pi-natives/clipboard");
      return await native.readImageFromClipboard();
    });
  let image: NativeClipboardImage | null | undefined;
  try {
    image = await readImage();
  } catch {
    // Native clipboard access is optional; text helpers remain a useful fallback.
  }
  if (image) return imagePaste(image);

  const command = clipboardReadCommand(options);
  if (!command) return undefined;
  const bytes = await (options.run ?? runClipboardRead)(command);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_CLIPBOARD_TEXT_BYTES) return undefined;
  const text = new TextDecoder().decode(bytes);
  return text.length === 0 ? undefined : { type: "text", text };
}

function imagePaste(image: NativeClipboardImage): ImageContent {
  if (!(image.data instanceof Uint8Array) || image.data.length === 0) {
    throw new Error("Clipboard returned an empty image.");
  }
  if (image.data.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error("Clipboard image is larger than Brisk's 20 MiB attachment limit.");
  }
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Clipboard returned an invalid image type: ${mimeType || "unknown"}.`);
  }
  return {
    type: "image",
    data: Buffer.from(image.data).toString("base64"),
    mimeType,
  };
}

async function runClipboardRead(command: readonly string[]): Promise<Uint8Array | undefined> {
  try {
    const child = Bun.spawn([...command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    return (await child.exited) === 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
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
