import fs from "fs";
import { parse } from "csv-parse/sync";

export function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function asString(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function isValidHttpUrl(s) {
  const v = asString(s);
  return /^https?:\/\/\S+/i.test(v);
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = asString(obj[k]);
      if (v) return v;
    }
  }
  return "";
}

export async function parseCsvToRows(csvText) {
  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
    trim: true
  });

  const rows = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];

    const citationSource = pickFirst(r, ["Citation Source"]);
    const citationSource1 = pickFirst(r, ["Citation Source 1"]);
    const url = isValidHttpUrl(citationSource)
      ? citationSource
      : isValidHttpUrl(citationSource1)
        ? citationSource1
        : "";

    const expected = {
      title: pickFirst(r, ["Title"]),
      author: pickFirst(r, ["Author"]),
      note: pickFirst(r, ["Note"]),
      journal_title: pickFirst(r, ["Journal Title"]),
      publisher: pickFirst(r, ["Publisher"]),
      issn: pickFirst(r, ["ISSN"]),
      isbn: pickFirst(r, ["ISBN"])
    };

    const meta = {
      row_number: i + 2,
      citation_id: pickFirst(r, ["Alma Citation ID", "Citation ID"]),
      reading_list_id: pickFirst(r, ["Alma Reading List ID", "Reading List ID"]),
      reading_list_name: pickFirst(r, ["Reading List Name", "List Name"]),
      course_code: pickFirst(r, ["Course Code", "Course"]),
      section: pickFirst(r, ["Section"]),
      citation_type: pickFirst(r, ["Citation Type", "Type"])
    };

    rows.push({ url, expected, meta });
  }

  return rows;
}
