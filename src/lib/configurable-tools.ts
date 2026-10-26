import { getHarness, isHarness, listHarnesses } from "./harnesses/registry.js";
import type { ConfigurableToolId } from "./types.js";

export const configurableTool = (id: ConfigurableToolId) =>
  id === "cursor" ? ({ id, label: "Cursor desktop" } as const) : getHarness(id);
export const listConfigurableTools = () => [
  ...listHarnesses(),
  configurableTool("cursor"),
];
export const isConfigurableTool = (id: string): id is ConfigurableToolId =>
  id === "cursor" || isHarness(id);
