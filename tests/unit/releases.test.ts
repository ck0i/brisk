import { describe, expect, test } from "bun:test";

import { releaseTargetFor } from "../../src/cli/update-command.ts";
import {
  checkForUpdate,
  compareVersions,
  fetchLatestRelease,
  type ReleaseFetch,
} from "../../src/update/releases.ts";

function releaseResponse(
  version: string,
  assetUrl = "https://github.com/nickt/brisk/releases/download/v0.1.2/brisk-linux-x64.tar.gz",
): Response {
  return Response.json({
    tag_name: `v${version}`,
    html_url: `https://github.com/nickt/brisk/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "brisk-linux-x64.tar.gz",
        browser_download_url: assetUrl,
        size: 123,
      },
    ],
  });
}

function returning(response: Response): ReleaseFetch {
  return () => Promise.resolve(response);
}

describe("Brisk releases", () => {
  test("compares stable versions without number precision loss", () => {
    expect(compareVersions("0.1.2", "0.1.1")).toBe(1);
    expect(compareVersions("v2.0.0", "1.999.999")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.3.0")).toBe(-1);
    expect(compareVersions("1.2.90071992547409931234", "1.2.90071992547409931233")).toBe(1);
    expect(() => compareVersions("latest", "1.0.0")).toThrow("Invalid Brisk version");
  });

  test("validates the GitHub boundary and reports only newer releases", async () => {
    const update = await checkForUpdate("0.1.1", {
      fetch: returning(releaseResponse("0.1.2")),
    });
    expect(update).toMatchObject({ version: "0.1.2", tagName: "v0.1.2" });
    expect(update?.assets[0]).toEqual({
      name: "brisk-linux-x64.tar.gz",
      url: "https://github.com/nickt/brisk/releases/download/v0.1.2/brisk-linux-x64.tar.gz",
      size: 123,
    });

    expect(
      await checkForUpdate("0.1.2", { fetch: returning(releaseResponse("0.1.2")) }),
    ).toBeUndefined();
    await expect(
      fetchLatestRelease({
        fetch: returning(releaseResponse("0.1.2", "https://example.com/brisk.tar.gz")),
      }),
    ).rejects.toThrow("untrusted brisk-linux-x64.tar.gz download URL");
  });

  test("uses Brisk names for every published Bun compilation target", () => {
    expect(releaseTargetFor("linux", "x64")).toBe("brisk-linux-x64");
    expect(releaseTargetFor("linux", "arm64")).toBe("brisk-linux-arm64");
    expect(releaseTargetFor("darwin", "x64")).toBe("brisk-darwin-x64");
    expect(releaseTargetFor("darwin", "arm64")).toBe("brisk-darwin-arm64");
    expect(releaseTargetFor("win32", "x64")).toBe("brisk-windows-x64");
    expect(() => releaseTargetFor("win32", "arm64")).toThrow(
      "Brisk does not publish updates for win32-arm64",
    );
  });
});
