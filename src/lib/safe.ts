// Rules for text that comes from outside cn: the network, config files, other tools' files.

// C0/C1 controls (terminal escapes) and invisible bidi/zero-width characters.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

// Model IDs are passed to tools as option values, so they must not look like a flag.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

// Keys go into HTTP headers and child environments: printable ASCII, no spaces.
const API_KEY = /^[\x21-\x7e]{1,1024}$/;

export function cleanText(value: unknown, max = 120) {
  const text = String(value).replace(UNSAFE_TEXT, "").trim();
  return [...text].slice(0, max).join("");
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

export function isApiKey(value: unknown): value is string {
  return typeof value === "string" && API_KEY.test(value);
}
