import { isCustomStationeryOffered } from '../config/customStationery.js';
import type { StationeryFace, StationeryOrnament, StationeryTone } from '../render/stationery.js';
import type { SavedDesign } from '../services/stationeryDesignService.js';

/**
 * What the saved stationery design tools share (#649): their refusals, and a
 * design as their outputs say it.
 */

export type DesignRefusalCode =
  | 'DESIGNS_OFF'
  | 'DESIGN_NAME_INVALID'
  | 'DESIGN_CHOICE_INVALID'
  | 'DESIGN_LIMIT'
  | 'DESIGN_NOT_FOUND'
  | 'ACCOUNT_CLOSED'
  | 'CONFIRM_REQUIRED';

/** Refusals the model can act on. The code doubles as the log's class. */
export class DesignRefusedError extends Error {
  readonly diagnosticClass: string;

  constructor(readonly code: DesignRefusalCode, message: string) {
    super(message);
    this.name = 'DesignRefusedError';
    this.diagnosticClass = code;
  }
}

/**
 * The tools are listed only while designs are offered (src/server.ts), and
 * refuse while they are not: a tool list cached while they were offered still
 * reaches them.
 */
export function requireDesigns(): void {
  if (!isCustomStationeryOffered()) {
    throw new DesignRefusedError('DESIGNS_OFF', "Saved stationery designs aren't available here.");
  }
}

/** A design as the tools' outputs say it: its id, its name and its four choices, flat. */
export interface DesignOutput {
  designId: string;
  name: string;
  face: StationeryFace;
  ornament: StationeryOrnament;
  ruled: boolean;
  tone: StationeryTone;
}

export function designOutput(saved: SavedDesign): DesignOutput {
  return { designId: saved.designId, name: saved.name, ...saved.design };
}
