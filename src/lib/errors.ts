export class CnError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CnError";
    this.exitCode = exitCode;
  }
}

export const EXIT = Object.freeze({ FAILURE: 1, USAGE: 2, NOT_FOUND: 127 });
