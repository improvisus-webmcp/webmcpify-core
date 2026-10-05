import { stripVTControlCharacters } from "node:util";

type OutputStream = Pick<NodeJS.WriteStream, "isTTY" | "write"> & { columns?: number };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const progressClearers = new Set<() => void>();

/** Progress owns one transient line; clear it before writing permanent output. */
export function registerProgressClearer(clear: () => void): () => void {
  progressClearers.add(clear);
  return () => { progressClearers.delete(clear); };
}
export function clearCliProgress(): void { for (const clear of progressClearers) clear(); }

function plain(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function glyphWidth(value: string): number {
  if (/^\p{Mark}+$/u.test(value)) return 0;
  const code = value.codePointAt(0) ?? 0;
  return /\p{Emoji_Presentation}|\p{Regional_Indicator}|\uFE0F/u.test(value)
    || (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe6f)
      || (code >= 0xff01 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x20000 && code <= 0x3fffd))) ? 2 : 1;
}

export function textWidth(value: string): number {
  return [...graphemes.segment(stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ""))]
    .reduce((sum, entry) => sum + glyphWidth(entry.segment), 0);
}

export function terminalWidth(stream: { columns?: number } = process.stdout): number {
  // Leave the final terminal column empty to avoid automatic line wrapping.
  return Math.max(1, Math.min(100, Number.isFinite(stream.columns) ? Math.floor(stream.columns!) - 1 : 99));
}

/** Wrap words and long IDs/paths without cutting a grapheme or emitting controls. */
export function wrapText(value: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const result: string[] = [];
  let line = "";
  let size = 0;
  for (const word of plain(value).split(" ")) {
    if (!word) continue;
    if (line && size + 1 + textWidth(word) <= limit) {
      line += " " + word;
      size += 1 + textWidth(word);
      continue;
    }
    if (line) { result.push(line); line = ""; size = 0; }
    for (const { segment } of graphemes.segment(word)) {
      const part = glyphWidth(segment);
      if (size + part > limit && line) { result.push(line); line = ""; size = 0; }
      // A two-column glyph cannot fit a one-column terminal.
      const fitted = part > limit ? "?" : segment;
      line += fitted;
      size += part > limit ? 1 : part;
    }
  }
  if (line || !result.length) result.push(line);
  return result;
}

function padded(value: string, width: number): string {
  // Do not trim padding before measuring it.
  const size = [...graphemes.segment(value)].reduce((sum, entry) => sum + glyphWidth(entry.segment), 0);
  return value + " ".repeat(Math.max(0, width - size));
}

export function renderBox(title: string, lines: string[], width = terminalWidth()): string {
  if (width < 12) return [title, ...lines].flatMap(line => wrapText(line, width)).join("\n");
  const inner = width - 4;
  const border = "+" + "-".repeat(width - 2) + "+";
  const row = (value: string) => wrapText(value, inner).map(line => "| " + padded(line, inner) + " |");
  return [border, ...row(title), border, ...lines.flatMap(row), border].join("\n");
}

export function renderTable(headers: string[], rows: string[][], width = terminalWidth()): string {
  if (!headers.length) return "";
  const available = width - headers.length * 3 - 1;
  if (available < headers.length * 5) {
    return rows.map(row => renderBox("Result", headers.map((header, index) => `${header}: ${row[index] ?? ""}`), width)).join("\n");
  }
  const widths = headers.map(header => Math.max(3, Math.min(44, textWidth(header))));
  for (let index = 0; index < headers.length; index++) {
    for (const row of rows) widths[index] = Math.max(widths[index], Math.min(44, textWidth(row[index] ?? "")));
  }
  while (widths.reduce((sum, size) => sum + size, 0) > available) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest]--;
  }
  const border = "+" + widths.map(size => "-".repeat(size + 2)).join("+") + "+";
  const format = (values: string[]) => {
    const cells = headers.map((_, index) => wrapText(values[index] ?? "", widths[index]));
    return Array.from({ length: Math.max(...cells.map(cell => cell.length)) }, (_, line) =>
      "| " + cells.map((cell, index) => padded(cell[line] ?? "", widths[index])).join(" | ") + " |");
  };
  return [border, ...format(headers), border, ...rows.flatMap(row => [...format(row), border])].join("\n");
}

export function printCliBlock(value: string): void {
  clearCliProgress();
  console.log(value);
}

export function printCliLine(scope: string, message: string, stream?: OutputStream): void {
  clearCliProgress();
  const output = wrapText(`[${scope}] ${message}`, terminalWidth(stream ?? process.stdout)).join("\n");
  if (stream) stream.write(output + "\n");
  else console.log(output);
}

export function traceCliLine(scope: string, message: string): void {
  if (process.env.WEBMCPIFY_TRACE === "1") printCliLine(scope, message);
}

export function printStage(scope: string, label: string): void {
  printCliBlock("\n" + renderBox(scope.toUpperCase(), [label]));
}

export function printWorkflowBanner(command: "run" | "final-eval", options: { baseline?: boolean; durable?: boolean; resume?: boolean } = {}): void {
  const steps = [
    "This can take a while. AI generation, build checks and each browser task take time; human review waits for your decision.",
    "1. Discover source-backed actions, prerequisites and existing capabilities.",
    "2. Generate WebMCP tools, status/styles and agent context using WebMCP protocol guidance.",
    "3. Prepare agent and crawler guidance: AGENTS.md, capability docs, llms.txt and scoped robots metadata. Indexing depends on deployment and the crawler.",
    "4. Generate browser tasks, including success and expected-rejection cases.",
    "5. Validate contracts, build and wiring; check security and surface findings.",
    "6. Human review: accept/reject tools and the source patch. Removing tools may revise the draft and generate additional tasks for another review.",
    ...(options.baseline ? ["7. Run the optional UI-only baseline before applying changes."] : []),
    `${options.baseline ? 8 : 7}. Apply only the exact approved patch and check the build.`,
    `${options.baseline ? 9 : 8}. A real AI agent tests each task in isolated Chrome using WebMCP calls. Core independently checks recorded calls and live postconditions.`,
    ...(command === "final-eval" ? ["Advanced evaluation includes repair if needed (with review), Temporal evaluation and final-source checks. Temporal packages and a running service are required."] : []),
    ...(options.durable ? ["Durable mode uses a Temporal worker and saved checkpoints."] : []),
    ...(options.resume ? ["Resuming an existing run reuses its checkpoints; completed stages are not repeated."] : []),
    "Finally: save evidence and display the evaluation table. UI clicks are used only for the optional baseline comparison.",
  ];
  printCliBlock("\n" + renderBox(`WEBMCPIFY | ${command.toUpperCase()}`, steps) + "\n");
}
