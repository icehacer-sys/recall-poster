// Central run state, backed by config.stateFile (JSON, keyed by post slug). Tracks
// slide generation + publish so a restart never double-posts. Committed back by the runner.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import type { PostState } from "./types.js";

type StateData = Record<string, PostState>;

export class State {
  private data: StateData;

  constructor() {
    this.data = existsSync(config.stateFile)
      ? (JSON.parse(readFileSync(config.stateFile, "utf8")) as StateData)
      : {};
  }

  get(slug: string): PostState {
    return this.data[slug] ?? {};
  }

  set(slug: string, partial: Partial<PostState>): void {
    this.data[slug] = { ...this.get(slug), ...partial };
    this.save();
  }

  private save(): void {
    writeFileSync(config.stateFile, JSON.stringify(this.data, null, 2) + "\n");
  }
}
