import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core";

type MouseCapturingRenderer = {
  setCapturedRenderable?: (renderable: unknown) => void;
};

/**
 * OpenTUI only captures a mouse target on the first drag event. The scrollbar
 * thumb is one cell wide, so a vertical drag that drifts off the track loses
 * the gesture immediately. Capture the slider on mousedown instead.
 */
export function captureScrollbarDrags(scrollbox: ScrollBoxRenderable, renderer: CliRenderer): void {
  const capture = (renderer as unknown as MouseCapturingRenderer).setCapturedRenderable;
  if (typeof capture !== "function") return;
  for (const slider of [scrollbox.verticalScrollBar.slider, scrollbox.horizontalScrollBar.slider]) {
    slider.onMouse = (event) => {
      if (event.type !== "down" || event.button !== 0) return;
      capture.call(renderer, slider);
    };
  }
}
