import { testRender } from "@opentui/solid";

import { Root } from "./root.tsx";
import { UiStore } from "./state.ts";

export async function benchmarkFirstDraw(): Promise<number> {
  const startedAt = performance.now();
  const store = new UiStore("benchmark");
  const setup = await testRender(
    () => (
      <Root
        store={store}
        onSubmit={() => true}
        onAbort={() => undefined}
        onExit={() => undefined}
      />
    ),
    { width: 100, height: 30 },
  );

  try {
    await setup.renderOnce();
    return performance.now() - startedAt;
  } finally {
    setup.renderer.destroy();
  }
}
