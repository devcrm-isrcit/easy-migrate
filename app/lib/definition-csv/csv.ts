/**
 * Minimal RFC 4180 CSV reader/writer.
 *
 * Definition CSVs embed JSON in the `validations` column, so quoted fields
 * containing commas, double quotes and newlines have to round-trip exactly.
 * Kept dependency-free and isomorphic: the browser reads the uploaded file to
 * count rows before upload, the server parses the same text on import.
 */

const BOM = "﻿";

export function parseCsv(input: string): string[][] {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  function pushField() {
    row.push(field);
    field = "";
  }

  function pushRow() {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  }

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }

        inQuotes = false;
        index += 1;
        continue;
      }

      if (char === "\r" && text[index + 1] === "\n") {
        field += "\n";
        index += 2;
        continue;
      }

      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      pushField();
      index += 1;
      continue;
    }

    if (char === "\r") {
      index += 1;
      continue;
    }

    if (char === "\n") {
      pushRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== "" || row.length > 0) {
    pushRow();
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

function escapeField(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (text === "") {
    return "";
  }

  // Leading/trailing whitespace is quoted too: a definition name can legitimately
  // carry it, and unquoted it gets eaten by spreadsheet apps on the way back in.
  return /[",\r\n]|^\s|\s$/.test(text)
    ? `"${text.replace(/"/g, '""')}"`
    : text;
}

export function toCsv(
  rows: Array<Array<string | number | boolean | null | undefined>>,
): string {
  const body = rows.map((row) => row.map(escapeField).join(",")).join("\r\n");
  return `${BOM}${body}\r\n`;
}
